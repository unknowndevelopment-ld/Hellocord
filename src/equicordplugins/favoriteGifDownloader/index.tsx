/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin, { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { showToast, UserSettingsActionCreators } from "@webpack/common";
import { applyPalette, GIFEncoder, quantize } from "gifenc";

const Native = VencordNative.pluginHelpers["GIF Downloader"] as PluginNative<typeof import("./native")>;

const DOWNLOAD_ICON = "<svg class=\"icon__43deb\" aria-hidden=\"true\" role=\"img\" xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" fill=\"none\" viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M12 3v12m0 0 4-4m-4 4-4-4M5 21h14\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>";

let downloadCounter = 1;

function getFavoriteGifUrls(): string[] {
    try {
        const { gifs } = (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators.getCurrentValue().favoriteGifs;
        const entries = Object.values(gifs) as any[];
        // Sort by stored order descending to match the picker's
        // most-recently-favorited-first (top-to-bottom) display.
        entries.sort((a: any, b: any) => (b?.order ?? 0) - (a?.order ?? 0));
        const urls = entries
            .map((g: any) => g?.src || g?.url)
            .filter((u: any) => typeof u === "string" && u.length > 0);
        // Deduplicate while keeping the display order.
        return Array.from(new Set(urls));
    } catch (e) {
        console.error("[FavoriteGifDownloader] getFavoriteGifUrls failed", e);
        return [];
    }
}

/**
 * Discord proxies external media (tenor, klipy) through
 * images-ext-*.discordapp.net/external/<hash>/https/<real url>. The proxy URL
 * rejects renderer fetches (no CORS headers), so unwrap it and go to the source.
 */
function unwrapProxy(url: string): string {
    const match = url.match(/^https?:\/\/images-ext-\d+\.discordapp\.net\/external\/[^/]+\/(https?\/.+)$/i);
    if (!match) return url;
    const rest = match[1];
    if (rest.startsWith("https/")) return "https://" + rest.slice(6);
    if (rest.startsWith("http/")) return "http://" + rest.slice(5);
    return url;
}

/**
 * Turns a favorited tenor/klipy/discord URL into a URL for the actual
 * animated GIF where one exists.
 */
function resolveGifUrl(raw: string): string {
    const url = unwrapProxy(raw || "");
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        if (host === "media.tenor.com" || host.endsWith(".tenor.com")) {
            // Tenor gives the same item an mp4 under an "AAAPo" id suffix and
            // an animated GIF under "AAAAC".
            parsed.search = "";
            parsed.pathname = parsed.pathname
                .replace(/\.mp4$/i, ".gif")
                .replace(/AAAPo(?=\/)/, "AAAAC");
            return parsed.toString();
        }

        if (host === "klipy.com" || host.endsWith(".klipy.com")) {
            // Klipy has no GIF rendition: "/name.gif", "/name.mp4" and
            // "/name.webm" are all a "content no longer available" placeholder.
            // The animated webp on the original URL is the real media, so keep
            // it as-is and convert it to GIF locally.
            return parsed.toString();
        }

        if (host.endsWith("discordapp.net") || host.endsWith("discordapp.com")) {
            // Discord transcodes GIFs to webp when "format=webp" is requested.
            if (parsed.searchParams.get("format") === "webp") {
                parsed.searchParams.delete("format");
                parsed.searchParams.delete("animated");
                return parsed.toString();
            }
        }
    } catch { }
    return url;
}

function isKlipyUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "klipy.com" || host.endsWith(".klipy.com");
    } catch {
        return false;
    }
}

/**
 * Klipy only serves animated webp ("/name.gif" is a placeholder), so the frames
 * are decoded with WebCodecs and re-encoded into a genuine GIF locally.
 */
