import { decode } from "he";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import type {
    Attribute,
    Customer,
    CustomerAddress,
    FullProduct,
    OptionValue,
    ProductOption,
    Special,
} from "./opencart.ts";

export type WeightUnit = "KILOGRAMS" | "GRAMS" | "POUNDS" | "OUNCES";

// OpenCart weight class units → Shopify weight units.
const WEIGHT_UNITS: Record<string, WeightUnit> = {
    kg: "KILOGRAMS",
    g: "GRAMS",
    lb: "POUNDS",
    oz: "OUNCES",
};

// The parts of Shopify's ProductSetInput that we fill in.
// The handle is left out when updating, so Shopify keeps it.
export interface ProductSetInput {
    title: string;
    descriptionHtml: string;
    handle?: string;
    status: "ACTIVE" | "DRAFT";
    seo: { title: string; description: string };
    vendor?: string;
    tags: string[];
    productOptions: { name: string; values: { name: string }[] }[];
    variants: {
        id?: string; // set when updating, so the existing variant is kept
        optionValues: { optionName: string; name: string }[];
        price: string;
        // The original price during a sale; null clears it when the sale has ended.
        compareAtPrice: string | null;
        sku?: string;
        taxable: boolean; // Shopify's "Charge tax on this product"
        inventoryItem: {
            tracked: boolean;
            requiresShipping: boolean; // Shopify's "This is a physical product"
            measurement?: { weight: { value: number; unit: WeightUnit } };
        };
        inventoryPolicy: "DENY" | "CONTINUE";
        // Only used when creating; updates set the quantity with inventorySetQuantities.
        inventoryQuantities?: { locationId: string; name: "available"; quantity: number }[];
    }[];
    // The product's complete list of collections; productSet replaces the existing list.
    collections?: string[];
    // Only sent when creating; updates sync them separately.
    metafields?: { namespace: string; key: string; type: string; value: string }[];
    files?: { originalSource: string; alt: string; contentType: "IMAGE" }[];
}

export function shopifyWeightUnit(openCartUnit: string | null): WeightUnit | null {
    return WEIGHT_UNITS[openCartUnit?.toLowerCase() ?? ""] ?? null;
}

// Collapses tabs, line breaks and repeated spaces, e.g. "\t HTC Touch HD" → "HTC Touch HD".
export function tidyText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

// Rounds to whole cents. Math.round on cents avoids results like 1.005 → 1.00,
// which toFixed(2) gives because 1.005 is stored as 1.00499999...
export function roundCents(amount: number): number {
    return Math.round(Number((amount * 100).toFixed(6))) / 100;
}

// Shopify allows at most 3 options per product.
const MAX_OPTIONS = 3;

// options: OpenCart's select/radio options. Each combination of their values
// becomes a Shopify variant. Without options the product gets one variant.
// special: OpenCart's active special price. It becomes the sale price, with the
// normal price as Shopify's compare-at price (shown crossed out).
// priceTaxRate: OpenCart prices exclude tax. When Shopify's prices include tax,
// this is the rate in % to add (e.g. 20); null sends the prices unchanged.
export function toProductSetInput(
    product: FullProduct,
    locationId: string,
    options: ProductOption[],
    special: Special | null,
    priceTaxRate: number | null,
): ProductSetInput {
    const taxFactor = priceTaxRate === null ? 1 : 1 + priceTaxRate / 100;
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

    // null for a unit Shopify doesn't have: the weight is then left out (see migrate.ts).
    const weightUnit = shopifyWeightUnit(product.weightUnit);

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
        // Rounded to cents here, so price and compare-at are compared as Shopify stores them.
        const normalPrice = roundCents((basePrice + modifiers) * taxFactor);
        const price = roundCents(((special ? special.price : basePrice) + modifiers) * taxFactor);
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
            inventoryItem: { tracked, requiresShipping: product.requiresShipping },
            inventoryPolicy: product.allowOutOfStockCheckout ? "CONTINUE" : "DENY",
            taxable: product.taxable,
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

        // OpenCart adds each chosen value's weight to the product weight, in the same unit.
        if (weightUnit) {
            const weight = combination.reduce((sum, c) => sum + c.value.weightModifier, product.weight);
            variant.inventoryItem.measurement = {
                weight: { value: Math.max(0, Number(weight.toFixed(4))), unit: weightUnit },
            };
        }

        return variant;
    });

    return {
        title: product.name,
        descriptionHtml: cleanDescription(product.description),
        handle: buildHandle(product),
        // OpenCart hides disabled products, products whose "Date Available" is in the
        // future, and products not assigned to the store.
        status: product.enabled && !product.availableLater && product.inDefaultStore ? "ACTIVE" : "DRAFT",
        // Empty clears Shopify's SEO fields, so it falls back to the title and description.
        seo: { title: tidyText(product.metaTitle), description: tidyText(product.metaDescription) },
        ...(product.manufacturer ? { vendor: product.manufacturer } : {}),
        // Shopify treats tags case-insensitively ("Apple" = "apple"), so keep the first of each.
        tags: product.tags.filter(
            (tag, i) => product.tags.findIndex((t) => t.toLowerCase() === tag.toLowerCase()) === i,
        ),
        productOptions:
            options.length > 0
                ? options.map((o) => ({ name: o.name, values: o.values.map((v) => ({ name: v.name })) }))
                : [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants,
    };
}

export interface ProductMetafield {
    /** The OpenCart attribute it comes from. */
    attributeId: number;
    name: string;
    group: string;
    namespace: "custom";
    key: string;
    type: "single_line_text_field";
    value: string;
}

