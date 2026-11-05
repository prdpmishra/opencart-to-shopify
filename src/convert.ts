import type { FullProduct } from "./opencart.ts";

// Shopify handles use lowercase letters, numbers and hyphens.
export function toHandle(text: string): string {
    return text
        .normalize("NFKD") // split accented letters: "é" → "e" + accent mark
        .replace(/[̀-ͯ]/g, "") // drop the accent marks
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // anything else becomes one hyphen
        .replace(/^-+|-+$/g, ""); // no hyphens at the start or end
}

// SEO keyword first, then the product name, then "product-<id>".
export function buildHandle(product: FullProduct): string {
    const label = `Product ${product.id}`;

    if (product.seoKeyword) {
        const handle = toHandle(product.seoKeyword);
        if (handle === product.seoKeyword) return handle;

        if (handle) {
            console.log(
                `${label}: SEO keyword "${product.seoKeyword}" normalised to handle "${handle}"`,
            );
            return handle;
        }
        console.log(
            `${label}: SEO keyword "${product.seoKeyword}" has no usable characters, using the name`,
        );
    } else {
        console.log(`${label}: no SEO keyword, using the name`);
    }

    const fromName = toHandle(product.name);
    if (fromName) {
        console.log(`${label}: handle "${fromName}" built from name "${product.name}"`);
        return fromName;
    }

    const fallback = `product-${product.id}`;
    console.log(`${label}: name has no usable characters, using handle "${fallback}"`);
    return fallback;
}