async function webpToGif(data: ArrayBuffer, mimeType = "image/webp"): Promise<Uint8Array> {
    const ImageDecoderCtor = (globalThis as any).ImageDecoder;
    if (typeof ImageDecoderCtor !== "function") throw new Error("ImageDecoder is unavailable");

    const decoder = new ImageDecoderCtor({ data, type: mimeType });
    await decoder.tracks.ready;
    await decoder.completed;

    const track = decoder.tracks.selectedTrack;
    const frameCount: number = Math.max(1, track?.frameCount ?? 1);

    const first = await decoder.decode({ frameIndex: 0 });
    const width: number = first.image.displayWidth;
    const height: number = first.image.displayHeight;
    first.image.close();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");

    // Sample a few frames for the shared palette, bounded by total pixels so
    // big stickers do not blow up memory.
    const pixels = Math.max(1, width * height);
    const sampleCount = Math.min(frameCount, 24, Math.max(4, Math.floor(4_000_000 / pixels)));
    const frameLen = pixels * 4;
    const samples = new Uint8ClampedArray(sampleCount * frameLen);
    for (let i = 0; i < sampleCount; i++) {
        const frameIndex = Math.floor((i * frameCount) / sampleCount);
        const { image } = await decoder.decode({ frameIndex });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        samples.set(ctx.getImageData(0, 0, width, height).data, i * frameLen);
        image.close();
    }

    const palette = quantize(samples, 256);
    const gif = GIFEncoder();

    for (let i = 0; i < frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        const frame = ctx.getImageData(0, 0, width, height).data;
        const delay = Math.max(20, Math.round((image.duration || 100_000) / 1000));
        image.close();

        gif.writeFrame(applyPalette(frame, palette), width, height, {
            palette: i === 0 ? palette : undefined,
            delay
        });

        if (i % 10 === 9) await new Promise(resolve => setTimeout(resolve, 0));
    }

    gif.finish();
    return gif.bytes();
}

type MediaKind = "webp" | "avif" | "gif" | "png" | "jpg" | "mp4" | "other";

function sniffMedia(data: ArrayBuffer): MediaKind {
    const d = new Uint8Array(data, 0, Math.min(data.byteLength, 16));
    if (d.length >= 12) {
        if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 &&
            d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return "webp";
        if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) return "gif";
        if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4E && d[3] === 0x47) return "png";
        if (d[0] === 0xFF && d[1] === 0xD8) return "jpg";
        if (d[4] === 0x66 && d[5] === 0x74 && d[6] === 0x79 && d[7] === 0x70) {
            // ISO BMFF container: "avif"/"avis" brands are AVIF, everything else video.
            const brand = String.fromCharCode(d[8], d[9], d[10], d[11]);
            return brand.startsWith("avi") ? "avif" : "mp4";
        }
    }
    return "other";
}

/**
 * True when the URL most likely serves WebP/AVIF rather than a ready-made GIF.
 * Those have to be decoded and re-encoded locally to get a real .gif file.
 */
function needsConversion(url: string): boolean {
    if (isKlipyUrl(url)) return true;
    try {
        const parsed = new URL(url);
        if (/\.(webp|avif)$/i.test(parsed.pathname)) return true;
        return parsed.searchParams.get("animated") === "true";
    } catch {
        return false;
    }
}

async function saveGifFile(baseName: string, url: string): Promise<string> {
    const resolved = resolveGifUrl(url);
    if (IS_DISCORD_DESKTOP) await Native.getDownloadDirectory();

    if (IS_DISCORD_DESKTOP && needsConversion(resolved)) {
        try {
            // Main-process fetch, so discord proxies and CORS cannot block us.
            const { data, contentType } = await Native.fetchBytes(resolved);
            const kind = sniffMedia(data);

            if (kind === "webp" || kind === "avif") {
                const bytes = await webpToGif(
                    data,
                    kind === "avif" ? (contentType.includes("avif") ? contentType : "image/avif") : "image/webp"
                );
                return await Native.saveGifBytes(`${baseName}.gif`, bytes);
            }

            // Not convertible (mp4/webm/png...): keep the original bytes.
            const ext = kind === "other" ? "bin" : kind;
            return await Native.saveGifBytes(`${baseName}.${ext}`, new Uint8Array(data));
        } catch (error) {
            console.warn("[FavoriteGifDownloader] conversion failed, saving original", error);
        }
    }

    if (IS_DISCORD_DESKTOP) {
        // Download in the main process so CORS/CSP never block tenor or klipy.
        return await Native.saveGifFromUrl(baseName, resolved);
    }

    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    const kind = sniffMedia(data);

    if (kind === "webp" || kind === "avif") {
        const bytes = await webpToGif(data, kind === "webp" ? "image/webp" : "image/avif");
        saveFile(new File([bytes as BlobPart], `${baseName}.gif`, { type: "image/gif" }));
        return `${baseName}.gif`;
    }

    const ext = kind === "other" ? "bin" : kind;
    saveFile(new File([data], `${baseName}.${ext}`, { type: response.headers.get("content-type") || "application/octet-stream" }));
    return `${baseName}.${ext}`;
}

