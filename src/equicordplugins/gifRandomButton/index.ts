/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { setGifCategoryFeature } from "@equicordplugins/favoriteGifCategories";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "GIF Random Button",
    description: "Adds a button that sends a random GIF from the selected category.",
    authors: [Devs.UnknownDevelopment],
    tags: ["Emotes", "Utility"],
    dependencies: ["GIF Categories"],
    enabledByDefault: true,
    start() {
        setGifCategoryFeature("randomButton", true);
    },
    stop() {
        setGifCategoryFeature("randomButton", false);
    }
});
