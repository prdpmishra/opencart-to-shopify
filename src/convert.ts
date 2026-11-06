import type { FullProduct } from "./opencart.ts";

// The parts of Shopify's ProductSetInput that we fill in.
// handle and status are left out when updating, so Shopify keeps its values.
export interface ProductSetInput {
    title: string;
    descriptionHtml: string;
    handle?: string;
    status?: "DRAFT";
    productOptions: { name: string; values: { name: string }[] }[];
    variants: {
        id?: string; // set when updating, so the existing variant is kept
        optionValues: { optionName: string; name: string }[];
        price: string;
        sku?: string;
    }[];
    files?: { originalSource: string; alt: string; contentType: "IMAGE" }[];
}

export function toProductSetInput(product: FullProduct): ProductSetInput {
    const label = `Product ${product.id}`;

    const price = Number(product.price);
    if (!Number.isFinite(price))
        throw new Error(`${label}: invalid price "${product.price}"`);

    // Products without options still need one: Shopify's default "Title" option.
    const variant: ProductSetInput["variants"][number] = {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price: price.toFixed(2),
    };

    const sku = product.sku.trim() || product.model.trim();
    if (sku) variant.sku = sku;
    if (!product.sku.trim()) {
        console.log(
            sku
                ? `${label}: no SKU, using model "${sku}"`
                : `${label}: no SKU or model, variant will have no SKU`,
        );
    }

    return {
        title: product.name,
        descriptionHtml: cleanDescription(product.description),
        handle: buildHandle(product),
        status: "DRAFT",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [variant],
    };
}

// Block tags start their own line on the page, so spaces around them never show.
const BLOCK_TAG =
    /\s*(<\/?(?:p|div|ul|ol|li|h[1-6]|br|table|thead|tbody|tr|td|th|blockquote)\b[^>]*>)\s*/gi;

// Tidies OpenCart's description HTML into what Shopify's editor produces.
// Only markup changes; the visible text stays the same.
export function cleanDescription(html: string): string {
    return (
        html
            .replace(/<!--[\s\S]*?-->/g, "") // HTML comments
            .replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, "") // OpenCart's CSS classes mean nothing in a Shopify theme
            .replace(/<\/?font\b[^>]*>/gi, "") // <font>: keep the text, let the theme pick the font
            .replace(/<(\/?)b(\s[^>]*)?>/gi, "<$1strong$2>") // <b> → <strong>
            .replace(/<(\/?)i(\s[^>]*)?>/gi, "<$1em$2>") // <i> → <em>
            // Only real spaces, tabs and line breaks: a non-breaking space is kept.
            .replace(/[ \t\r\n]+/g, " ")
            .replace(BLOCK_TAG, "$1")
            .trim()
    );
}

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