async function downloadGif(url: string) {
    if (!url) return;
    const number = downloadCounter;
    try {
        const savedPath = await saveGifFile(`${number}`, url);
        downloadCounter++;
        showToast({ text: `GIF saved${IS_DISCORD_DESKTOP ? ` to ${savedPath}` : ""}`, variant: "success" } as any);
    } catch (error) {
        console.error("[FavoriteGifDownloader] Failed to download GIF", url, error);
        showToast({ text: `GIF download failed: ${String(error)}`, variant: "critical" } as any);
    }
}

function promptNumber(max: number): Promise<string | null> {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;";

        const box = document.createElement("div");
        box.style.cssText = "background:#313338;padding:16px;border-radius:8px;color:white;min-width:260px;box-shadow:0 4px 20px rgba(0,0,0,0.5);";

        const label = document.createElement("div");
        label.textContent = `How many favorite GIFs to download? (1-${max})`;
        label.style.cssText = "margin-bottom:8px;font-size:14px;";

        const input = document.createElement("input");
        input.type = "number";
        input.value = "10";
        input.min = "1";
        input.max = String(max);
        input.style.cssText = "width:100%;padding:8px;margin-bottom:12px;border-radius:4px;border:none;box-sizing:border-box;";

        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.style.cssText = "padding:6px 12px;border-radius:4px;border:none;background:#4e5058;color:white;cursor:pointer;";

        const ok = document.createElement("button");
        ok.textContent = "Download";
        ok.style.cssText = "padding:6px 12px;border-radius:4px;border:none;background:#5865f2;color:white;cursor:pointer;";

        const cleanup = () => overlay.remove();

        cancel.onclick = () => { cleanup(); resolve(null); };
        ok.onclick = () => { cleanup(); resolve(input.value); };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") { cleanup(); resolve(input.value); }
            if (e.key === "Escape") { cleanup(); resolve(null); }
        });

        row.append(cancel, ok);
        box.append(label, input, row);
        overlay.append(box);
        document.body.append(overlay);
        input.focus();
        input.select();
    });
}

async function bulkDownload() {
    const urls = getFavoriteGifUrls();
    if (!urls.length) {
        showToast({ text: "No favorite GIFs were found to download.", variant: "critical" } as any);
        return;
    }

    try {
        const directory = IS_DISCORD_DESKTOP ? await Native.getDownloadDirectory() : null;
        const input = await promptNumber(urls.length);
        if (input === null) return;
        const n = Math.min(urls.length, Math.max(1, parseInt(input, 10) || 0));
        if (!n) return;

        let savedCount = 0;
        let failedCount = 0;
        for (let i = 0; i < n; i++) {
            try {
                await saveGifFile(`${savedCount + 1}`, urls[i]);
                savedCount++;
            } catch (error) {
                failedCount++;
                console.error("[FavoriteGifDownloader] Failed to download GIF in bulk", urls[i], error);
            }
        }
        const location = directory ? ` Saved to ${directory}.` : " Check your browser's download location.";
        showToast({ text: `Bulk download finished: ${savedCount} saved, ${failedCount} failed.${location}`, variant: failedCount ? "critical" : "success" } as any);
    } catch (error) {
        console.error("[FavoriteGifDownloader] Bulk download failed", error);
        showToast({ text: `Bulk download failed: ${String(error)}`, variant: "critical" } as any);
    }
}

/**
 * Find the media (img or video) associated with a favorite button without
 * climbing too far up (which could grab an unrelated image such as a server
 * icon). Tenor/klipy favorites render as <video>.
 */
function findGifMediaUrl(btn: Element): string | null {
    const selectors = [
        '[class*="imageContainer"]',
        '[class*="imageWrapper"]',
        '[class*="result"]',
        '[class*="media"]',
        '[class*="embed"]',
    ];
    const containers: Element[] = [];
    for (const sel of selectors) {
        const c = btn.closest(sel);
        if (c) containers.push(c);
    }
    let container: HTMLElement | null = btn.parentElement;
    for (let i = 0; i < 5 && container; i++) {
        containers.push(container);
        container = container.parentElement;
    }

    for (const c of containers) {
        const video = c.querySelector("video");
        if (video && video.src) return video.src;
        const img = c.querySelector("img");
        if (img && img.src) return img.src;
    }
    return null;
}

