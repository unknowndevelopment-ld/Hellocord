/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog, net } from "electron";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const DIR_NAME = "GIFS";
const LOCATION_FILE = join(app.getPath("userData"), "gif-downloader-location.json");
let downloadDirPromise: Promise<string> | null = null;

async function resolveDownloadDirectory(): Promise<string> {
    const defaultDir = join(app.getPath("documents"), DIR_NAME);
    await mkdir(defaultDir, { recursive: true });

    let rememberedDir: string | null = null;
    try {
        const config = JSON.parse(await readFile(LOCATION_FILE, "utf8"));
        if (typeof config.directory === "string" && config.directory.trim()) rememberedDir = config.directory;
    } catch {
        // First run (or a missing preference): ask once, defaulting to Documents/GIFS.
    }

    if (rememberedDir) {
        try {
            await mkdir(rememberedDir, { recursive: true });
            return rememberedDir;
        } catch (error) {
            console.warn("[GIF Downloader] Remembered folder is unavailable; asking for a new location", error);
        }
    }

    const result = await dialog.showOpenDialog({
        title: "Choose where GIF downloads are saved",
        buttonLabel: "Use this folder",
        defaultPath: defaultDir,
        properties: ["openDirectory", "createDirectory"]
    });
    const directory = !result.canceled && result.filePaths[0] ? result.filePaths[0] : defaultDir;
    await mkdir(directory, { recursive: true });
    await writeFile(LOCATION_FILE, JSON.stringify({ directory }, null, 2), "utf8");
    return directory;
}

export async function getDownloadDirectory() {
    if (!downloadDirPromise) {
        downloadDirPromise = resolveDownloadDirectory().catch(error => {
            downloadDirPromise = null;
            throw error;
        });
    }
    return downloadDirPromise;
}

function safeName(fileName: string) {
    return (fileName || "download").replace(/[^a-zA-Z0-9._-]/g, "");
}

function detectExtension(data: Uint8Array, fallback: string) {
    if (data.length >= 12) {
        if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "gif";
        if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return "png";
        if (data[0] === 0xFF && data[1] === 0xD8) return "jpg";
        if (
            data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
            data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
        ) return "webp";
        if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
            // ISO BMFF container (mp4/mov)
            return "mp4";
        }
    }
    return fallback;
}

async function writeTo(dir: string, name: string, data: Uint8Array) {
    const safe = safeName(name) || "download.gif";
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";

    // Never clobber an earlier download. The renderer's counter restarts each
    // session, so "1.gif" can already exist from a previous run.
    let filePath = join(dir, safe);
    for (let index = 1; ; index++) {
        try {
            await access(filePath);
        } catch {
            break;
        }
        filePath = join(dir, `${base} (${index})${extension}`);
    }

    await writeFile(filePath, data);
    return filePath;
}

export async function saveGif(_: any, fileName: string, data: number[]) {
    const dir = await getDownloadDirectory();
    return writeTo(dir, fileName, new Uint8Array(data));
}

/** Writes raw bytes (TypedArray/ArrayBuffer) produced in the renderer. */
export async function saveGifBytes(_: any, fileName: string, data: Uint8Array | ArrayBuffer | number[]) {
    const dir = await getDownloadDirectory();
    const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
            ? data
            : new Uint8Array(data as number[]);
    return writeTo(dir, fileName, bytes);
}

/**
 * Downloads a URL in the main process (no CORS restrictions) and hands the raw
 * bytes to the renderer, where WebP/AVIF can be decoded and re-encoded as GIF.
 */
export async function fetchBytes(_: any, url: string) {
    if (!url) throw new Error("missing url");

    const response = await net.fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8"
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

    const data = await response.arrayBuffer();
    if (!data.byteLength) throw new Error(`empty response for ${url}`);

    return {
        data,
        contentType: response.headers.get("content-type") || ""
    };
}

/**
 * Downloads a URL from the main process (no CORS restrictions) and writes it
 * into Documents/GIFS. The extension is derived from the actual file bytes so
 * tenor/klipy media is never mislabelled as a .gif when it is really an mp4.
 */
export async function saveGifFromUrl(_: any, fileName: string, url: string) {
    if (!url) throw new Error("missing url");

    const dir = await getDownloadDirectory();

    const response = await net.fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8"
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length) throw new Error(`empty response for ${url}`);

    const requestedExt = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || "gif").toLowerCase();
    const ext = detectExtension(data, requestedExt);
    const base = fileName.replace(/\.[a-z0-9]+$/i, "") || "download";

    return writeTo(dir, `${base}.${ext}`, data);
}
