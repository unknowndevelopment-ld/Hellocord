/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { showToast, UserSettingsActionCreators } from "@webpack/common";

type Category = { id: string; name: string };
type CategoryData = {
    categories: Category[];
    assignments: Record<string, string[]>;
    /** Keys per category, newest addition first, so new GIFs appear on top. */
    order: Record<string, string[]>;
    /** Local send count and last-used time for the dynamic Most Used view. */
    usage: Record<string, { count: number; lastUsed: number; }>;
};
type FavoriteItem = { key: string; src: string; format: number; width: number; height: number; order: number };
type DuplicateItem = FavoriteItem & { rawKey: string; duplicateRole: "Keep" | "Duplicate"; };

// Discord hashes its class names per build, so keep the old explicit class as
// a fallback and otherwise identify result cards by structure (role=button
// containing media plus a favorite control).
const LEGACY_PICKER_CARD = ".result__2dc39";
const PICKER_CARD_PATTERN = '[class*="result_"], [role="button"], [role="gridcell"]';
const FAVORITE_BUTTON = '[aria-label="Remove from Favorites"], [aria-label="Add to Favorites"]';
const DOWNLOAD_BUTTON = '[aria-label="Download GIF"]';
const CATEGORY_VIEW_MARK = "[data-fav-gif-category-view]";
const HEADER_MARK = "[data-fav-gif-category-bar]";
const FOLDER_ICON = "<svg aria-hidden=\"true\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M10 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H12l-2-2Z\"/></svg>";
const MOST_USED_CATEGORY = "__most-used__";
const DUPLICATES_CATEGORY = "__duplicates__";
export type GifCategoryFeature = "mostUsed" | "duplicateFinder" | "categorySearch" | "randomButton";
const enabledFeatures = new Set<GifCategoryFeature>();
const BACKUP_FORMAT = "EquicordGifCategories";
// Shared bundle key: this hides backup contents from casual inspection, but is
// intentionally portable and is not a security boundary against plugin readers.
const BACKUP_KEY_MATERIAL = "Equicord-GIF-Categories-Portable-Backup-v1";
type BackupGif = { key: string; src: string; format: number; width: number; height: number; categories: string[] };
type CategoryBackup = { version: 1; exportedAt: string; categories: Category[]; gifs: BackupGif[] };

let observer: MutationObserver | null = null;
let selectedCategory: string | null = null;
let currentMenu: HTMLElement | null = null;
let currentDialog: HTMLElement | null = null;
let scanTimer: number | null = null;
let draggingCategory = false;
let draggedCategoryId: string | null = null;
let suppressCategoryClick = false;
let categoryActivationInProgress = false;
let nativeGifSelector: ((gif: { url: string; [key: string]: any; }) => void) | null = null;
let categoryQuery = "";
let clearingFavoriteSearch = false;
let duplicateGroups: DuplicateItem[][] = [];

export function setGifCategoryFeature(feature: GifCategoryFeature, enabled: boolean) {
    if (enabled) enabledFeatures.add(feature);
    else enabledFeatures.delete(feature);
    if (feature === "mostUsed" && !enabled && selectedCategory === MOST_USED_CATEGORY) selectedCategory = null;
    if (feature === "duplicateFinder" && !enabled) {
        duplicateGroups = [];
        if (selectedCategory === DUPLICATES_CATEGORY) selectedCategory = null;
    }
    if (feature === "categorySearch" && !enabled) categoryQuery = "";
    scheduleScan();
}

function hasFeature(feature: GifCategoryFeature) {
    return enabledFeatures.has(feature);
}

function favoriteSearchInputs(root: ParentNode = document): HTMLInputElement[] {
    const candidates = Array.from(root.querySelectorAll<HTMLInputElement>("input"));
    return candidates.filter(input => {
        if (input.type !== "search" && !/favorite/i.test(`${input.placeholder} ${input.getAttribute("aria-label") || ""}`)) return false;
        let node: HTMLElement | null = input;
        for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
            if (/favoritesHeader/i.test(typeof node.className === "string" ? node.className : "")) return true;
        }
        return /favorite/i.test(`${input.placeholder} ${input.getAttribute("aria-label") || ""}`);
    });
}

function isFavoritesView(): boolean {
    return favoriteSearchInputs().length > 0;
}

function resultContainers(root: ParentNode = document): HTMLElement[] {
    const exact = Array.from(root.querySelectorAll<HTMLElement>('[class*="results__2dc39"]'));
    if (exact.length) return exact;
    return Array.from(root.querySelectorAll<HTMLElement>("[class*='results'], [role='grid']"))
        .filter(element => element.querySelector('[aria-label*="Favorites"], img, video'));
}

function resultContent(results: HTMLElement): HTMLElement | null {
    return results.querySelector<HTMLElement>('[class*="content__99f8c"]')
        || results.querySelector<HTMLElement>('[class*="content"], [role="grid"]');
}

function classNameOf(element: Element | null | undefined): string {
    return element?.getAttribute("class") || "";
}

function favoriteControl(card: Element): HTMLElement | null {
    const exact = card.querySelector<HTMLElement>(FAVORITE_BUTTON);
    if (exact) return exact;
    return Array.from(card.querySelectorAll<HTMLElement>("[aria-label]"))
        .find(button => /favorite/i.test(button.getAttribute("aria-label") || "")) || null;
}

function isPickerCard(element: Element | null | undefined): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest(CATEGORY_VIEW_MARK)) return false;
    if (!element.querySelector("img, video")) return false;
    return !!favoriteControl(element);
}

/** Locate Discords GIF result cards regardless of the current hashed classes. */
function pickerCards(root: ParentNode = document): HTMLElement[] {
    const legacy = Array.from(root.querySelectorAll<HTMLElement>(LEGACY_PICKER_CARD))
        .filter(card => !card.closest(CATEGORY_VIEW_MARK));
    if (legacy.length) return legacy;

    const candidates = Array.from(root.querySelectorAll<HTMLElement>(PICKER_CARD_PATTERN)).filter(isPickerCard);
    // Nested wrappers can also satisfy the structural test; keep the innermost
    // card so one result is not counted twice.
    return candidates.filter(card => !candidates.some(other => other !== card && card.contains(other)));
}

const settings = definePluginSettings({
    data: {
        type: OptionType.STRING,
        description: "Stored GIF categories and assignments (managed by the plugin)",
        default: "{}",
    }
});

function loadData(): CategoryData {
    try {
        const parsed = JSON.parse(settings.store.data || "{}");
        const order: Record<string, string[]> = {};
        if (parsed.order && typeof parsed.order === "object") {
            for (const [categoryId, keys] of Object.entries(parsed.order)) {
                if (Array.isArray(keys)) order[categoryId] = keys.filter((key): key is string => typeof key === "string");
            }
        }
        return {
            categories: Array.isArray(parsed.categories) ? parsed.categories.filter((c: any) => c && typeof c.id === "string" && typeof c.name === "string") : [],
            assignments: parsed.assignments && typeof parsed.assignments === "object" ? parsed.assignments : {},
            order,
            usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {}
        };
    } catch {
        return { categories: [], assignments: {}, order: {}, usage: {} };
    }
}

function saveData(data: CategoryData) {
    settings.store.data = JSON.stringify(data);
}

/** Record a key as the newest entry of a category so it renders at the top. */
function noteAddedEntry(data: CategoryData, categoryId: string, key: string) {
    const list = (data.order[categoryId] || []).filter(existing => existing !== key);
    list.unshift(key);
    data.order[categoryId] = list;
}

function forgetEntry(data: CategoryData, categoryId: string, key: string) {
    const list = (data.order[categoryId] || []).filter(existing => existing !== key);
    if (list.length) data.order[categoryId] = list;
    else delete data.order[categoryId];
}

function noteGifUsed(key: string) {
    if (!hasFeature("mostUsed")) return;
    const canonical = canonicalKey(key);
    if (!canonical) return;
    const data = loadData();
    const previous = data.usage[canonical];
    data.usage[canonical] = {
        count: (Number(previous?.count) || 0) + 1,
        lastUsed: Date.now()
    };
    saveData(data);
}