function processSingleButtons(root: ParentNode | null) {
    if (!root || !root.querySelectorAll) return;
    // React recycles and re-creates picker nodes, so the star button itself can
    // be the node that was added (and would not be found by querySelectorAll).
    const favButtons: Element[] = [];
    if (root instanceof Element && root.matches('[aria-label="Remove from Favorites"]')) favButtons.push(root);
    favButtons.push(...root.querySelectorAll('[aria-label="Remove from Favorites"]'));
    favButtons.forEach(favBtn => {
        const result = favBtn.parentElement;
        if (!result) return;
        if (result.querySelector('[aria-label="Download GIF"]')) return;

        const mediaUrl = findGifMediaUrl(favBtn as Element);
        if (!mediaUrl) return;

        try {
            const dlBtn = favBtn.cloneNode(true) as HTMLElement;
            dlBtn.setAttribute("aria-label", "Download GIF");
            dlBtn.className = dlBtn.className
                .split(/\s+/)
                .filter(c => !/selected/i.test(c))
                .join(" ");
            const svg = dlBtn.querySelector("svg");
            if (svg) svg.outerHTML = DOWNLOAD_ICON;

            // Keep the button from overlapping the favorite button when it is
            // absolutely positioned (e.g. inside the GIF picker).
            const computed = window.getComputedStyle(favBtn as Element);
            if (computed.position !== "static") {
                (dlBtn as HTMLElement).style.position = computed.position;
                (dlBtn as HTMLElement).style.top = computed.top;
                const right = (parseInt(computed.right, 10) || 0) + (favBtn as HTMLElement).offsetWidth + 4;
                (dlBtn as HTMLElement).style.right = `${right}px`;
            }

            dlBtn.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                // Discord recycles picker result nodes, so the URL captured when
                // this button was created can belong to a previously displayed
                // GIF. Re-resolve it from the live DOM at click time.
                downloadGif(findGifMediaUrl(dlBtn) ?? mediaUrl);
            });

            favBtn.insertAdjacentElement("afterend", dlBtn);
        } catch (error) {
            console.error("[FavoriteGifDownloader] Failed to insert download button", error);
        }
    });
}

function processBulkButton(root: ParentNode | null) {
    if (!root || !root.querySelectorAll) return;
    const inputs = root.querySelectorAll('input[placeholder="Search Favorites"]');
    inputs.forEach(input => {
        let header: HTMLElement | null = input.parentElement;
        while (header && !/favoritesHeader/i.test(header.className || "")) {
            header = header.parentElement;
        }
        if (!header || header.querySelector("[data-fav-bulk]")) return;

        const btn = document.createElement("button");
        btn.setAttribute("data-fav-bulk", "true");
        btn.textContent = "Bulk Download";
        btn.style.marginLeft = "8px";
        btn.style.padding = "4px 8px";
        btn.style.borderRadius = "4px";
        btn.style.border = "none";
        btn.style.background = "var(--brand-experiment, #5865f2)";
        btn.style.color = "white";
        btn.style.cursor = "pointer";
        btn.style.fontSize = "12px";
        btn.addEventListener("click", () => {
            void bulkDownload();
        });

        header.appendChild(btn);
    });
}

function processRoot(root: ParentNode | null) {
    processSingleButtons(root);
    processBulkButton(root);
}

let observer: MutationObserver | null = null;
let scanTimer: number | null = null;

/** Discord re-renders the picker often and drops our injected nodes with it. */
function scheduleScan() {
    if (scanTimer != null) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = null;
        // Only relevant while the GIF picker/favorites view is on screen.
        if (!document.querySelector('[aria-label="Remove from Favorites"], input[placeholder="Search Favorites"]')) return;
        processRoot(document);
    }, 250);
}

export default definePlugin({
    name: "GIF Downloader",
    description: "Downloads favorite GIFs. On first download, choose a folder (Documents/GIFS by default); the location is remembered for future downloads.",
    authors: [Devs.UnknownDevelopment],
    tags: ["Emotes", "Utility"],
    enabledByDefault: true,
    start() {
        // Exposed so tooling (the GIF round-trip script) can reuse the exact
        // same URL resolution / WebP-to-GIF conversion instead of duplicating it.
        (window as any).__favGifTools = {
            getFavoriteGifUrls,
            resolveGifUrl,
            needsConversion,
            sniffMedia,
            webpToGif,
            saveGifFile,
            isKlipyUrl,
        };

        processRoot(document);
        observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        processRoot(node as unknown as ParentNode);
                    }
                });
            }
            scheduleScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },
    stop() {
        observer?.disconnect();
        observer = null;
        delete (window as any).__favGifTools;
        if (scanTimer != null) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        document.querySelectorAll('[aria-label="Download GIF"]').forEach(n => n.remove());
        document.querySelectorAll("[data-fav-bulk]").forEach(n => n.remove());
    },
});