// Shopify metafield keys: 2 to 64 letters, numbers, hyphens or underscores.
// "No. of Cores" → "no_of_cores"; without usable characters, "attribute_<id>".
export function toMetafieldKey(attribute: { id: number; name: string }): string {
    const key = attribute.name
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64);
    return key.length >= 2 ? key : `attribute_${attribute.id}`;
}

// OpenCart attributes → product metafields in the merchant's "custom" namespace,
// as Shopify admin creates them. Values are single-line text, as typed in OpenCart.
export function toMetafields(productId: number, attributes: Attribute[]): ProductMetafield[] {
    const metafields: ProductMetafield[] = [];
    for (const attribute of attributes) {
        // A single-line field can't hold line breaks; the text itself stays the same.
        const value = tidyText(attribute.text);
        if (!value) {
            console.log(`Product ${productId}: attribute "${attribute.name}" is empty, skipping it`);
            continue;
        }

        metafields.push({
            attributeId: attribute.id,
            name: attribute.name,
            group: attribute.group,
            namespace: "custom",
            key: toMetafieldKey(attribute),
            type: "single_line_text_field",
            value,
        });
    }
    return metafields;
}

// Shopify reformats HTML when saving it: it puts a newline between </p><p>, turns
// entities into characters (&quot; → ", &rsquo; → ’, &nbsp; → a non-breaking space)
// and writes <br /> as <br>. None of this changes the page, so it's ignored when comparing.
export function sameHtml(a: string, b: string): boolean {
    const normalise = (html: string) =>
        decode(html)
            .replace(/\s*\/>/g, ">")
            .replace(/>\s+</g, "><");
    return normalise(a) === normalise(b);
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
        .replace(/[\u0300-\u036f]/g, "") // drop the accent marks
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-") // anything else becomes one hyphen
        .replace(/^-+|-+$/g, ""); // no hyphens at the start or end
}

// SEO keyword first, then the name, then "<kind>-<id>" (e.g. "product-48").
// Works for anything with an ID, a name and an SEO keyword: products and categories.
export function buildHandle(
    product: { id: number; name: string; seoKeyword: string | null },
    kind: "product" | "category" = "product",
): string {
    const label = `${kind === "product" ? "Product" : "Category"} ${product.id}`;

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

    const fallback = `${kind}-${product.id}`;
    console.log(`${label}: name has no usable characters, using handle "${fallback}"`);
    return fallback;
}

// ── Customers ──

// The parts of Shopify's CustomerSetInput that we fill in.
export interface CustomerInput {
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null; // E.164, e.g. "+31612345678"; null leaves it empty
    note: string;
    tags: string[];
}

// Shopify's MailingAddressInput.
export interface AddressInput {
    firstName: string;
    lastName: string;
    company: string;
    address1: string;
    address2: string;
    city: string;
    zip: string;
    countryCode?: string | undefined; // left out when OpenCart has none
    // null: no province (clears it on an update); left out: keep Shopify's.
    provinceCode?: string | null | undefined;
}

// Turns a phone number as typed in OpenCart into E.164 ("+31612345678"), which
// Shopify requires. Numbers without "+" are read as numbers of the given country.
// Returns null if it isn't a valid number.
export function toE164(telephone: string, countryCode: string | undefined): string | null {
    const phone = parsePhoneNumberFromString(telephone.trim(), (countryCode || undefined) as CountryCode | undefined);
    return phone?.isValid() ? phone.number : null;
}

export function toCustomerInput(customer: Customer): CustomerInput {
    const defaultAddress = customer.addresses.find((a) => a.id === customer.defaultAddressId);
    return {
        // Shopify matches emails without regard to case; lowercase keeps comparisons simple.
        email: customer.email.trim().toLowerCase(),
        firstName: tidyText(customer.firstName),
        lastName: tidyText(customer.lastName),
        phone: toE164(customer.telephone, defaultAddress?.countryCode),
        note: `Migrated from OpenCart: customer #${customer.id}, registered ${customer.dateAdded}.`,
        tags: customer.group ? [customer.group] : [],
    };
}

export function toAddressInput(address: CustomerAddress): AddressInput {
    return {
        firstName: tidyText(address.firstName),
        lastName: tidyText(address.lastName),
        company: tidyText(address.company),
        address1: tidyText(address.address1),
        address2: tidyText(address.address2),
        city: tidyText(address.city),
        zip: tidyText(address.postcode),
        countryCode: address.countryCode || undefined,
        provinceCode: address.zoneCode || null,
    };
}

// Whether an address in Shopify already matches the wanted one, allowing for
// what Shopify changes when it saves an address:
// - empty fields come back as null;
// - postcodes are reformatted to the country's style ("8225BZ" → "8225 BZ").
// A province left out of the wanted address (one Shopify doesn't keep) isn't compared.
export function sameAddress(
    wanted: AddressInput,
    current: { [K in keyof AddressInput]-?: string | null },
): boolean {
    const text = (value: string | null | undefined) => (value ?? "").trim();
    const zip = (value: string | null | undefined) => text(value).replace(/\s+/g, "").toUpperCase();
    return (
        (["firstName", "lastName", "company", "address1", "address2", "city", "countryCode"] as const).every(
            (field) => text(wanted[field]) === text(current[field]),
        ) &&
        zip(wanted.zip) === zip(current.zip) &&
        (wanted.provinceCode === undefined || text(wanted.provinceCode) === text(current.provinceCode))
    );
}
