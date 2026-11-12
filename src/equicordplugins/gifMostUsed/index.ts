/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { setGifCategoryFeature } from "@equicordplugins/favoriteGifCategories";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "GIF Most Used",
    description: "Tracks sent favorite GIFs and adds a Most Used view to GIF Categories.",
    authors: [Devs.UnknownDevelopment],
    tags: ["Emotes", "Utility"],
    dependencies: ["GIF Categories"],
    enabledByDefault: true,
    start() {
        setGifCategoryFeature("mostUsed", true);
    },
    stop() {
        setGifCategoryFeature("mostUsed", false);
    }
});
