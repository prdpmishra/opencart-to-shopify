import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "./env.ts";
import { findFileMapping, saveFileMapping } from "./mapping.ts";
import { createImageFile, uploadImage } from "./shopify.ts";

// Matches the src attribute of an <img> tag: (everything before the value)(quote)(value)(quote).
const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gi;

// Turns an OpenCart image src into a path inside OpenCart's image folder,
// e.g. "http://localhost:8080/opencart/image/catalog/a.jpg" → "catalog/a.jpg".
// Returns null for images that aren't OpenCart's (e.g. on another website).
export function toImagePath(src: string, imageUrl: string): string | null {
    const prefix = imageUrl.endsWith("/") ? imageUrl : `${imageUrl}/`;
    const rootPrefix = new URL(prefix).pathname; // e.g. "/opencart/image/"

    let path: string;
    if (src.startsWith(prefix)) path = src.slice(prefix.length);
    else if (src.startsWith(rootPrefix)) path = src.slice(rootPrefix.length);
    else if (src.startsWith("image/")) path = src.slice("image/".length);
    else if (src.startsWith("catalog/")) path = src;
    else return null;

    // URLs encode some characters, e.g. a space as %20.
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

// Replaces OpenCart image URLs in a description with Shopify CDN URLs.
// Each image is uploaded to Shopify Files once and remembered in file_mapping.
// In a dry run nothing is uploaded: only already-uploaded images are replaced.
export async function rewriteDescriptionImages(
    html: string,
    dryRun: boolean,
): Promise<string> {
    const imageUrl = requireEnv("OPENCART_IMAGE_URL");
    const imageDir = requireEnv("OPENCART_IMAGE_DIR");

    // Work out the new URL for each different src first, then replace them all.
    const newSrc = new Map<string, string>();
    const sources = new Set([...html.matchAll(IMG_SRC)].map((m) => m[3]!));

    for (const src of sources) {
        const path = toImagePath(src, imageUrl);
        if (!path) continue;

        const known = findFileMapping(path);
        if (known) {
            newSrc.set(src, known.shopify_url);
            continue;
        }

        const fullPath = join(imageDir, path);
        if (!existsSync(fullPath)) {
            console.warn(`Warning: description image not found, keeping its URL: ${fullPath}`);
            continue;
        }

        if (dryRun) {
            console.log(`Description image would be uploaded: ${fullPath}`);
            continue;
        }

        try {
            const file = await createImageFile(await uploadImage(fullPath, "IMAGE"));
            saveFileMapping(path, file.id, file.url);
            newSrc.set(src, file.url);
            console.log(`Description image uploaded: ${fullPath} → ${file.url}`);
        } catch (error) {
            console.warn(
                `Warning: description image upload failed, keeping its URL: ${fullPath}: ` +
                    (error instanceof Error ? error.message : error),
            );
        }
    }

    return html.replace(IMG_SRC, (match, before: string, quote: string, src: string) => {
        const replacement = newSrc.get(src);
        return replacement ? `${before}${quote}${replacement}${quote}` : match;
    });
}
