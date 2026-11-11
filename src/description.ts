import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
    if (!URL.canParse(prefix))
        throw new Error(`OPENCART_IMAGE_URL must be a full URL, e.g. http://localhost/opencart/image/ (got "${imageUrl}")`);
    const base = new URL(prefix);
    const rootPrefix = base.pathname; // e.g. "/opencart/image/"

    let path: string;
    if (URL.canParse(src)) {
        // A full URL: OpenCart's image folder on the same host, over http or https
        // (OpenCart's editor writes whichever the admin was using). A query such
        // as "?v=2" isn't part of the file name.
        const url = new URL(src);
        if (url.host !== base.host || !url.pathname.startsWith(rootPrefix)) return null;
        path = url.pathname.slice(rootPrefix.length);
    } else if (src.startsWith(rootPrefix)) path = src.slice(rootPrefix.length);
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

// Returns the Shopify CDN URL of an image in OpenCart's image folder
// (e.g. "catalog/demo/a.jpg"), uploading it to Shopify Files the first time.
// Returns null if the file is missing, the upload fails, or in a dry run when
// it hasn't been uploaded yet. "what" names the image in log messages.
export async function toShopifyFileUrl(
    path: string,
    what: string,
    dryRun: boolean,
): Promise<string | null> {
    const known = findFileMapping(path);
    if (known) return known.shopify_url;

    // "../" in the path must not reach files outside OpenCart's image folder,
    // which would then be uploaded to Shopify.
    const imageDir = resolve(requireEnv("OPENCART_IMAGE_DIR"));
    const fullPath = resolve(imageDir, path);
    const inside = relative(imageDir, fullPath);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        console.warn(`Warning: ${what} "${path}" is outside OpenCart's image folder, skipping it.`);
        return null;
    }
    if (!existsSync(fullPath)) {
        console.warn(`Warning: ${what} not found, skipping: ${fullPath}`);
        return null;
    }

    if (dryRun) {
        console.log(`${what} would be uploaded: ${fullPath}`);
        return null;
    }

    try {
        const file = await createImageFile(await uploadImage(fullPath, "IMAGE"));
        saveFileMapping(path, file.id, file.url);
        console.log(`${what} uploaded: ${fullPath} → ${file.url}`);
        return file.url;
    } catch (error) {
        console.warn(
            `Warning: ${what} upload failed, skipping ${fullPath}: ` +
                (error instanceof Error ? error.message : error),
        );
        return null;
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

    // Work out the new URL for each different src first, then replace them all.
    const newSrc = new Map<string, string>();
    const sources = new Set([...html.matchAll(IMG_SRC)].map((m) => m[3]!));

    for (const src of sources) {
        const path = toImagePath(src, imageUrl);
        if (!path) continue;

        const url = await toShopifyFileUrl(path, "Description image", dryRun);
        if (url) newSrc.set(src, url);
    }

    return html.replace(IMG_SRC, (match, before: string, quote: string, src: string) => {
        const replacement = newSrc.get(src);
        return replacement ? `${before}${quote}${replacement}${quote}` : match;
    });
}