function getFavoriteStore() {
    return (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators;
}

function toBase64(bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function fromBase64(value: string) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function getBackupKey() {
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(BACKUP_KEY_MATERIAL),
        "HKDF",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(16), info: new TextEncoder().encode(BACKUP_FORMAT) },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function downloadBackup(category: Category) {
    try {
        const store = getFavoriteStore();
        await store.loadIfNecessary?.();
        const gifs = store.getCurrentValue()?.favoriteGifs?.gifs || {};
        const data = loadData();
        const categoryGifs = Object.entries(gifs).filter(([rawKey]) =>
            (data.assignments[canonicalKey(rawKey)] || []).includes(category.id)
        );
        const manifest: CategoryBackup = {
            version: 1,
            exportedAt: new Date().toISOString(),
            categories: [category],
            gifs: categoryGifs.map(([rawKey, rawGif]: [string, any]) => ({
                key: canonicalKey(rawKey),
                src: typeof rawGif?.src === "string" ? rawGif.src : rawKey,
                format: Number(rawGif?.format) || 1,
                width: Number(rawGif?.width) || 0,
                height: Number(rawGif?.height) || 0,
                categories: data.assignments[canonicalKey(rawKey)] || []
            }))
        };
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await getBackupKey();
        const plaintext = new TextEncoder().encode(JSON.stringify(manifest));
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
        const encryptedBackup = {
            format: BACKUP_FORMAT,
            version: 1,
            cipher: "AES-256-GCM",
            keyVersion: 1,
            iv: toBase64(iv),
            ciphertext: toBase64(encrypted)
        };
        const blob = new Blob([JSON.stringify(encryptedBackup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const safeName = category.name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "category";
        link.download = `gif-category-${safeName}-encrypted-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast({ text: `Exported “${category.name}” with ${manifest.gifs.length} GIFs as encrypted JSON`, variant: "success" } as any);
    } catch (error) {
        console.error("[FavoriteGifCategories] Export failed", error);
        showToast({ text: `GIF category export failed: ${String(error)}`, variant: "critical" } as any);
    }
}

function pickerSource(raw: string) {
    try {
        const url = new URL(raw);
        if (url.hostname === "cdn.discordapp.com") url.hostname = "media.discordapp.net";
        if (/\.(gif|webp|avif)$/i.test(url.pathname)) {
            url.searchParams.set("format", "webp");
            url.searchParams.set("animated", "true");
        }
        return url.toString();
    } catch {
        return raw;
    }
}

async function importBackup(file: File) {
    try {
        const container = JSON.parse(await file.text());
        if (container.format !== BACKUP_FORMAT || container.version !== 1 || container.cipher !== "AES-256-GCM" || container.keyVersion !== 1) {
            throw new Error("Unsupported or invalid encrypted GIF category backup");
        }
        let plaintext: ArrayBuffer;
        try {
            const key = await getBackupKey();
            plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromBase64(container.iv) },
                key,
                fromBase64(container.ciphertext)
            );
        } catch {
            throw new Error("Could not decrypt backup; it may be damaged or use an unsupported key version");
        }
        const manifest = JSON.parse(new TextDecoder().decode(plaintext)) as CategoryBackup;
        if (manifest.version !== 1 || !Array.isArray(manifest.categories) || !Array.isArray(manifest.gifs)) {
            throw new Error("Unsupported or invalid GIF category backup");
        }

        const store = getFavoriteStore();
        await store.loadIfNecessary?.();
        const data = loadData();
        const categoryIdMap = new Map<string, string>();
        const byName = new Map(data.categories.map(category => [category.name.toLocaleLowerCase(), category.id]));
        for (const imported of manifest.categories) {
            if (!imported || typeof imported.id !== "string" || typeof imported.name !== "string") continue;
            let id = byName.get(imported.name.toLocaleLowerCase());
            if (!id) {
                id = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                data.categories.push({ id, name: imported.name });
                byName.set(imported.name.toLocaleLowerCase(), id);
            }
            categoryIdMap.set(imported.id, id);
        }

        let added = 0;
        const actualKeyByImportedKey = new Map<string, string>();
        const importedItems = manifest.gifs.filter(item => item && typeof item.key === "string" && typeof item.src === "string");
        for (let offset = 0; offset < importedItems.length; offset += 40) {
            const batch = importedItems.slice(offset, offset + 40);
            await store.updateAsync("favoriteGifs", (draft: any) => {
                if (!draft.gifs) draft.gifs = {};
                let order = Math.max(0, ...Object.values(draft.gifs).map((gif: any) => Number(gif?.order) || 0));
                for (const item of batch) {
                    const key = canonicalKey(item.key);
                    const existing = Object.entries(draft.gifs).find(([existingKey, gif]: [string, any]) =>
                        canonicalKey(existingKey) === key || (typeof gif?.src === "string" && canonicalKey(gif.src) === key));
                    if (existing) {
                        actualKeyByImportedKey.set(item.key, existing[0]);
                        continue;
                    }
                    const src = pickerSource(item.src);
                    draft.gifs[key] = {
                        format: Number(item.format) || 1,
                        src,
                        width: Number(item.width) || 0,
                        height: Number(item.height) || 0,
                        order: ++order
                    };
                    actualKeyByImportedKey.set(item.key, key);
                    added++;
                }
            }, 0);
        }

        // Import newest-last in the manifest, so walk it backwards to keep the
        // same "most recent on top" order as manual additions.
        for (const item of [...importedItems].reverse()) {
            const key = actualKeyByImportedKey.get(item.key) || canonicalKey(item.key);
            const categories = (Array.isArray(item.categories) ? item.categories : [])
                .map(id => categoryIdMap.get(id))
                .filter((id): id is string => !!id);
            if (!categories.length) continue;
            data.assignments[key] = [...new Set([...(data.assignments[key] || []), ...categories])];
            for (const id of categories) noteAddedEntry(data, id, key);
        }
        saveData(data);
        selectedCategory = null;
        scheduleScan();
        showToast({ text: `Imported ${importedItems.length} GIFs (${added} newly favorited) and ${manifest.categories.length} categories`, variant: "success" } as any);
    } catch (error) {
        console.error("[FavoriteGifCategories] Import failed", error);
        showToast({ text: `GIF category import failed: ${String(error)}`, variant: "critical" } as any);
    }
}

function chooseBackupFile(pickerRoot: HTMLElement) {
    let input = pickerRoot.querySelector<HTMLInputElement>("[data-fav-gif-category-import]");
    if (!input) {
        input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.dataset.favGifCategoryImport = "true";
        input.style.display = "none";
        input.addEventListener("change", () => {
            const file = input?.files?.[0];
            if (file) void importBackup(file);
            if (input) input.value = "";
        });
        pickerRoot.append(input);
    }
    input.click();
}

function canonicalKey(raw: string): string {
    const match = raw.match(/^https?:\/\/images-ext-\d+\.discordapp\.net\/external\/[^/]+\/(https?\/.+)$/i);
    if (match) {
        const rest = match[1];
        raw = rest.startsWith("https/") ? `https://${rest.slice(6)}` : rest.startsWith("http/") ? `http://${rest.slice(5)}` : raw;
    }

    try {
        const url = new URL(raw);
        if (url.hostname === "media.discordapp.net") url.hostname = "cdn.discordapp.com";
        url.search = "";
        url.hash = "";
        return url.toString();
    } catch {
        return raw;
    }
}

function favoriteKeysInOrder(): string[] {
    try {
        const store = (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators
            || (Vencord as any).Webpack?.findAll((module: any) => module?.ProtoClass?.typeName?.endsWith(".FrecencyUserSettings"))[0];
        const gifs = store?.getCurrentValue()?.favoriteGifs?.gifs || {};
        return Object.entries(gifs)
            .map(([key, value]: [string, any]) => ({ key, order: value?.order || 0 }))
            .sort((a, b) => b.order - a.order)
            .map(({ key }) => canonicalKey(key));
    } catch {
        return [];
    }
}

function cardMediaUrl(card: Element): string | null {
    const video = card.querySelector("video");
    if (video) return video.currentSrc || video.src || null;
    const img = card.querySelector("img");
    if (img && img.src && !img.src.startsWith("data:")) return img.currentSrc || img.src;
    const link = card.querySelector('a[href^="http"]');
    return link?.getAttribute("href") || null;
}

function cardKey(card: Element, cards: Element[]): string | null {
    const stored = (card as HTMLElement).dataset?.favGifKey;
    if (stored) return stored;

    const direct = cardMediaUrl(card);
    if (direct) return canonicalKey(direct);

    // Discord sometimes keeps the real media URL outside the visible image.
    // Its picker order matches favoriteGifs.order, so use that as a fallback.
    const index = cards.indexOf(card);
    return favoriteKeysInOrder()[index] || null;
}

function nativeResultCards(): HTMLElement[] {
    const results = resultContainers()[0];
    const content = results && resultContent(results);
    const layer = content?.firstElementChild;
    if (!layer) return [];
    return pickerCards(layer);
}

/**
 * Read the current build's hashed classes from a real card so synthetic
 * category tiles use exactly the same styling as native results.
 */
function pickerClasses() {
    const native = nativeResultCards()[0];
    const media = native?.querySelector<HTMLElement>("img, video");
    const favorite = native ? favoriteControl(native) : null;
    const download = native?.querySelector<HTMLElement>(DOWNLOAD_BUTTON);
    return {
        card: classNameOf(native).trim() || LEGACY_PICKER_CARD,
        media: classNameOf(media).trim() || "gif__2dc39",
        favorite: classNameOf(favorite).trim() || "favButton__2dc39 gifFavoriteButton__43deb selected__43deb",
        download: classNameOf(download || favorite).split(/\s+/).filter(name => name && !/^selected/i.test(name)).join(" ") || "favButton__2dc39 gifFavoriteButton__43deb",
        icon: classNameOf(favorite?.querySelector("svg")).trim() || classNameOf(download?.querySelector("svg")).trim() || "icon__43deb"
    };
}

function selectCategoryGif(item: { src: string; format: number; width: number; height: number; key: string; }) {
    noteGifUsed(item.key);
    if (nativeGifSelector) {
        // Discord's picker callback accepts the selected media URL and sends
        // it through the same path as clicking a native GIF result.
        nativeGifSelector({ url: pickerSource(item.src) });
        return;
    }

    // Compatibility fallback for Discord builds where the callback patch
    // does not match.
    void activateNativeResult(item.key);
}

function downloadCategoryGif(item: { src: string; key: string; }) {
    // The GIF Downloader plugin exposes its exact resolution/conversion path.
    // Use it directly so downloading a category tile cannot depend on first
    // scrolling Discord's virtualized favorites list to the matching card.
    const tools = (window as any).__favGifTools;
    if (typeof tools?.saveGifFile === "function") {
        Promise.resolve(tools.saveGifFile(`${Date.now()}`, item.src))
            .then(() => showToast({ text: "GIF saved", variant: "success" } as any))
            .catch((error: unknown) => {
                console.error("[FavoriteGifCategories] Download failed", error);
                showToast({ text: `GIF download failed: ${String(error)}`, variant: "critical" } as any);
            });
        return;
    }
    void activateNativeResult(item.key, DOWNLOAD_BUTTON);
}

async function activateNativeResult(key: string, targetSelector: string | null = null) {
    const results = resultContainers()[0];
    const contentEl = results && resultContent(results);
    const virtualLayer = contentEl?.firstElementChild as HTMLElement | null;
    if (!results || !contentEl || !virtualLayer || categoryActivationInProgress) return false;

    categoryActivationInProgress = true;
    const oldHeight = contentEl.style.height;
    const oldScroll = results.scrollTop;
    try {
        contentEl.style.height = contentEl.dataset.favGifNativeHeight || oldHeight;
        virtualLayer.style.height = contentEl.dataset.favGifVirtualHeight || virtualLayer.style.height;
        virtualLayer.style.overflow = "visible";
        virtualLayer.style.visibility = "";

        const index = favoriteKeysInOrder().indexOf(key);
        // Rows are two cards wide with uneven heights, so the exact scroll
        // offset cannot be computed. Probe around the estimated row and stop
        // at the first mounted card whose media matches.
        const estimatedRow = Math.floor(Math.max(0, index) / 2);
        const rows = [0, -1, 1, -2, 2, -3, 3].map(offset => Math.max(0, estimatedRow + offset));
        for (const row of rows) {
            results.scrollTop = row * 272;
            results.dispatchEvent(new Event("scroll"));
            await new Promise(resolve => setTimeout(resolve, 300));
            const cards = pickerCards(virtualLayer);
            const native = cards.find(candidate => cardKey(candidate, cards) === key);
            if (!native) continue;

            const target = targetSelector === FAVORITE_BUTTON
                ? favoriteControl(native)
                : targetSelector ? native.querySelector<HTMLElement>(targetSelector) : native;
            if (target) {
                target.click();
                return true;
            }
        }
        return false;
    } finally {
        contentEl.style.height = oldHeight;
        virtualLayer.style.height = "1px";
        virtualLayer.style.overflow = "hidden";
        virtualLayer.style.visibility = "hidden";
        results.scrollTop = oldScroll;
        categoryActivationInProgress = false;
        scheduleScan();
    }
}

/** Position of every favorite in the order Discord renders them in. */
function favoriteIndexes() {
    const entries = Object.entries(favoriteGifEntries())
        .map(([key, gif]) => ({
            key: canonicalKey(key),
            src: canonicalKey(String((gif as any)?.src || "")),
            order: Number((gif as any)?.order) || 0
        }))
        .sort((a, b) => b.order - a.order);

    const byKey = new Map<string, number>();
    const bySrc = new Map<string, number>();
    entries.forEach((entry, index) => {
        byKey.set(entry.key, index);
        if (entry.src) bySrc.set(entry.src, index);
    });
    return { byKey, bySrc };
}

function cardFavoriteIndex(
    card: Element,
    indexes: { byKey: Map<string, number>; bySrc: Map<string, number>; }
): number | null {
    const media = canonicalKey(cardMediaUrl(card) || "");
    if (!media) return null;
    if (indexes.bySrc.has(media)) return indexes.bySrc.get(media)!;
    return indexes.byKey.get(media) ?? null;
}

/** The jump targets the unfiltered All list, so drop a stale Favorites search. */
function clearFavoriteSearch(): boolean {
    const input = favoriteSearchInputs()[0];
    if (!input?.value) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "");
    clearingFavoriteSearch = true;
    try {
        input.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
        clearingFavoriteSearch = false;
    }
    return true;
}

const configuredCategorySearchInputs = new WeakSet<HTMLInputElement>();

function updateCategorySearch(input: HTMLInputElement, value: string, caret = value.length) {
    categoryQuery = value;
    input.value = value;
    input.setSelectionRange(caret, caret);
    processCards();
}

function configureCategorySearch(input: HTMLInputElement, data: CategoryData) {
    const active = !!selectedCategory && hasFeature("categorySearch");
    if (!input.dataset.favGifOriginalPlaceholder) input.dataset.favGifOriginalPlaceholder = input.placeholder;

    if (!active) {
        input.placeholder = input.dataset.favGifOriginalPlaceholder;
        if (input.dataset.favGifCategorySearch) input.value = "";
        delete input.dataset.favGifCategorySearch;
        return;
    }

    const categoryName = selectedCategory === MOST_USED_CATEGORY
        ? "Most Used"
        : selectedCategory === DUPLICATES_CATEGORY
            ? "Duplicates"
            : data.categories.find(category => category.id === selectedCategory)?.name || "Category";
    input.dataset.favGifCategorySearch = "true";
    input.placeholder = `Search ${categoryName}`;
    if (input.value !== categoryQuery) input.value = categoryQuery;

    if (configuredCategorySearchInputs.has(input)) return;
    configuredCategorySearchInputs.add(input);
    input.addEventListener("input", event => {
        if (clearingFavoriteSearch || !selectedCategory || !hasFeature("categorySearch")) return;
        event.stopPropagation();
        categoryQuery = input.value;
        processCards();
    }, true);
    input.addEventListener("keydown", event => {
        if (!selectedCategory || !hasFeature("categorySearch") || event.isComposing) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const { value: currentValue } = input;
        const start = input.selectionStart ?? currentValue.length;
        const end = input.selectionEnd ?? start;
        let value = currentValue;
        let caret = start;

        if (event.key.length === 1) {
            value = value.slice(0, start) + event.key + value.slice(end);
            caret = start + event.key.length;
        } else if (event.key === "Backspace") {
            if (start !== end) value = value.slice(0, start) + value.slice(end);
            else if (start > 0) {
                value = value.slice(0, start - 1) + value.slice(end);
                caret = start - 1;
            }
        } else if (event.key === "Delete") {
            value = value.slice(0, start) + value.slice(start === end ? end + 1 : end);
        } else {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        updateCategorySearch(input, value, caret);
    }, true);
    input.addEventListener("paste", event => {
        if (!selectedCategory || !hasFeature("categorySearch")) return;
        const text = event.clipboardData?.getData("text") || "";
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        event.preventDefault();
        event.stopPropagation();
        updateCategorySearch(input, input.value.slice(0, start) + text + input.value.slice(end), start + text.length);
    }, true);
    input.addEventListener("search", event => {
        if (!selectedCategory || !hasFeature("categorySearch")) return;
        event.preventDefault();
        event.stopPropagation();
        updateCategorySearch(input, input.value);
    }, true);
}

/**
 * Jump from a category tile to the same GIF in the All favorites list.
 * Discord renders that list as a two-column masonry with measured heights, so
 * there is no direct index-to-offset formula. Instead, scroll to an estimate,
 * read the cards that are mounted, and interpolate until the target is found.
 */
async function jumpToInAll(key: string) {
    const targetKey = canonicalKey(key);
    const gifs = favoriteGifEntries();
    const indexes = favoriteIndexes();

    let media = "";
    for (const [raw, gif] of Object.entries(gifs)) {
        if (canonicalKey(raw) !== targetKey) continue;
        media = canonicalKey(String((gif as any)?.src || ""));
        break;
    }

    let target = indexes.byKey.get(targetKey);
    if (target == null && media) target = indexes.bySrc.get(media);

    selectedCategory = null;
    restoreCategoryView();
    clearTemporaryHides(nativeResultCards());
    scheduleScan();
    if (clearFavoriteSearch()) {
        // Let the unfiltered list render before measuring offsets.
        await new Promise(resolve => setTimeout(resolve, 350));
    }
    // Restoring the native layer can leave the virtualizer a frame behind, so
    // wait until it has actually mounted cards again before measuring.
    for (let attempt = 0; attempt < 15 && nativeResultCards().length < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const results = resultContainers()[0];
    if (!results) return;
    if (target == null) {
        showToast({ text: "That GIF is no longer in your favorites", variant: "critical" } as any);
        return;
    }

    const absoluteTop = (element: Element) =>
        element.getBoundingClientRect().top - results.getBoundingClientRect().top + results.scrollTop;
    const maxScroll = () => Math.max(0, results.scrollHeight - results.clientHeight);
    const scrollTo = async (top: number) => {
        results.scrollTop = Math.max(0, Math.min(maxScroll(), top));
        results.dispatchEvent(new Event("scroll"));
        await new Promise(resolve => setTimeout(resolve, 260));
    };

    const findCard = () => {
        const cards = nativeResultCards();
        const byIndex = cards.find(card => cardFavoriteIndex(card, indexes) === target);
        if (byIndex) return byIndex;
        if (!media) return null;
        return cards.find(card => canonicalKey(cardMediaUrl(card) || "") === media) || null;
    };
    const samplesNow = () => nativeResultCards()
        .map(element => {
            const index = cardFavoriteIndex(element, indexes);
            return index == null ? null : { index, top: absoluteTop(element) };
        })
        .filter((sample): sample is { index: number; top: number; } => !!sample)
        .sort((a, b) => a.index - b.index);

    const awaitCard = async () => {
        let found = findCard();
        for (let attempt = 0; attempt < 6 && !found; attempt++) {
            // Discord mounts the masonry tiles a few frames after the scroll
            // position changes, so give the target a moment to exist.
            await new Promise(resolve => setTimeout(resolve, 100));
            found = findCard();
        }
        return found;
    };

    let card = null as HTMLElement | null;
    let guess = target * 137;
    let direction = 1;
    let slope = 137;
    for (let attempt = 0; attempt < 7 && !card; attempt++) {
        await scrollTo(guess);
        card = await awaitCard();
        if (card) break;

        let samples = samplesNow();
        if (samples.length < 2) {
            // One extra beat in case the render landed after the scroll.
            await new Promise(resolve => setTimeout(resolve, 200));
            samples = samplesNow();
        }
        if (samples.length < 2) break;

        const first = samples[0];
        const last = samples[samples.length - 1];
        const local = last.index === first.index ? slope : (last.top - first.top) / (last.index - first.index);
        if (!Number.isFinite(local) || local < 40) break;
        slope = local;
        direction = target < first.index ? -1 : 1;
        const next = first.top + (target - first.index) * slope - 12;
        if (Math.abs(next - results.scrollTop) < 12) {
            // The index says we are already at the target's offset but its tile
            // is not mounted. Nudge around this position before giving up.
            for (const delta of [240, -240, 480, -480, 720, -720]) {
                await scrollTo(results.scrollTop + delta);
                card = await awaitCard();
                if (card) break;
            }
            break;
        }
        guess = next;
    }

    // Last resort: step toward the target one window at a time instead of
    // jumping around, and stop as soon as the list stops moving.
    for (let step = 0; step < 20 && !card; step++) {
        const before = results.scrollTop;
        await scrollTo(before + direction * Math.max(620, slope * 5));
        if (Math.abs(results.scrollTop - before) < 1) break;
        card = await awaitCard();
    }

    if (!card) {
        showToast({ text: "Could not find that GIF in All favorites", variant: "critical" } as any);
        return;
    }

    await scrollTo(absoluteTop(card) - 12);
    card = (await awaitCard()) || card;
    // Positions can shift while the virtualizer settles, so line the tile up
    // one more time if the first pass was off.
    const relativeTop = card.getBoundingClientRect().top - results.getBoundingClientRect().top;
    if (relativeTop < -4 || relativeTop > 30) {
        await scrollTo(absoluteTop(card) - 12);
        card = (await awaitCard()) || card;
    }
    const previousOutline = card.style.outline;
    const previousOffset = card.style.outlineOffset;
    card.style.outline = "3px solid var(--brand-experiment,#5865f2)";
    card.style.outlineOffset = "2px";
    setTimeout(() => {
        card.style.outline = previousOutline;
        card.style.outlineOffset = previousOffset;
    }, 2600);
}

function closeMenu() {
    currentMenu?.remove();
    currentMenu = null;
}

function isolateInjectedInteraction(element: HTMLElement) {
    // Picker descendants share Discord's React event root. Let the injected
    // control handle its own interaction without forwarding pointer events to
    // Discord's GIF selection handlers.
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        element.addEventListener(type, event => event.stopPropagation());
    }
}

function deleteCategory(category: Category) {
    const data = loadData();
    data.categories = data.categories.filter(c => c.id !== category.id);
    for (const [key, ids] of Object.entries(data.assignments)) {
        const remaining = ids.filter(id => id !== category.id);
        if (remaining.length) data.assignments[key] = remaining;
        else delete data.assignments[key];
    }
    delete data.order[category.id];
    saveData(data);
    if (selectedCategory === category.id) selectedCategory = null;
    scheduleScan();
}

function showCategoryMenu(event: MouseEvent, category: Category, bar: HTMLElement) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    isolateInjectedInteraction(menu);
    menu.style.cssText = `position:fixed;left:${Math.max(8, Math.min(event.clientX, innerWidth - 250))}px;top:${Math.max(8, Math.min(event.clientY, innerHeight - 165))}px;z-index:1000000;min-width:230px;padding:6px 0;background:var(--background-floating,#111214);border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12));border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);`;

    const remove = menuButton(`Delete “${category.name}”`, () => {
        deleteCategory(category);
        closeMenu();
    });
    remove.style.color = "var(--text-danger,#f23f43)";

    // Keep menu pointer activity within the picker, avoiding Discord's
    // click-outside handler dismissing the picker while deleting a folder.
    const pickerRoot = bar.closest<HTMLElement>("[class*='contentWrapper']")
        || bar.closest<HTMLElement>("[role='dialog']")
        || document.body;
    menu.append(menuButton("Export this category…", () => {
        closeMenu();
        void downloadBackup(category);
    }));
    menu.append(menuButton("Import GIFs & categories…", () => {
        closeMenu();
        chooseBackupFile(pickerRoot);
    }));
    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;margin:5px 8px;background:var(--background-modifier-accent,rgba(255,255,255,.12));";
    menu.append(divider, remove);
    pickerRoot.append(menu);
    currentMenu = menu;

    const dismiss = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
            closeMenu();
            document.removeEventListener("mousedown", dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

function persistCategoryOrder(bar: HTMLElement) {
    const order = Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-category-id]"))
        .map(button => button.dataset.categoryId)
        .filter((id): id is string => !!id);
    const data = loadData();
    const byId = new Map(data.categories.map(category => [category.id, category]));
    const reordered = order.map(id => byId.get(id)).filter((c): c is Category => !!c);
    // Keep any categories whose button was not present (e.g. a transient render).
    for (const category of data.categories) if (!reordered.some(c => c.id === category.id)) reordered.push(category);
    data.categories = reordered;
    saveData(data);
}

function menuButton(label: string, onClick: () => void, checked = false) {
    const button = document.createElement("button");
    isolateInjectedInteraction(button);
    button.type = "button";
    button.textContent = `${checked ? "✓  " : "　　"}${label}`;
    button.style.cssText = "display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:var(--text-normal,#dbdee1);font:inherit;cursor:pointer;white-space:nowrap;";
    button.addEventListener("mouseenter", () => { button.style.background = "var(--background-modifier-hover,rgba(255,255,255,.08))"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
    button.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return button;
}

function favoriteGifEntries(): Record<string, any> {
    try {
        return (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators.getCurrentValue()?.favoriteGifs?.gifs || {};
    } catch {
        return {};
    }
}

function favoriteItems(): FavoriteItem[] {
    const unique = new Map<string, FavoriteItem>();
    for (const [rawKey, gif] of Object.entries(favoriteGifEntries()) as Array<[string, any]>) {
        const item = {
            key: canonicalKey(rawKey),
            src: typeof gif?.src === "string" && gif.src ? gif.src : rawKey,
            format: Number(gif?.format) || 1,
            width: Number(gif?.width) || 0,
            height: Number(gif?.height) || 0,
            order: Number(gif?.order) || 0
        };
        const previous = unique.get(item.key);
        if (!previous || item.order > previous.order) unique.set(item.key, item);
    }
    return [...unique.values()];
}

function categoryItems(categoryId: string, data: CategoryData, query = categoryQuery): FavoriteItem[] {
    const items = favoriteItems();
    let matches: FavoriteItem[];

    if (categoryId === MOST_USED_CATEGORY) {
        matches = items
            .filter(item => (data.usage[item.key]?.count || 0) > 0)
            .sort((a, b) => {
                const aUsage = data.usage[a.key];
                const bUsage = data.usage[b.key];
                return (bUsage?.count || 0) - (aUsage?.count || 0)
                    || (bUsage?.lastUsed || 0) - (aUsage?.lastUsed || 0)
                    || b.order - a.order;
            });
    } else if (categoryId === DUPLICATES_CATEGORY) {
        matches = duplicateGroups.flat();
    } else {
        const assigned = new Map(items
            .filter(item => (data.assignments[item.key] || []).includes(categoryId))
            .map(item => [item.key, item]));
        matches = [];
        const seen = new Set<string>();
        for (const orderedKey of data.order[categoryId] || []) {
            const canonical = canonicalKey(orderedKey);
            const item = assigned.get(canonical);
            if (!item || seen.has(canonical)) continue;
            matches.push(item);
            seen.add(canonical);
        }
        matches.push(...[...assigned.values()]
            .filter(item => !seen.has(item.key))
            .sort((a, b) => b.order - a.order));
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return matches;
    return matches.filter(item => {
        let searchable = `${item.key} ${item.src}`.toLocaleLowerCase();
        try { searchable += ` ${decodeURIComponent(searchable)}`; } catch { }
        return normalizedQuery.split(/\s+/).every(term => searchable.includes(term));
    });
}

function findDuplicateGroups(): DuplicateItem[][] {
    const entries = Object.entries(favoriteGifEntries()).map(([rawKey, gif]: [string, any]) => ({
        rawKey,
        key: canonicalKey(rawKey),
        media: canonicalKey(String(gif?.src || rawKey)),
        src: typeof gif?.src === "string" && gif.src ? gif.src : rawKey,
        format: Number(gif?.format) || 1,
        width: Number(gif?.width) || 0,
        height: Number(gif?.height) || 0,
        order: Number(gif?.order) || 0
    }));
    const byMedia = new Map<string, typeof entries>();
    for (const entry of entries) {
        const group = byMedia.get(entry.media) || [];
        group.push(entry);
        byMedia.set(entry.media, group);
    }
    return [...byMedia.values()]
        .filter(group => group.length > 1)
        .map(group => group
            .sort((a, b) => b.order - a.order)
            .map((item, index) => ({
                rawKey: item.rawKey,
                key: item.key,
                src: item.src,
                format: item.format,
                width: item.width,
                height: item.height,
                order: item.order,
                duplicateRole: index === 0 ? "Keep" as const : "Duplicate" as const
            })));
}

function showDuplicates() {
    duplicateGroups = findDuplicateGroups();
    const duplicateCount = duplicateGroups.reduce((total, group) => total + group.length - 1, 0);
    if (!duplicateCount) {
        if (selectedCategory === DUPLICATES_CATEGORY) selectedCategory = null;
        showToast({ text: "No duplicate favorite GIFs found", variant: "success" } as any);
        processCards();
        scheduleScan();
        return;
    }

    categoryQuery = "";
    selectedCategory = DUPLICATES_CATEGORY;
    if (clearFavoriteSearch()) window.setTimeout(processCards, 100);
    else processCards();
    scheduleScan();
}

async function removeFoundDuplicates() {
    const groups = duplicateGroups.length ? duplicateGroups : findDuplicateGroups();
    const duplicateCount = groups.reduce((total, group) => total + group.length - 1, 0);
    if (!duplicateCount) return;
    if (!window.confirm(`Found ${duplicateCount} duplicate GIF${duplicateCount === 1 ? "" : "s"} in ${groups.length} group${groups.length === 1 ? "" : "s"}. Remove duplicates and keep the newest copy?`)) return;

    const data = loadData();
    const removals = new Set<string>();
    for (const group of groups) {
        const keeper = group[0].key;
        const duplicateKeys = [...new Set(group.slice(1).map(entry => entry.key).filter(key => key !== keeper))];
        group.slice(1).forEach(entry => removals.add(entry.rawKey));

        const mergedCategories = new Set(data.assignments[keeper] || []);
        let mergedCount = data.usage[keeper]?.count || 0;
        let latestUse = data.usage[keeper]?.lastUsed || 0;
        for (const duplicate of duplicateKeys) {
            (data.assignments[duplicate] || []).forEach(id => mergedCategories.add(id));
            mergedCount += data.usage[duplicate]?.count || 0;
            latestUse = Math.max(latestUse, data.usage[duplicate]?.lastUsed || 0);
            delete data.assignments[duplicate];
            delete data.usage[duplicate];
        }
        if (mergedCategories.size) data.assignments[keeper] = [...mergedCategories];
        if (mergedCount) data.usage[keeper] = { count: mergedCount, lastUsed: latestUse };
        for (const category of data.categories) {
            const replaced = (data.order[category.id] || []).map(key => duplicateKeys.includes(canonicalKey(key)) ? keeper : key);
            data.order[category.id] = [...new Set(replaced)];
        }
    }

    const store = getFavoriteStore();
    await store.updateAsync("favoriteGifs", (draft: any) => {
        for (const rawKey of removals) delete draft.gifs?.[rawKey];
    }, 0);
    saveData(data);
    duplicateGroups = [];
    selectedCategory = null;
    scheduleScan();
    showToast({ text: `Removed ${duplicateCount} duplicate GIF${duplicateCount === 1 ? "" : "s"}`, variant: "success" } as any);
}

/**
 * Rendering a trending GIF and storing it as a favorite can use different
 * URLs (preview media vs. the Tenor/Klipy page), so remember the mapping for
 * the rest of the session; otherwise the same card would look unassigned and
 * could be added twice.
 */
const resolvedFavoriteKeys = new Map<string, string>();

/** Map a rendered card to the key Discord actually stores it under. */
function storedKeyFor(card: Element, key: string): string {
    const media = canonicalKey(cardMediaUrl(card) || key);
    const mapped = resolvedFavoriteKeys.get(key) || resolvedFavoriteKeys.get(media);
    if (mapped) return mapped;

    const gifs = favoriteGifEntries();
    for (const raw of Object.keys(gifs)) {
        const canonical = canonicalKey(raw);
        if (canonical === key) return canonical;
    }
    for (const [raw, gif] of Object.entries(gifs)) {
        if (canonicalKey(String(gif?.src || "")) === media) return canonicalKey(raw);
    }
    return key;
}

/**
 * Categories are built from Discord's favorite GIFs, so a GIF that is only a
 * trending/search result has to be favorited before it can show up in one.
 * Prefer Discord's own star so the stored entry is exactly what it would have
 * written, then resolve the key it actually used (Discord stores Tenor/Klipy
 * items under their page URL, not the media URL).
 */
async function ensureFavorite(card: Element, key: string): Promise<string> {
    const before = favoriteGifEntries();
    if (Object.keys(before).some(raw => canonicalKey(raw) === key)) return key;

    const control = favoriteControl(card);
    if (!control || !/^add\b/i.test((control.getAttribute("aria-label") || "").trim())) return key;

    const media = canonicalKey(cardMediaUrl(card) || key);
    control.click();

    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const current = favoriteGifEntries();
        const added = Object.keys(current).filter(raw => !(raw in before));
        if (!added.length) continue;
        const bySource = added.find(raw => canonicalKey(String(current[raw]?.src || "")) === media);
        const chosen = bySource || (added.length === 1 ? added[0] : null);
        if (!chosen) continue;
        const stored = canonicalKey(chosen);
        resolvedFavoriteKeys.set(key, stored);
        resolvedFavoriteKeys.set(media, stored);
        return stored;
    }
    return key;
}

async function toggleAssignment(card: Element, key: string, category: Category, isAssigned: boolean) {
    if (!isAssigned) {
        const savedKey = await ensureFavorite(card, key);
        const next = loadData();
        next.assignments[savedKey] = [...new Set([...(next.assignments[savedKey] || []), category.id])];
        noteAddedEntry(next, category.id, savedKey);
        saveData(next);
        scheduleScan();
        showToast({ text: `Added to ${category.name}`, variant: "success" } as any);
        return;
    }

    const next = loadData();
    next.assignments[key] = (next.assignments[key] || []).filter(id => id !== category.id);
    if (!next.assignments[key].length) delete next.assignments[key];
    forgetEntry(next, category.id, key);
    saveData(next);
    scheduleScan();
}

function showContextMenu(event: MouseEvent, card: Element, cards: Element[]) {
    const cardKeyValue = cardKey(card, cards);
    if (!cardKeyValue) return;
    // Discord can store the favorite under a different key than the rendered
    // media URL (Klipy/Tenor use their page URL), so resolve to the stored key
    // or the category checkbox would never reflect reality.
    const key = storedKeyFor(card, cardKeyValue);

    event.preventDefault();
    event.stopPropagation();
    closeMenu();

    const data = loadData();
    const assigned = new Set(data.assignments[key] || []);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    isolateInjectedInteraction(menu);
    menu.style.cssText = `position:fixed;left:${Math.max(8, Math.min(event.clientX, innerWidth - 260))}px;top:${Math.max(8, Math.min(event.clientY, innerHeight - 320))}px;z-index:1000000;min-width:220px;max-height:300px;overflow:auto;padding:6px 0;background:var(--background-floating,#111214);border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12));border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);`;

    const heading = document.createElement("div");
    heading.textContent = "Add GIF to category";
    heading.style.cssText = "padding:7px 12px;color:var(--header-secondary,#b5bac1);font-size:12px;font-weight:700;";
    menu.append(heading);

    if (!data.categories.length) {
        const empty = document.createElement("div");
        empty.textContent = "No categories yet";
        empty.style.cssText = "padding:8px 12px;color:var(--text-muted,#949ba4);font-size:13px;";
        menu.append(empty);
    }

    for (const category of data.categories) {
        const isAssigned = assigned.has(category.id);
        menu.append(menuButton(category.name, () => {
            closeMenu();
            void toggleAssignment(card, key, category, isAssigned);
        }, isAssigned));
    }

    menu.append(menuButton("＋  New category…", () => {
        closeMenu();
        createCategory(id => {
            void (async () => {
                // A category can only render GIFs that are actually favorites,
                // so favoriting has to happen before the assignment is saved.
                const savedKey = await ensureFavorite(card, key);
                const next = loadData();
                next.assignments[savedKey] = [...new Set([...(next.assignments[savedKey] || []), id])];
                noteAddedEntry(next, id, savedKey);
                saveData(next);
                scheduleScan();
            })();
        });
    }));

    // Only meaningful inside a category: leave the filter and scroll the All
    // favorites list to the same GIF.
    if (selectedCategory && (card as HTMLElement).dataset.favGifKey) {
        const divider = document.createElement("div");
        divider.style.cssText = "height:1px;margin:5px 0;background:var(--background-modifier-accent,rgba(255,255,255,.12));";
        menu.append(divider);
        menu.append(menuButton("Jump to in All", () => {
            closeMenu();
            void jumpToInAll(key);
        }));
    }

    // Keep the context menu inside the picker subtree. Discord treats clicks
    // outside its picker as dismissal; mounting the menu under document.body
    // makes selecting a category close the picker immediately.
    const pickerRoot = card.closest<HTMLElement>('[class*="contentWrapper"]')
        || card.closest<HTMLElement>('[role="dialog"]')
        || document.body;
    pickerRoot.append(menu);
    currentMenu = menu;
    const dismiss = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
            closeMenu();
            document.removeEventListener("mousedown", dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", dismiss, true), 0);
}

function closeDialog() {
    currentDialog?.remove();
    currentDialog = null;
}

/** Discord desktop suppresses native prompt(), so use a small in-app text UI. */
function createCategory(onCreated?: (id: string) => void) {
    closeDialog();

    const overlay = document.createElement("div");
    overlay.setAttribute("role", "presentation");
    overlay.style.cssText = "position:fixed;inset:0;z-index:1000001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);";

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Create GIF category");
    dialog.style.cssText = "width:min(440px,calc(100vw - 32px));overflow:hidden;background:var(--modal-background,var(--background-primary,#313338));color:var(--text-normal,#dbdee1);border-radius:8px;box-shadow:0 16px 48px rgba(0,0,0,.55);font-family:var(--font-primary,sans-serif);box-sizing:border-box;";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:20px 24px 0;";

    const title = document.createElement("h2");
    title.textContent = "Create GIF category";
    title.style.cssText = "margin:0;font-size:20px;line-height:24px;font-weight:700;color:var(--header-primary,#f2f3f5);";

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    close.textContent = "×";
    close.style.cssText = "display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin:-4px -8px 0 8px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--interactive-normal,#b5bac1);font-size:24px;line-height:1;cursor:pointer;";
    close.addEventListener("click", closeDialog);

    const body = document.createElement("div");
    body.style.cssText = "padding:22px 24px 24px;";

    const label = document.createElement("label");
    label.style.cssText = "display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:16px;font-weight:700;color:var(--header-secondary,#b5bac1);text-transform:uppercase;letter-spacing:.02em;";

    const labelText = document.createElement("span");
    labelText.textContent = "Category name";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 32;
    input.placeholder = "e.g. Reactions";
    input.setAttribute("aria-label", "Category name");
    input.style.cssText = "display:block;width:100%;height:42px;padding:0 12px;box-sizing:border-box;border-radius:4px;border:1px solid var(--input-border,#1e1f22);background:var(--input-background,#1e1f22);color:var(--text-normal,#dbdee1);font:14px var(--font-primary,sans-serif);outline:none;transition:border-color .15s ease;";
    input.addEventListener("focus", () => { input.style.borderColor = "var(--brand-experiment,#5865f2)"; });
    input.addEventListener("blur", () => { input.style.borderColor = "var(--input-border,#1e1f22)"; });
    label.append(labelText, input);

    const error = document.createElement("div");
    error.setAttribute("role", "alert");
    error.style.cssText = "min-height:16px;margin-top:6px;color:var(--text-danger,#f23f43);font-size:12px;line-height:16px;";

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:16px 24px;background:var(--background-secondary,#2b2d31);";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:12px;";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "min-width:80px;height:38px;padding:0 16px;border:0;border-radius:4px;background:transparent;color:var(--text-normal,#dbdee1);font:14px var(--font-primary,sans-serif);font-weight:500;cursor:pointer;";
    cancel.addEventListener("click", closeDialog);

    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "Create";
    create.style.cssText = "min-width:88px;height:38px;padding:0 18px;border:0;border-radius:4px;background:var(--brand-experiment,#5865f2);color:white;font:14px var(--font-primary,sans-serif);font-weight:600;cursor:pointer;";

    const submit = () => {
        const name = input.value.trim();
        if (!name) {
            error.textContent = "Enter a category name.";
            input.focus();
            return;
        }
        const data = loadData();
        if (data.categories.some(c => c.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            error.textContent = "A category with that name already exists.";
            input.focus();
            input.select();
            return;
        }

        const id = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        data.categories.push({ id, name });
        saveData(data);
        // Creating a folder should not immediately filter the picker to an
        // empty folder; the user still needs to assign GIFs to it.
        selectedCategory = null;
        closeDialog();
        onCreated?.(id);
        scheduleScan();
    };

    create.addEventListener("click", submit);
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            submit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            closeDialog();
        }
    });
    overlay.addEventListener("mousedown", event => {
        if (event.target === overlay) closeDialog();
    });

    actions.append(cancel, create);
    header.append(title, close);
    body.append(label, error);
    footer.append(actions);
    dialog.append(header, body, footer);
    overlay.append(dialog);
    document.body.append(overlay);
    currentDialog = overlay;
    requestAnimationFrame(() => input.focus());
}

function manageCategories() {
    createCategory();
}

function migrateLegacySettings() {
    if (settings.store.data && settings.store.data !== "{}") return;
    const legacy = (Vencord as any).Settings?.plugins?.FavoriteGifCategories?.data;
    if (typeof legacy === "string" && legacy !== "{}") settings.store.data = legacy;
}

function renderCategoryBar() {
    const input = favoriteSearchInputs()[0];
    if (!input) return;

    // React may replace the favorites header while leaving the injected bar
    // behind. Keep one bar for the entire picker, not one per refresh.
    const existingBars = Array.from(document.querySelectorAll<HTMLElement>(HEADER_MARK));
    existingBars.slice(1).forEach(bar => bar.remove());
    const data = loadData();
    // Category Search reuses Discord's native Favorites field. Configure it
    // even when the category bar itself does not need to be rebuilt.
    configureCategorySearch(input, data);
    const renderKey = JSON.stringify({
        categories: data.categories,
        selectedCategory,
        features: [...enabledFeatures].sort(),
        duplicates: duplicateGroups.map(group => group.map(item => item.rawKey))
    });
    const existingBar = existingBars[0];
    if (existingBar?.dataset.renderKey === renderKey) return;

    let header: HTMLElement | null = input.parentElement;
    while (header && !/favoritesHeader/i.test(header.className || "")) header = header.parentElement;
    if (!header) header = input.parentElement;
    if (!header) return;

    const bar = existingBar || document.createElement("div");
    if (!existingBar) bar.setAttribute("data-fav-gif-category-bar", "true");
    bar.replaceChildren();
    bar.dataset.renderKey = renderKey;
    bar.style.cssText = "display:flex;flex-direction:column;gap:7px;flex:0 0 100%;align-self:stretch;width:100%;min-width:0;padding:8px 12px 7px;box-sizing:border-box;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));background:color-mix(in srgb,var(--background-secondary,#2b2d31) 36%,transparent);";

    const categoryRow = document.createElement("div");
    categoryRow.setAttribute("data-fav-gif-category-list", "true");
    categoryRow.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%;min-width:0;overflow:visible;padding:1px 0;";

    const actionRow = document.createElement("div");
    actionRow.setAttribute("data-fav-gif-category-actions", "true");
    actionRow.style.cssText = "display:flex;align-items:center;gap:6px;width:100%;min-width:0;";
    bar.append(categoryRow, actionRow);

    const addHoverEffect = (element: HTMLElement) => {
        element.addEventListener("mouseenter", () => {
            element.style.filter = "brightness(1.12)";
            element.style.transform = "translateY(-1px)";
        });
        element.addEventListener("mouseleave", () => {
            element.style.filter = "";
            element.style.transform = "";
        });
    };

    const button = (id: string | null, name: string, icon = false) => {
        const b = document.createElement("button");
        const isSavedCategory = !!id && data.categories.some(category => category.id === id);
        isolateInjectedInteraction(b);
        b.type = "button";
        b.dataset.categoryId = id || "";
        b.setAttribute("aria-pressed", String(selectedCategory === id));
        b.style.cssText = `display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;gap:5px;height:28px;padding:0 10px;box-sizing:border-box;line-height:1;border-radius:14px;border:1px solid ${selectedCategory === id ? "color-mix(in srgb,var(--brand-experiment,#5865f2) 75%,white)" : "var(--background-modifier-accent,rgba(255,255,255,.12))"};background:${selectedCategory === id ? "var(--brand-experiment,#5865f2)" : "var(--background-secondary,#2b2d31)"};color:${selectedCategory === id ? "white" : "var(--text-normal,#dbdee1)"};font-size:12px;font-weight:${selectedCategory === id ? "600" : "500"};white-space:nowrap;cursor:${isSavedCategory ? "grab" : "pointer"};transition:filter 120ms ease,transform 120ms ease,background 120ms ease;`;
        addHoverEffect(b);
        if (icon) b.insertAdjacentHTML("afterbegin", FOLDER_ICON);
        const text = document.createElement("span");
        text.textContent = name;
        b.append(text);
        b.addEventListener("click", () => {
            if (suppressCategoryClick) {
                suppressCategoryClick = false;
                return;
            }
            categoryQuery = "";
            selectedCategory = selectedCategory === id ? null : id;
            // The category view reuses Discord's result scroller, which is
            // unmounted while a search filters everything out. Drop the stale
            // search so opening a category can never show a blank panel.
            if (selectedCategory && clearFavoriteSearch()) {
                const render = (tries: number) => {
                    if (resultContainers()[0] || tries <= 0) {
                        processCards();
                        scheduleScan();
                        return;
                    }
                    window.setTimeout(() => render(tries - 1), 100);
                };
                render(8);
                return;
            }
            processCards();
            scheduleScan();
        });

        if (id) {
            const category = data.categories.find(c => c.id === id);
            if (category) {
                b.title = "Hold and drag to reorder · right-click to delete";
                b.draggable = true;
                b.addEventListener("contextmenu", event => showCategoryMenu(event, category, bar));
                b.addEventListener("dragstart", event => {
                    draggingCategory = true;
                    draggedCategoryId = id;
                    suppressCategoryClick = true;
                    b.style.opacity = "0.45";
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", id);
                    }
                });
                b.addEventListener("dragend", () => {
                    b.style.opacity = "";
                    draggingCategory = false;
                    draggedCategoryId = null;
                    window.setTimeout(() => { suppressCategoryClick = false; }, 350);
                    persistCategoryOrder(bar);
                    scheduleScan();
                });
                b.addEventListener("dragover", event => {
                    if (!draggingCategory) return;
                    event.preventDefault();
                    const sourceId = draggedCategoryId;
                    if (!sourceId || sourceId === id) return;
                    const source = bar.querySelector<HTMLButtonElement>(`button[data-category-id="${CSS.escape(sourceId)}"]`);
                    if (!source) return;
                    const rect = b.getBoundingClientRect();
                    const after = event.clientX > rect.left + rect.width / 2;
                    if (after && b.nextElementSibling !== source) b.insertAdjacentElement("afterend", source);
                    else if (!after && b.previousElementSibling !== source) b.insertAdjacentElement("beforebegin", source);
                });
                b.addEventListener("drop", event => {
                    event.preventDefault();
                    persistCategoryOrder(bar);
                    scheduleScan();
                });
            }
        }
        return b;
    };

    categoryRow.append(button(null, "All"));
    if (hasFeature("mostUsed")) categoryRow.append(button(MOST_USED_CATEGORY, "★ Most Used"));
    if (hasFeature("duplicateFinder") && duplicateGroups.length) {
        const duplicateCount = duplicateGroups.reduce((total, group) => total + group.length - 1, 0);
        categoryRow.append(button(DUPLICATES_CATEGORY, `⚠ Duplicates (${duplicateCount})`));
    }
    for (const category of data.categories) categoryRow.append(button(category.id, category.name, true));

    const add = document.createElement("button");
    isolateInjectedInteraction(add);
    add.type = "button";
    add.textContent = "＋";
    add.title = "Create or manage GIF categories";
    add.setAttribute("aria-label", "Create or manage GIF categories");
    add.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;padding:0;box-sizing:border-box;border-radius:50%;border:1px dashed var(--interactive-muted,#4e5058);background:transparent;color:var(--interactive-normal,#b5bac1);font-size:18px;line-height:1;cursor:pointer;transition:filter 120ms ease,transform 120ms ease;";
    addHoverEffect(add);
    add.addEventListener("click", manageCategories);
    categoryRow.append(add);

    if (hasFeature("duplicateFinder")) {
        const duplicates = document.createElement("button");
        isolateInjectedInteraction(duplicates);
        duplicates.type = "button";
        duplicates.textContent = duplicateGroups.length ? "Rescan Duplicates" : "Find Duplicates";
        duplicates.title = "Find duplicate favorite GIFs and show them side by side";
        duplicates.style.cssText = "height:28px;padding:0 10px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12));border-radius:6px;background:var(--background-secondary,#2b2d31);color:var(--text-normal,#dbdee1);font-size:12px;font-weight:600;cursor:pointer;transition:filter 120ms ease,transform 120ms ease;";
        addHoverEffect(duplicates);
        duplicates.addEventListener("click", showDuplicates);
        actionRow.append(duplicates);

        if (selectedCategory === DUPLICATES_CATEGORY && duplicateGroups.length) {
            const remove = document.createElement("button");
            isolateInjectedInteraction(remove);
            remove.type = "button";
            remove.textContent = "Remove Duplicates";
            remove.title = "Keep the newest copy in each row and remove the others";
            remove.style.cssText = "height:28px;padding:0 10px;border:0;border-radius:6px;background:var(--status-danger,#da373c);color:white;font-size:12px;font-weight:600;cursor:pointer;transition:filter 120ms ease,transform 120ms ease;";
            addHoverEffect(remove);
            remove.addEventListener("click", () => void removeFoundDuplicates());
            actionRow.append(remove);
        }
    }

    if (selectedCategory && hasFeature("randomButton")) {
        const random = document.createElement("button");
        isolateInjectedInteraction(random);
        random.type = "button";
        random.textContent = "🎲 Random";
        random.title = "Send a random GIF from this view";
        random.style.cssText = "height:28px;margin-left:auto;padding:0 10px;border:0;border-radius:6px;background:var(--brand-experiment,#5865f2);color:white;font-size:12px;font-weight:600;cursor:pointer;transition:filter 120ms ease,transform 120ms ease;";
        addHoverEffect(random);
        random.addEventListener("click", () => {
            const matches = categoryItems(selectedCategory!, loadData());
            if (!matches.length) {
                showToast({ text: categoryQuery ? "No GIFs match this search" : "This view has no GIFs yet" } as any);
                return;
            }
            selectCategoryGif(matches[Math.floor(Math.random() * matches.length)]);
        });
        actionRow.append(random);
    }

    // The Favorites title, search field and Bulk Download button share a
    // horizontal flex row. Insert after that whole row, not after the title
    // container, or the search field gets squeezed to make room for folders.
    const headerRow = header.parentElement;
    if (!existingBar && headerRow) headerRow.insertAdjacentElement("afterend", bar);
}

function renderCategoryView(content: HTMLElement, categoryId: string, data: CategoryData) {
    const results = content.querySelector<HTMLElement>('[class*="results__2dc39"]')
        || resultContainers(content)[0]
        || resultContainers()[0];
    if (!results) return;

    const matches = categoryItems(categoryId, data);

    // Reuse Discord's GIF result scroller so its themed scrollbar and wheel
    // handling stay native. Keep the virtualizer mounted (but invisible) so
    // clicks can be forwarded to the real Discord result when it is mounted.
    results.style.display = "";
    const contentEl = resultContent(results);
    if (!contentEl) return;
    const virtualLayer = contentEl.firstElementChild as HTMLElement | null;
    if (virtualLayer) {
        if (!contentEl.dataset.favGifVirtualHeight) contentEl.dataset.favGifVirtualHeight = virtualLayer.style.height;
        virtualLayer.style.visibility = "hidden";
        virtualLayer.style.height = "1px";
        virtualLayer.style.overflow = "hidden";
    }

    let view = contentEl.querySelector<HTMLElement>("[data-fav-gif-category-view]");
    if (!view) {
        contentEl.dataset.favGifNativeHeight = contentEl.style.height || `${contentEl.scrollHeight}px`;
        view = document.createElement("div");
        view.setAttribute("data-fav-gif-category-view", "true");
        contentEl.append(view);
    }

    const listHeight = Math.max(1, Math.ceil(matches.length / 2)) * 272 + 24;
    view.style.cssText = "position:absolute;left:0;right:0;top:0;";
    const renderKey = JSON.stringify({ categoryId, query: categoryQuery, matches: matches.map(m => [m.key, m.src]) });
    if (view.dataset.renderKey === renderKey && view.childElementCount > 0) {
        contentEl.style.height = view.dataset.contentHeight || `${listHeight}px`;
        return;
    }
    contentEl.style.height = `${listHeight}px`;
    view.dataset.renderKey = renderKey;
    view.replaceChildren();

    if (!matches.length) {
        const empty = document.createElement("div");
        empty.textContent = categoryQuery
            ? "No GIFs match this category search."
            : categoryId === MOST_USED_CATEGORY
                ? "No usage yet. GIFs you send will appear here."
                : categoryId === DUPLICATES_CATEGORY
                    ? "No duplicate favorite GIFs found."
                : "No GIFs in this category yet. Right-click a favorite to add one.";
        empty.style.cssText = "grid-column:1/-1;padding:24px 12px;color:var(--text-muted,#949ba4);text-align:center;font-size:13px;";
        view.append(empty);
        return;
    }

    (view as any)._columnTops = [0, 0];
    const classes = pickerClasses();
    const templateFavorite = results.querySelector<HTMLElement>(FAVORITE_BUTTON);
    const templateDownload = results.querySelector<HTMLElement>(DOWNLOAD_BUTTON);
    const downloadSvg = `<svg class="${classes.icon}" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const colWidth = (() => {
        const native = nativeResultCards()[0]?.getBoundingClientRect().width;
        return Math.max(80, native && native > 0 ? native : (results.clientWidth - 36) / 2);
    })();
    const columns = [12, 24 + colWidth];
    const columnTops = [0, 0];
    let duplicateRowTop = 0;
    let duplicateRowHeight = 0;
    for (const [index, item] of matches.entries()) {
        const card = document.createElement("div");
        card.className = classes.card;
        card.title = item.key;
        card.setAttribute("aria-label", "GIF");
        card.setAttribute("role", "button");
        card.tabIndex = -1;
        card.dataset.favGifKey = item.key;

        const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : 1.125;
        const cardHeight = Math.max(80, Math.min(520, colWidth * ratio));
        const duplicateView = categoryId === DUPLICATES_CATEGORY;
        const column = duplicateView ? index % 2 : columnTops[0] <= columnTops[1] ? 0 : 1;
        const top = duplicateView ? duplicateRowTop : columnTops[column];
        card.style.cssText = `position:absolute;left:${columns[column]}px;width:${colWidth}px;top:${top}px;height:${cardHeight}px;overflow:hidden;border-radius:8px;cursor:pointer;`;
        columnTops[column] = top + cardHeight + 12;
        if (duplicateView) {
            duplicateRowHeight = Math.max(duplicateRowHeight, cardHeight);
            if (column === 1 || index === matches.length - 1) {
                duplicateRowTop += duplicateRowHeight + 12;
                duplicateRowHeight = 0;
            }
        }

        const rawSrc = item.src;
        const video = item.format === 2 || /\.(mp4|webm)(?:\?|$)/i.test(rawSrc);
        const media = video ? document.createElement("video") : document.createElement("img");
        media.className = classes.media;
        media.setAttribute("aria-label", "GIF");
        media.style.cssText = "display:block;width:100%;height:100%;object-fit:cover;";
        if (video) {
            const v = media as HTMLVideoElement;
            v.src = rawSrc;
            v.autoplay = true;
            v.muted = true;
            v.loop = true;
            v.playsInline = true;
        } else {
            const image = media as HTMLImageElement;
            image.src = rawSrc;
            image.alt = "";
            image.loading = "lazy";
        }
        card.append(media);

        if (categoryId === MOST_USED_CATEGORY && hasFeature("mostUsed")) {
            const usage = document.createElement("span");
            const count = data.usage[item.key]?.count || 0;
            usage.textContent = `${count} use${count === 1 ? "" : "s"}`;
            usage.style.cssText = "position:absolute;left:6px;bottom:6px;z-index:2;padding:3px 6px;border-radius:8px;background:rgba(0,0,0,.72);color:white;font-size:11px;font-weight:600;pointer-events:none;";
            card.append(usage);
        }

        if (categoryId === DUPLICATES_CATEGORY) {
            const role = document.createElement("span");
            role.textContent = (item as DuplicateItem).duplicateRole;
            role.style.cssText = `position:absolute;left:6px;bottom:6px;z-index:2;padding:3px 6px;border-radius:8px;background:${(item as DuplicateItem).duplicateRole === "Keep" ? "var(--status-positive,#23a55a)" : "var(--status-danger,#da373c)"};color:white;font-size:11px;font-weight:700;pointer-events:none;`;
            card.append(role);
        }

        const favorite = templateFavorite?.cloneNode(true) as HTMLElement || document.createElement("div");
        favorite.className = templateFavorite ? classNameOf(templateFavorite) : classes.favorite;
        favorite.setAttribute("aria-label", "Remove from Favorites");
        favorite.setAttribute("title", "Remove from Favorites");
        favorite.removeAttribute("aria-describedby");
        favorite.setAttribute("role", "button");
        favorite.tabIndex = 0;
        favorite.style.cssText = "position:absolute;top:4px;right:4px;z-index:2;";
        if (!favorite.querySelector("svg")) favorite.innerHTML = `<svg class="${classes.icon}" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10.81 2.86c.38-1.15 2-1.15 2.38 0l1.89 5.83h6.12c1.2 0 1.71 1.54.73 2.25l-4.95 3.6 1.9 5.82a1.25 1.25 0 0 1-1.93 1.4L12 18.16l-4.95 3.6c-.98.7-2.3-.25-1.92-1.4l1.89-5.82-4.95-3.6a1.25 1.25 0 0 1 .73-2.25h6.12l1.9-5.83Z"/></svg>`;

        const download = templateDownload?.cloneNode(true) as HTMLElement || favorite.cloneNode(true) as HTMLElement;
        download.className = classes.download;
        download.setAttribute("aria-label", "Download GIF");
        download.setAttribute("title", "Download GIF");
        download.removeAttribute("aria-describedby");
        download.setAttribute("role", "button");
        download.tabIndex = 0;
        download.dataset.favGifDownload = "true";
        download.style.cssText = "position:absolute;top:4px;right:40px;z-index:2;";
        const downloadIcon = download.querySelector("svg");
        if (downloadIcon) downloadIcon.outerHTML = downloadSvg;
        else download.insertAdjacentHTML("afterbegin", downloadSvg);

        card.addEventListener("click", event => {
            if (event.target === favorite || event.target === download || favorite.contains(event.target as Node) || download.contains(event.target as Node)) return;
            event.preventDefault();
            // This category tile is mounted inside Discord's result scroller
            // and intentionally shares its result class for styling. Keep the
            // synthetic tile click from reaching Discord's delegated picker
            // handlers; only the forwarded click on the real native result
            // should be interpreted as selecting/sending a GIF.
            event.stopPropagation();
            selectCategoryGif(item);
        });
        favorite.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            void activateNativeResult(item.key, FAVORITE_BUTTON);
        });
        download.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            downloadCategoryGif(item);
        });
        card.append(download, favorite);
        view.append(card);
    }
    contentEl.style.height = `${Math.max(columnTops[0], columnTops[1]) + 12}px`;
    view.dataset.contentHeight = contentEl.style.height;
}

function processCards() {
    if (categoryActivationInProgress) return;
    const cards = nativeResultCards();
    const inFavorites = isFavoritesView();

    // The same result-card class is used by normal GIF search. Never apply a
    // saved-favorites category filter outside the Favorites page, and reset
    // the filter on leaving Favorites so the user isn't left with a blank GIF
    // search or a hidden back/navigation flow.
    if (!inFavorites) {
        selectedCategory = null;
        categoryQuery = "";
        duplicateGroups = [];
        restoreCategoryView();
        clearTemporaryHides(cards);
        return;
    }

    const data = loadData();

    if (selectedCategory) {
        renderCategoryView(document.body, selectedCategory, data);
        return;
    }

    restoreCategoryView();
    clearTemporaryHides(cards);

    for (const card of cards) {
        const key = cardKey(card, cards);
        (card as HTMLElement).dataset.favGifCategoryKey = key || "";
    }
}

/**
 * Earlier versions forced display:"" on every native card, which un-hid cards
 * Discord's virtualizer had deliberately hidden. Those cards are absolutely
 * positioned, so un-hiding them stacks GIFs on top of each other. Only undo
 * hides this plugin actually applied.
 */
function clearTemporaryHides(cards: HTMLElement[]) {
    for (const card of cards) {
        if (card.dataset.favGifHidden !== "true") continue;
        card.style.display = "";
        delete card.dataset.favGifHidden;
    }
}

function restoreCategoryView() {
    document.querySelectorAll<HTMLElement>("[data-fav-gif-category-view]").forEach(view => {
        const contentEl = view.parentElement;
        const results = contentEl?.parentElement as HTMLElement | null;
        view.remove();
        if (contentEl) {
            contentEl.style.height = contentEl.dataset.favGifNativeHeight || "";
            delete contentEl.dataset.favGifNativeHeight;
            const virtualLayer = contentEl.firstElementChild as HTMLElement | null;
            if (virtualLayer) {
                virtualLayer.style.visibility = "";
                virtualLayer.style.height = contentEl.dataset.favGifVirtualHeight || "";
                virtualLayer.style.overflow = "";
            }
            delete contentEl.dataset.favGifVirtualHeight;
        }
        if (results) results.style.display = "";
    });
}

function closestPickerCard(target: Element): HTMLElement | null {
    const synthetic = target.closest<HTMLElement>("[data-fav-gif-key]");
    if (synthetic) return synthetic;

    const card = nativeResultCards().find(candidate => candidate.contains(target));
    if (card) return card;

    // Fallback for the very first context menu before a scan has run.
    const candidate = target.closest<HTMLElement>(PICKER_CARD_PATTERN);
    return candidate && isPickerCard(candidate) ? candidate : null;
}

function onContextMenu(event: MouseEvent) {
    const target = event.target as Element | null;
    if (!target) return;
    const card = closestPickerCard(target);
    if (!card) return;
    showContextMenu(event, card, nativeResultCards());
}

function onPickerClick(event: MouseEvent) {
    if (!hasFeature("mostUsed") || categoryActivationInProgress || !isFavoritesView()) return;
    const target = event.target as Element | null;
    if (!target || target.closest(FAVORITE_BUTTON) || target.closest(DOWNLOAD_BUTTON)) return;
    const card = closestPickerCard(target);
    if (!card || card.dataset.favGifKey) return; // Synthetic category clicks record themselves.
    const cards = nativeResultCards();
    const key = cardKey(card, cards);
    if (key) noteGifUsed(storedKeyFor(card, key));
}

function scan() {
    renderCategoryBar();
    processCards();
}

function scheduleScan() {
    if (scanTimer != null) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = null;
        scan();
    }, 200);
}

export default definePlugin({
    name: "GIF Categories",
    description: "Right-click GIF favorites to organize them into persistent categories shown at the top of the Favorites picker.",
    authors: [Devs.UnknownDevelopment],
    tags: ["Emotes", "Utility"],
    settings,
    enabledByDefault: true,
    patches: [{
        find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
        replacement: {
            // Capture the GIF callback from the same picker body expression
            // used by Favorite Anything; the simpler property-only match can
            // miss this callback in Discord's minified component.
            match: /\{onSelectGIF:(\i),[^}]{20,40}\}\):null,(?=(\i)===)/,
            replace: "$&$self.captureGifSelector($1),"
        }
    }],
    captureGifSelector(callback: (gif: { url: string; [key: string]: any; }) => void) {
        nativeGifSelector = callback;
        return callback;
    },
    start() {
        migrateLegacySettings();
        scan();
        document.addEventListener("click", onPickerClick, true);
        document.addEventListener("contextmenu", onContextMenu, true);
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
    },
    stop() {
        nativeGifSelector = null;
        observer?.disconnect();
        observer = null;
        document.removeEventListener("click", onPickerClick, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        if (scanTimer != null) clearTimeout(scanTimer);
        scanTimer = null;
        closeMenu();
        closeDialog();
        document.querySelectorAll(HEADER_MARK).forEach(el => el.remove());
        restoreCategoryView();
        clearTemporaryHides(pickerCards(document));
        document.querySelectorAll<HTMLElement>("[data-fav-gif-category-key]").forEach(card => {
            delete card.dataset.favGifCategoryKey;
        });
        selectedCategory = null;
        categoryQuery = "";
        duplicateGroups = [];
        favoriteSearchInputs().forEach(input => configureCategorySearch(input, loadData()));
    }
});
