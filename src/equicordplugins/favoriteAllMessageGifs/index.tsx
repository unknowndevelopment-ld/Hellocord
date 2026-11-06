/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { showToast, UserSettingsActionCreators } from "@webpack/common";

const STAR_ICON = "<svg aria-hidden=\"true\" role=\"img\" xmlns=\"http://www.w3.org/2000/svg\" width=\"28\" height=\"28\" fill=\"none\" viewBox=\"0 0 24 24\"><path fill=\"currentColor\" d=\"M10.81 2.86c.38-1.15 2-1.15 2.38 0l1.89 5.83h6.12c1.2 0 1.71 1.54.73 2.25l-4.95 3.6 1.9 5.82a1.25 1.25 0 0 1-1.93 1.4L12 18.16l-4.95 3.6c-.98.7-2.3-.25-1.92-1.4l1.89-5.82-4.95-3.6a1.25 1.25 0 0 1 .73-2.25h6.12l1.9-5.83Z\"/></svg>";

const BUTTON_LABEL = "Favorite all GIFs in this message";

/** Media worth favoriting: attachments in the message body and link embeds. */
const MEDIA_SELECTOR = [
    '[id^="message-content-"] img',
    '[id^="message-content-"] video',
    '[class*="embed"] img',
    '[class*="embed"] video',
    'a[class*="originalLink"]',
    'a[href*="cdn.discordapp.com/attachments/"]',
].join(",");

function getStore() {
    return (UserSettingsActionCreators as any).FrecencyUserSettingsActionCreators;
}

/**
 * Discord renders image/GIF attachments as embeds whose `<img>` is only a tiny
 * `data:` placeholder until the media is actually loaded. The real URL lives on
 * the wrapping `<a class="originalLink" href="...">`, so prefer that when present.
 */
