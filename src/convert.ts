import type { FullProduct } from "./opencart.ts";

// The parts of Shopify's ProductSetInput that we fill in.
export interface ProductSetInput {
    title: string;
    descriptionHtml: string;
    handle: string;
    status: "DRAFT";
    productOptions: { name: string; values: { name: string }[] }[];
    variants: {
        optionValues: { optionName: string; name: string }[];
        price: string;
        sku?: string;
    }[];
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
        descriptionHtml: product.description,
        handle: buildHandle(product),
        status: "DRAFT",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [variant],
    };
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
