/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { gitHash } from "@shared/vencordUserAgent";
import { app, BaseWindow, BrowserWindow, dialog, Menu, MenuItemConstructorOptions, shell } from "electron";
import aboutHtml from "file://about.html?minify";

import updater from "./updater";
import { SETTINGS_DIR, THEMES_DIR } from "./utils/constants";

const isTrayMenu = (template: MenuItemConstructorOptions[]) =>
    template.length > 0
    && template.at(-1)?.role === "quit"
    && !template.some(item => item.label === "&File" || item.label === "File" || item.label === "&Edit" || item.label === "Edit");

function findInsertIndex(template: MenuItemConstructorOptions[]): number {
    const openIndex = template.findIndex(item => {
        const label = item.label?.toLowerCase() ?? "";
        return label.includes("open") || label.includes("show");
    });
    return openIndex !== -1 ? openIndex + 1 : 0;
}

let aboutWindow: BrowserWindow | null = null;

function openAboutWindow() {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    aboutWindow = new BrowserWindow({
        center: true,
        autoHideMenuBar: true,
        height: 525,
        width: 900
    });

    aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    aboutWindow.webContents.on("will-navigate", (e, url) => {
        e.preventDefault();
        shell.openExternal(url);
    });

    const aboutParams = aboutHtml
        .replaceAll("{{VERSION}}", VERSION)
        .replaceAll("{{GIT_HASH}}", gitHash); // change to gitHashShort if/when its added
    const base64Html = Buffer.from(aboutParams).toString("base64");
    aboutWindow.loadURL(`data:text/html;base64,${base64Html}`);
    aboutWindow.on("closed", () => {
        aboutWindow = null;
    });
}

const notify = (window: BaseWindow | undefined, title: string, message: string) =>
    window && !window.isDestroyed()
        ? dialog.showMessageBox(window, { title, message })
        : dialog.showMessageBox({ title, message });

let isUpdating = false;

function createVencordMenuItems(): MenuItemConstructorOptions[] {
    return [
        { type: "separator" },
        {
            id: "hellocord",
            label: "Hellocord",
            submenu: [
                {
                    label: "About Hellocord",
                    click: () => openAboutWindow()
                },
                {
                    label: "Update Hellocord",
                    visible: !IS_UPDATER_DISABLED,
                    async click(_item, window) {
                        if (isUpdating) return;
                        isUpdating = true;

                        try {
                            const updateAvailable = await updater.fetchUpdate();
                            if (!updateAvailable) {
                                return notify(window, "No Update Available", "You are already using the latest version of Hellocord.");
                            }

                            const result = await updater.applyUpdate();
                            if (!result) {
                                return notify(window, "Update Failed", "Failed to apply the update for Hellocord.");
                            }

                            await notify(window, "Update Successful", "Now relaunching Hellocord to apply the update.");
                            app.relaunch();
                            app.exit();
                        } catch (e) {
                            notify(window, "Update Error", `An error occurred while updating Hellocord.\n\n${String(e)}`);
                        } finally {
                            isUpdating = false;
                        }
                    }
                },
                { type: "separator" },
                {
                    label: "Open Settings Folder",
                    click: () => shell.openPath(SETTINGS_DIR)
                },
                {
                    label: "Open Themes Folder",
                    click: () => shell.openPath(THEMES_DIR)
                }
            ]
        }
    ];
}

export function patchTrayMenu(): void {
    const originalBuildFromTemplate = Menu.buildFromTemplate;

    Menu.buildFromTemplate = function (template: MenuItemConstructorOptions[]) {
        const alreadyPatched = template.some(item => item.id === "hellocord" || item.label === "Hellocord");
        if (isTrayMenu(template) && !alreadyPatched) {
            const insertIndex = findInsertIndex(template);
            const vencordItems = createVencordMenuItems();
            template.splice(insertIndex, 0, ...vencordItems);
        }

        return originalBuildFromTemplate.call(this, template);
    };
}