function mediaUrl(el: Element): string {
    if (el.tagName === "A") return (el as HTMLAnchorElement).getAttribute("href") || "";

    const own = el.tagName === "VIDEO"
        ? (el as HTMLVideoElement).src
        : (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;

    if (own && !own.startsWith("data:") && !own.startsWith("blob:")) return own;

    // Not loaded yet: the wrapping link still holds the real attachment URL.
    return el.closest<HTMLAnchorElement>('a[class*="originalLink"]')?.getAttribute("href") || own || "";
}

function unwrapProxy(url: string): string {
    const match = url.match(/^https?:\/\/images-ext-\d+\.discordapp\.net\/external\/[^/]+\/(https?\/.+)$/i);
    if (!match) return url;
    const rest = match[1];
    if (rest.startsWith("https/")) return "https://" + rest.slice(6);
    if (rest.startsWith("http/")) return "http://" + rest.slice(5);
    return url;
}

function isGifMedia(el: Element): boolean {
    // Avatars, emojis, reactions and stickers share the message subtree but are
    // not the GIFs the user means.
    if (el.closest('[class*="avatar"], [class*="emoji"], [class*="reaction"], [class*="sticker"]')) return false;

    const raw = mediaUrl(el);
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return false;

    const src = unwrapProxy(raw).split("#")[0];
    let parsed: URL;
    try {
        parsed = new URL(src);
    } catch {
        return false;
    }

    if (parsed.hostname === "media.tenor.com" || parsed.hostname.endsWith(".tenor.com")) return true;
    if (parsed.hostname === "klipy.com" || parsed.hostname.endsWith(".klipy.com") || parsed.hostname === "static.klipy.com") {
        // Tenor/Klipy page links (e.g. tenor.com/view/...) are not media: the
        // embed itself already renders the actual video/img element.
        return el.tagName !== "A";
    }

    const path = parsed.pathname.toLowerCase();
    const animated = parsed.searchParams.get("animated") === "true";

    if (el.tagName === "A") {
        // Only Discord attachment links carry the real media URL.
        if (!/(^|\.)discordapp\.(com|net)$/i.test(parsed.hostname)) return false;
        return path.endsWith(".gif") || animated;
    }

    if (el.tagName === "VIDEO") return /\.(mp4|webm)$/i.test(path) || animated;
    if (path.endsWith(".gif")) return true;
    // Discord often re-serves GIFs as animated webp.
    return animated;
}

/**
 * The picker renders favorites from `src`, and Discord itself rewrites GIF-like
 * URLs to `format=webp&animated=true` so they animate in the picker.
 */
function normalizeSrc(raw: string): string {
    const src = unwrapProxy(raw);
    try {
        const url = new URL(src);
        if (/\.(gif|webp|avif)$/i.test(url.pathname)) {
            url.searchParams.set("format", "webp");
            url.searchParams.set("animated", "true");
        }
        return url.toString();
    } catch {
        return src;
    }
}

/** Favorite keys for Discord attachments are the plain cdn URL without query. */
function favoriteKey(raw: string): string {
    try {
        const url = new URL(unwrapProxy(raw));
        if (url.hostname === "media.discordapp.net") url.hostname = "cdn.discordapp.com";
        url.search = "";
        return url.toString();
    } catch {
        return raw;
    }
}

interface GifMedia {
    key: string;
    src: string;
    format: number;
    width: number;
    height: number;
}

function collectGifMedia(messageEl: HTMLElement): GifMedia[] {
    const out: GifMedia[] = [];
    const seen = new Set<string>();

    for (const el of Array.from(messageEl.querySelectorAll(MEDIA_SELECTOR))) {
        if (!isGifMedia(el)) continue;

        const raw = mediaUrl(el);
        const key = favoriteKey(raw);
        const src = normalizeSrc(raw);
        if (seen.has(src) || seen.has(key)) continue;
        seen.add(src);
        seen.add(key);

        const isVideo = el.tagName === "VIDEO";
        const img = el as HTMLImageElement;
        const video = el as HTMLVideoElement;
        const box = el.closest<HTMLElement>('[class*="imageWrapper"], [class*="imageContainer"], [class*="embed"]');

        out.push({
            key,
            src,
            format: isVideo ? 2 : 1,
            width: img.naturalWidth || video.videoWidth || box?.clientWidth || el.clientWidth || 0,
            height: img.naturalHeight || video.videoHeight || box?.clientHeight || el.clientHeight || 0,
        });
    }

    return out;
}

async function favoriteAll(messageEl: HTMLElement) {
    const medias = collectGifMedia(messageEl);
    if (!medias.length) {
        showToast({ text: "No GIFs found in this message", variant: "critical" });
        return;
    }

    const store = getStore();
    await store.loadIfNecessary?.().catch(() => { });

    const before = store.getCurrentValue().favoriteGifs?.gifs || {};
    const existingSrcs = new Set(Object.values(before).map((g: any) => g?.src));
    const existingKeys = new Set(Object.keys(before));

    const pending = medias.filter(m => !existingKeys.has(m.key) && !existingSrcs.has(m.src));
    if (!pending.length) {
        showToast({ text: "Those GIFs are already favorited" });
        return;
    }

    let maxOrder = 0;
    for (const gif of Object.values(before) as any[]) maxOrder = Math.max(maxOrder, gif?.order || 0);

    // Discord's updateAsync hands over a mutable draft; returning a new object
    // is ignored, so the gifs have to be written into the draft in place.
    await store.updateAsync("favoriteGifs", (draft: any) => {
        if (!draft.gifs) draft.gifs = {};
        let order = maxOrder;

        for (const media of pending) {
            if (draft.gifs[media.key]) continue;
            const alreadyThere = Object.values(draft.gifs).some((g: any) => g?.src === media.src);
            if (alreadyThere) continue;

            draft.gifs[media.key] = {
                format: media.format,
                src: media.src,
                width: media.width,
                height: media.height,
                order: ++order,
            };
        }
    }, 0);

    await new Promise(resolve => setTimeout(resolve, 500));

    const after = store.getCurrentValue().favoriteGifs?.gifs || {};
    const added = pending.filter(m => Object.values(after).some((g: any) => g?.src === m.src)).length;

    if (added) {
        showToast({
            text: `Favorited ${added} GIF${added === 1 ? "" : "s"}`,
            variant: "success",
        });
    } else {
        showToast({
            text: "Could not favorite those GIFs — Discord's favorites size limit was reached",
            variant: "critical",
        });
    }
}

function processMessage(messageEl: HTMLElement) {
    // Re-renders can drop the injected button while the flag stays behind, so
    // only trust the flag when the button is still there.
    if (messageEl.querySelector(`button[aria-label="${BUTTON_LABEL}"]`)) return;
    delete messageEl.dataset.favAllGifs;

    const medias = collectGifMedia(messageEl);
    if (medias.length < 2) return;

    messageEl.dataset.favAllGifs = "1";

    if (window.getComputedStyle(messageEl).position === "static") {
        messageEl.style.position = "relative";
    }

    const btn = document.createElement("button");
    btn.setAttribute("aria-label", BUTTON_LABEL);
    btn.title = `Favorite all ${medias.length} GIFs`;
    btn.innerHTML = STAR_ICON;
    btn.style.cssText = "position:absolute;top:6px;right:6px;z-index:100;background:rgba(0,0,0,0.45);border:none;border-radius:50%;padding:6px;color:#f0b232;cursor:pointer;display:flex;align-items:center;justify-content:center;";

    btn.addEventListener("click", async e => {
        e.preventDefault();
        e.stopPropagation();
        try {
            await favoriteAll(messageEl);
        } catch (error) {
            console.error("[FavoriteAllMessageGifs] Failed to favorite GIFs", error);
            showToast({ text: "Failed to favorite GIFs", variant: "critical" });
        }
    });

    messageEl.appendChild(btn);
}

function scanMessages() {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="message__"]'))) {
        processMessage(el);
    }
}

function processRoot(root: ParentNode | null) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[class*="message__"]').forEach(m => processMessage(m as HTMLElement));
}

let observer: MutationObserver | null = null;
let scanTimer: number | null = null;

function scheduleFullScan() {
    if (scanTimer != null) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = null;
        scanMessages();
    }, 400);
}

export default definePlugin({
    name: "Bulk Favorite GIFs",
    description: "Adds a star button at the top right of messages containing multiple GIFs to favorite them all at once.",
    authors: [Devs.UnknownDevelopment],
    tags: ["Emotes", "Utility"],
    enabledByDefault: true,
    start() {
        scanMessages();
        observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        processRoot(node as unknown as ParentNode);
                    }
                });
            }
            // Embeds and images often render after their message node is
            // inserted, so re-check the whole channel after the DOM settles.
            scheduleFullScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },
    stop() {
        observer?.disconnect();
        observer = null;
        if (scanTimer != null) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        document.querySelectorAll("[data-fav-all-gifs]").forEach(m => {
            delete (m as any).dataset.favAllGifs;
            m.querySelectorAll(`button[aria-label="${BUTTON_LABEL}"]`).forEach(b => b.remove());
            (m as HTMLElement).style.position = "";
        });
    },
});
