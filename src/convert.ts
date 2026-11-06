import type { FullProduct, OptionValue, ProductOption, Special } from "./opencart.ts";

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
        // The original price during a sale; null clears it when the sale has ended.
        compareAtPrice: string | null;
        sku?: string;
        inventoryItem: { tracked: boolean };
        inventoryPolicy: "DENY" | "CONTINUE";
        // Only used when creating; updates set the quantity with inventorySetQuantities.
        inventoryQuantities?: { locationId: string; name: "available"; quantity: number }[];
    }[];
    files?: { originalSource: string; alt: string; contentType: "IMAGE" }[];
}

// Shopify allows at most 3 options per product.
const MAX_OPTIONS = 3;

// options: OpenCart's select/radio options. Each combination of their values
// becomes a Shopify variant. Without options the product gets one variant.
// special: OpenCart's active special price. It becomes the sale price, with the
// normal price as Shopify's compare-at price (shown crossed out).
export function toProductSetInput(
    product: FullProduct,
    locationId: string,
    options: ProductOption[],
    special: Special | null,
): ProductSetInput {
    const label = `Product ${product.id}`;

    const basePrice = Number(product.price);
    if (!Number.isFinite(basePrice))
        throw new Error(`${label}: invalid price "${product.price}"`);

    if (options.length > MAX_OPTIONS)
        throw new Error(
            `${label}: has ${options.length} select/radio options, but Shopify allows at most ${MAX_OPTIONS}.`,
        );
    for (const option of options) {
        const names = option.values.map((v) => v.name);
        if (new Set(names).size !== names.length)
            throw new Error(`${label}: option "${option.name}" has two values with the same name.`);
    }

    const baseSku = product.sku.trim() || product.model.trim();
    if (!product.sku.trim()) {
        console.log(
            baseSku
                ? `${label}: no SKU, using model "${baseSku}"`
                : `${label}: no SKU or model, variants will have no SKU`,
        );
    }

    // Every combination of option values, e.g. [Red, Small], [Red, Large], ...
    // Without options this is a single empty combination.
    let combinations: { option: string; value: OptionValue }[][] = [[]];
    for (const option of options)
        combinations = combinations.flatMap((combination) =>
            option.values.map((value) => [...combination, { option: option.name, value }]),
        );

    const variants = combinations.map((combination, i): ProductSetInput["variants"][number] => {
        // Products without options use Shopify's default "Title" option.
        const optionValues =
            combination.length > 0
                ? combination.map((c) => ({ optionName: c.option, name: c.value.name }))
                : [{ optionName: "Title", name: "Default Title" }];

        // OpenCart adds each chosen value's price modifier to the product price,
        // or to the special price when there is one.
        const modifiers = combination.reduce((sum, c) => sum + c.value.priceModifier, 0);
        const normalPrice = basePrice + modifiers;
        const price = (special ? special.price : basePrice) + modifiers;
        if (price < 0)
            throw new Error(`${label}: variant ${optionValues.map((o) => o.name).join(" / ")} has a negative price.`);

        // Shopify only shows a compare-at price that is higher than the price.
        const compareAtPrice = normalPrice > price ? normalPrice.toFixed(2) : null;

        // OpenCart checks every quantity it tracks (the product's and each value's),
        // so the variant can't sell more than the lowest of them.
        const trackedQuantities = [
            ...(product.subtractStock ? [product.quantity] : []),
            ...combination.filter((c) => c.value.subtractStock).map((c) => c.value.quantity),
        ];
        const tracked = trackedQuantities.length > 0;

        const variant: ProductSetInput["variants"][number] = {
            optionValues,
            price: price.toFixed(2),
            compareAtPrice,
            // OpenCart's "Subtract Stock" is Shopify's "Track quantity".
            inventoryItem: { tracked },
            inventoryPolicy: product.allowOutOfStockCheckout ? "CONTINUE" : "DENY",
        };

        // Shopify ignores quantities of untracked items, so only send them when tracked.
        if (tracked)
            variant.inventoryQuantities = [
                { locationId, name: "available", quantity: Math.min(...trackedQuantities) },
            ];

        // Each variant gets its own SKU: the product's SKU plus its option values.
        if (baseSku) {
            const suffix = toHandle(combination.map((c) => c.value.name).join(" "));
            variant.sku =
                combination.length === 0 ? baseSku : `${baseSku}-${suffix || i + 1}`;
        }

        return variant;
    });

    return {
        title: product.name,
        descriptionHtml: cleanDescription(product.description),
        handle: buildHandle(product),
        status: "DRAFT",
        productOptions:
            options.length > 0
                ? options.map((o) => ({ name: o.name, values: o.values.map((v) => ({ name: v.name })) }))
                : [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants,
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
