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
type CategoryData = { categories: Category[]; assignments: Record<string, string[]> };

const PICKER_CARD = ".result__2dc39";
const FAVORITE_BUTTON = '[aria-label="Remove from Favorites"]';
const HEADER_MARK = "[data-fav-gif-category-bar]";
const FOLDER_ICON = "<svg aria-hidden=\"true\" width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M10 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H12l-2-2Z\"/></svg>";
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
        return {
            categories: Array.isArray(parsed.categories) ? parsed.categories.filter((c: any) => c && typeof c.id === "string" && typeof c.name === "string") : [],
            assignments: parsed.assignments && typeof parsed.assignments === "object" ? parsed.assignments : {}
        };
    } catch {
        return { categories: [], assignments: {} };
    }
}

function saveData(data: CategoryData) {
    settings.store.data = JSON.stringify(data);
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

        for (const item of importedItems) {
            const key = actualKeyByImportedKey.get(item.key) || canonicalKey(item.key);
            const categories = (Array.isArray(item.categories) ? item.categories : [])
                .map(id => categoryIdMap.get(id))
                .filter((id): id is string => !!id);
            if (categories.length) data.assignments[key] = [...new Set([...(data.assignments[key] || []), ...categories])];
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
    const direct = cardMediaUrl(card);
    if (direct) return canonicalKey(direct);

    // Discord sometimes keeps the real media URL outside the visible image.
    // Its picker order matches favoriteGifs.order, so use that as a fallback.
    const index = cards.indexOf(card);
    return favoriteKeysInOrder()[index] || null;
}

function nativeResultCards(): HTMLElement[] {
    const results = document.querySelector<HTMLElement>('[class*="results__2dc39"]');
    const content = results?.querySelector<HTMLElement>('[class*="content__99f8c"]');
    const layer = content?.firstElementChild;
    return layer ? Array.from(layer.querySelectorAll<HTMLElement>(PICKER_CARD)) : [];
}

function selectCategoryGif(item: { src: string; format: number; width: number; height: number; key: string; }) {
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

async function activateNativeResult(key: string, targetSelector = PICKER_CARD) {
    const results = document.querySelector<HTMLElement>('[class*="results__2dc39"]');
    const contentEl = results?.querySelector<HTMLElement>('[class*="content__99f8c"]');
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
        results.scrollTop = Math.max(0, Math.floor(Math.max(0, index) / 2) * 272);
        results.dispatchEvent(new Event("scroll"));
        await new Promise(resolve => setTimeout(resolve, 350));
        const cards = Array.from(virtualLayer.querySelectorAll<HTMLElement>(PICKER_CARD));
        const native = cards.find(candidate => cardKey(candidate, cards) === key);
        const target = native?.querySelector<HTMLElement>(targetSelector) ?? (targetSelector === PICKER_CARD ? native : null);
        if (!target) return false;
        target.click();
        return true;
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

function showContextMenu(event: MouseEvent, card: Element, cards: Element[]) {
    const key = cardKey(card, cards);
    if (!key) return;

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
        menu.append(menuButton(category.name, () => {
            const next = loadData();
            const ids = new Set(next.assignments[key] || []);
            if (ids.has(category.id)) ids.delete(category.id);
            else ids.add(category.id);
            if (ids.size) next.assignments[key] = [...ids];
            else delete next.assignments[key];
            saveData(next);
            closeMenu();
            scheduleScan();
        }, assigned.has(category.id)));
    }

    menu.append(menuButton("＋  New category…", () => {
        closeMenu();
        createCategory(id => {
            const next = loadData();
            next.assignments[key] = [...new Set([...(next.assignments[key] || []), id])];
            saveData(next);
            scheduleScan();
        });
    }));

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
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Search Favorites"]');
    if (!input) return;

    // React may replace the favorites header while leaving the injected bar
    // behind. Keep one bar for the entire picker, not one per refresh.
    const existingBars = Array.from(document.querySelectorAll<HTMLElement>(HEADER_MARK));
    existingBars.slice(1).forEach(bar => bar.remove());
    const data = loadData();
    const renderKey = JSON.stringify({ categories: data.categories, selectedCategory });
    const existingBar = existingBars[0];
    if (existingBar?.dataset.renderKey === renderKey) return;

    let header: HTMLElement | null = input.parentElement;
    while (header && !/favoritesHeader/i.test(header.className || "")) header = header.parentElement;
    if (!header) return;

    const bar = existingBar || document.createElement("div");
    if (!existingBar) bar.setAttribute("data-fav-gif-category-bar", "true");
    bar.replaceChildren();
    bar.dataset.renderKey = renderKey;
    bar.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:0 0 100%;align-self:stretch;width:100%;min-width:0;padding:8px 12px 4px;box-sizing:border-box;";

    const button = (id: string | null, name: string, icon = false) => {
        const b = document.createElement("button");
        isolateInjectedInteraction(b);
        b.type = "button";
        b.dataset.categoryId = id || "";
        b.style.cssText = `display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 9px;line-height:1;border-radius:14px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12));background:${selectedCategory === id ? "var(--brand-experiment,#5865f2)" : "var(--background-secondary,#2b2d31)"};color:var(--text-normal,#dbdee1);font-size:12px;cursor:${id ? "grab" : "pointer"};`;
        if (icon) b.insertAdjacentHTML("afterbegin", FOLDER_ICON);
        const text = document.createElement("span");
        text.textContent = name;
        b.append(text);
        b.addEventListener("click", () => {
            if (suppressCategoryClick) {
                suppressCategoryClick = false;
                return;
            }
            selectedCategory = selectedCategory === id ? null : id;
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

    bar.append(button(null, "All"));
    for (const category of data.categories) bar.append(button(category.id, category.name, true));

    const add = document.createElement("button");
    isolateInjectedInteraction(add);
    add.type = "button";
    add.textContent = "＋";
    add.title = "Create or manage GIF categories";
    add.setAttribute("aria-label", "Create or manage GIF categories");
    add.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:0 0 26px;width:26px;height:26px;padding:0;box-sizing:border-box;border-radius:50%;border:0;background:var(--background-secondary,#2b2d31);color:var(--text-normal,#dbdee1);font-size:18px;line-height:1;cursor:pointer;";
    add.addEventListener("click", manageCategories);
    bar.append(add);

    // The Favorites title, search field and Bulk Download button share a
    // horizontal flex row. Insert after that whole row, not after the title
    // container, or the search field gets squeezed to make room for folders.
    const headerRow = header.parentElement;
    if (!existingBar && headerRow) headerRow.insertAdjacentElement("afterend", bar);
}

function renderCategoryView(content: HTMLElement, categoryId: string, data: CategoryData) {
    const results = content.querySelector<HTMLElement>('[class*="results__2dc39"]')
        || document.querySelector<HTMLElement>('[class*="results__2dc39"]');
    if (!results) return;

    const matches: Array<{ key: string; src: string; format: number; width: number; height: number }> = [];
    try {
        const gifs = (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators.getCurrentValue()?.favoriteGifs?.gifs || {};
        for (const [key, gif] of Object.entries(gifs) as Array<[string, any]>) {
            const canonical = canonicalKey(key);
            if (!(data.assignments[canonical] || []).includes(categoryId)) continue;
            matches.push({
                key: canonical,
                src: typeof gif?.src === "string" && gif.src ? gif.src : key,
                format: Number(gif?.format) || 1,
                width: Number(gif?.width) || 0,
                height: Number(gif?.height) || 0
            });
        }
    } catch (error) {
        console.error("[FavoriteGifCategories] Failed to read favorites", error);
    }

    // Reuse Discord's GIF result scroller so its themed scrollbar and wheel
    // handling stay native. Keep the virtualizer mounted (but invisible) so
    // clicks can be forwarded to the real Discord result when it is mounted.
    results.style.display = "";
    const contentEl = results.querySelector<HTMLElement>('[class*="content__99f8c"]');
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
    contentEl.style.height = `${listHeight}px`;
    view.style.cssText = "position:absolute;left:0;right:0;top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:261px;align-content:start;gap:10px;padding:0 12px 12px;box-sizing:border-box;";
    const renderKey = JSON.stringify({ categoryId, matches: matches.map(m => [m.key, m.src]) });
    if (view.dataset.renderKey === renderKey && view.childElementCount > 0) return;
    view.dataset.renderKey = renderKey;
    view.replaceChildren();

    if (!matches.length) {
        const empty = document.createElement("div");
        empty.textContent = "No GIFs in this category yet. Right-click a favorite to add one.";
        empty.style.cssText = "grid-column:1/-1;padding:24px 12px;color:var(--text-muted,#949ba4);text-align:center;font-size:13px;";
        view.append(empty);
        return;
    }

    (view as any)._columnTops = [0, 0];
    const colWidth = Math.max(80, (results.clientWidth - 36) / 2);
    const columns = [12, 24 + colWidth];
    const columnTops = [0, 0];
    for (const item of matches) {
        const card = document.createElement("div");
        card.className = "result__2dc39";
        card.title = item.key;
        card.setAttribute("aria-label", "file");
        card.setAttribute("role", "button");
        card.tabIndex = -1;

        const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : 1.125;
        const cardHeight = Math.max(80, Math.min(520, colWidth * ratio));
        const column = columnTops[0] <= columnTops[1] ? 0 : 1;
        card.style.cssText = `position:absolute;left:${columns[column]}px;width:${colWidth}px;top:${columnTops[column]}px;height:${cardHeight}px;overflow:hidden;border-radius:8px;cursor:pointer;`;
        columnTops[column] += cardHeight + 12;

        const rawSrc = item.src;
        const video = item.format === 2 || /\.(mp4|webm)(?:\?|$)/i.test(rawSrc);
        const media = video ? document.createElement("video") : document.createElement("img");
        media.className = "gif__2dc39";
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

        const nativeFavorite = results.querySelector<HTMLElement>(FAVORITE_BUTTON);
        const favorite = nativeFavorite?.cloneNode(true) as HTMLElement || document.createElement("div");
        favorite.className = "favButton__2dc39 gifFavoriteButton__43deb selected__43deb";
        favorite.setAttribute("aria-label", "Remove from Favorites");
        favorite.setAttribute("role", "button");
        favorite.tabIndex = 0;
        favorite.style.cssText = "position:absolute;top:4px;right:4px;z-index:2;";
        if (!favorite.querySelector("svg")) favorite.innerHTML = "<svg class=\"icon__43deb\" aria-hidden=\"true\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M10.81 2.86c.38-1.15 2-1.15 2.38 0l1.89 5.83h6.12c1.2 0 1.71 1.54.73 2.25l-4.95 3.6 1.9 5.82a1.25 1.25 0 0 1-1.93 1.4L12 18.16l-4.95 3.6c-.98.7-2.3-.25-1.92-1.4l1.89-5.82-4.95-3.6a1.25 1.25 0 0 1 .73-2.25h6.12l1.9-5.83Z\"/></svg>";

        const nativeDownload = results.querySelector<HTMLElement>('[aria-label="Download GIF"]');
        const download = nativeDownload?.cloneNode(true) as HTMLElement || favorite.cloneNode(true) as HTMLElement;
        download.className = "favButton__2dc39 gifFavoriteButton__43deb";
        download.setAttribute("aria-label", "Download GIF");
        download.setAttribute("role", "button");
        download.tabIndex = 0;
        download.style.cssText = "position:absolute;top:4px;right:40px;z-index:2;";
        const downloadIcon = download.querySelector("svg");
        if (downloadIcon) downloadIcon.outerHTML = "<svg class=\"icon__43deb\" aria-hidden=\"true\" width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M12 3v12m0 0 4-4m-4 4-4-4M5 21h14\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>";

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
        const forwardControl = (control: HTMLElement, selector: string) => control.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            void activateNativeResult(item.key, selector);
        });
        forwardControl(favorite, FAVORITE_BUTTON);
        forwardControl(download, '[aria-label="Download GIF"]');
        card.append(download, favorite);
        view.append(card);
    }
    contentEl.style.height = `${Math.max(columnTops[0], columnTops[1]) + 12}px`;
}

function processCards() {
    if (categoryActivationInProgress) return;
    const cards = nativeResultCards();
    const inFavorites = !!document.querySelector('input[placeholder="Search Favorites"]');

    // The same result-card class is used by normal GIF search. Never apply a
    // saved-favorites category filter outside the Favorites page, and reset
    // the filter on leaving Favorites so the user isn't left with a blank GIF
    // search or a hidden back/navigation flow.
    if (!inFavorites) {
        selectedCategory = null;
        for (const card of cards) (card as HTMLElement).style.display = "";
        restoreCategoryView();
        document.querySelectorAll<HTMLElement>('[class*="results__2dc39"]').forEach(results => { results.style.display = ""; });
        return;
    }

    const data = loadData();

    if (selectedCategory) {
        for (const card of cards) (card as HTMLElement).style.display = "none";
        renderCategoryView(document.body, selectedCategory, data);
        return;
    }

    restoreCategoryView();
    document.querySelectorAll<HTMLElement>('[class*="results__2dc39"]').forEach(results => { results.style.display = ""; });

    for (const card of cards) {
        const key = cardKey(card, cards);
        const isInCategory = !!key && (data.assignments[key] || []).includes(selectedCategory || "");
        const hasCategory = !!selectedCategory && isInCategory;
        (card as HTMLElement).style.display = !selectedCategory || hasCategory ? "" : "none";
        (card as HTMLElement).dataset.favGifCategoryKey = key || "";
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

function onContextMenu(event: MouseEvent) {
    const target = event.target as Element | null;
    if (!target) return;
    const card = target.closest(PICKER_CARD);
    if (!card || !card.querySelector(FAVORITE_BUTTON)) return;
    const cards = nativeResultCards();
    showContextMenu(event, card, cards);
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
        document.addEventListener("contextmenu", onContextMenu, true);
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
    },
    stop() {
        nativeGifSelector = null;
        observer?.disconnect();
        observer = null;
        document.removeEventListener("contextmenu", onContextMenu, true);
        if (scanTimer != null) clearTimeout(scanTimer);
        scanTimer = null;
        closeMenu();
        closeDialog();
        document.querySelectorAll(HEADER_MARK).forEach(el => el.remove());
        document.querySelectorAll<HTMLElement>(PICKER_CARD).forEach(card => {
            card.style.display = "";
            delete card.dataset.favGifCategoryKey;
        });
        selectedCategory = null;
    }
});
