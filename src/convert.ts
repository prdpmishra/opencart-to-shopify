import { decode } from "he";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import type {
    Attribute,
    Customer,
    FullProduct,
    OptionValue,
    Order,
    OrderAddress,
    OrderLine,
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

// Whether a special price ending on this date ("2049-04-03") is really the
// product's price: it ends more than 10 years from now.
export function isPermanentSpecial(endDate: string, now = new Date()): boolean {
    const limit = new Date(now);
    limit.setFullYear(limit.getFullYear() + 10);
    return new Date(`${endDate}T00:00:00Z`) > limit;
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

        // Two attributes with the same name (in different groups) would get the
        // same key, so then the group is part of the key and the name.
        const withGroup = attribute.sharedName && attribute.group !== "";
        metafields.push({
            attributeId: attribute.id,
            name: withGroup ? `${attribute.name} (${attribute.group})` : attribute.name,
            group: attribute.group,
            namespace: "custom",
            key: toMetafieldKey(withGroup ? { id: attribute.id, name: `${attribute.group} ${attribute.name}` } : attribute),
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

export function toAddressInput(address: OrderAddress): AddressInput {
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

// "2026-06-04 22:53:32" as a clock in the given time zone (e.g. "Europe/Berlin")
// → that moment in UTC, as Shopify wants it: "2026-06-04T20:53:32.000Z".
export function zonedTimeToUtc(dateTime: string, timeZone: string): string {
    const wall = new Date(`${dateTime.replace(" ", "T")}Z`).getTime();
    if (Number.isNaN(wall)) throw new Error(`Not a date: "${dateTime}".`);
    // The offset is looked up twice, so a date near a daylight saving change gets the right one.
    const guess = wall - offsetMs(timeZone, wall);
    return new Date(wall - offsetMs(timeZone, guess)).toISOString();
}

// The zone's UTC offset at a moment, as MySQL and PHP write it, e.g. "+02:00"
// for Europe/Berlin in summer.
export function utcOffset(timeZone: string, moment: number = Date.now()): string {
    const minutes = Math.round(offsetMs(timeZone, moment) / 60000);
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// How far the zone's clock is ahead of UTC at a moment, in milliseconds
// (e.g. 2 hours in a German summer). Throws for an unknown time zone.
function offsetMs(timeZone: string, moment: number): number {
    const format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const p = Object.fromEntries(format.formatToParts(moment).map((part) => [part.type, Number(part.value)]));
    // Whole seconds: the moment's milliseconds aren't part of the formatted clock.
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(moment / 1000) * 1000;
}

// One line, for the console. Works for both our AddressInput and Shopify's
// addresses (which use null for empty fields).
export function describeAddress(a: { [K in keyof AddressInput]?: string | null | undefined }): string {
    return [
        `${a.firstName} ${a.lastName}`,
        a.company,
        a.address1,
        a.address2,
        `${a.zip} ${a.city}`.trim(),
        a.provinceCode,
        a.countryCode,
    ]
        .filter(Boolean)
        .join(", ");
}

// Amounts in Shopify's MoneyBagInput form, in the shop's currency.
interface MoneyBag {
    shopMoney: { amount: string; currencyCode: string };
}

interface TaxLine {
    title: string;
    rate: number; // 0.2 for 20%
    priceSet: MoneyBag;
}

// The parts of Shopify's OrderCreateOrderInput that we fill in.
export interface OrderInput {
    currency: string;
    processedAt: string;
    email?: string;
    phone?: string;
    note: string;
    tags: string[];
    taxesIncluded: boolean;
    financialStatus: FinancialStatus;
    fulfillmentStatus?: "FULFILLED";
    customer?: { toAssociate: { id: string } };
    billingAddress: AddressInput;
    shippingAddress?: AddressInput;
    lineItems: {
        variantId?: string;
        title: string;
        sku?: string;
        quantity: number;
        priceSet: MoneyBag; // unit price
        requiresShipping: boolean;
        taxLines?: TaxLine[];
        // Options that aren't variants, e.g. a text the customer typed.
        properties?: { name: string; value: string }[];
    }[];
    shippingLines: { title: string; code: string; priceSet: MoneyBag; taxLines?: TaxLine[] }[];
    // An OpenCart coupon, as a fixed discount on the products.
    discountCode?: { itemFixedDiscountCode: { code: string; amountSet: MoneyBag } };
    transactions: {
        kind: "SALE" | "REFUND";
        status: "SUCCESS";
        gateway: string;
        amountSet: MoneyBag;
        processedAt: string;
    }[];
}

type FinancialStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "REFUNDED" | "VOIDED" | "EXPIRED";

// OpenCart's default order statuses → Shopify. OpenCart lets shop owners add or
// rename statuses, so this goes by ID. Canceled, Denied, Failed and the
// chargeback statuses have no Shopify equivalent for a new order.
const ORDER_STATUSES: Record<number, { financialStatus: FinancialStatus; fulfilled: boolean }> = {
    1: { financialStatus: "PENDING", fulfilled: false }, // Pending
    2: { financialStatus: "PAID", fulfilled: false }, // Processing
    15: { financialStatus: "PAID", fulfilled: false }, // Processed
    3: { financialStatus: "PAID", fulfilled: true }, // Shipped
    5: { financialStatus: "PAID", fulfilled: true }, // Complete
    11: { financialStatus: "REFUNDED", fulfilled: false }, // Refunded
    14: { financialStatus: "EXPIRED", fulfilled: false }, // Expired
    16: { financialStatus: "VOIDED", fulfilled: false }, // Voided
};

// Whether an order with this OpenCart status can be migrated.
export function canMigrateOrderStatus(statusId: number): boolean {
    return statusId in ORDER_STATUSES;
}

// The shop's own order statuses, from OPENCART_ORDER_STATUS_MAP: "20:5,22:1"
// means status 20 is migrated like OpenCart's default status 5 (Complete), and
// 22 like 1 (Pending). Returns own status ID → default status ID.
export function parseOrderStatusMap(value: string | undefined): Map<number, number> {
    const map = new Map<number, number>();
    for (const pair of (value ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
        const match = /^(\d+):(\d+)$/.exec(pair);
        if (!match)
            throw new Error(`OPENCART_ORDER_STATUS_MAP: "${pair}" isn't "own status ID:default status ID", e.g. "20:5".`);
        const [own, standard] = [Number(match[1]), Number(match[2])];
        if (!canMigrateOrderStatus(standard))
            throw new Error(
                `OPENCART_ORDER_STATUS_MAP: status ${standard} isn't a default status that can be migrated ` +
                    `(${Object.keys(ORDER_STATUSES).join(", ")}).`,
            );
        map.set(own, standard);
    }
    return map;
}

// Select and radio options are the ones migrated products have as variants.
const isVariantOption = (option: OrderLine["options"][number]) =>
    option.type === "select" || option.type === "radio";

// The Shopify variant an order line was for: the one with the options the
// customer chose. A product without options has a single variant.
// Returns null if there is no such variant (any more).
export function matchVariant(
    variants: { id: string; selectedOptions: { name: string; value: string }[] }[],
    options: OrderLine["options"],
): string | null {
    const chosen = options.filter(isVariantOption);
    if (chosen.length === 0) return variants.length === 1 ? variants[0]!.id : null;
    const match = variants.find(
        (variant) =>
            variant.selectedOptions.length === chosen.length &&
            variant.selectedOptions.every((selected) =>
                chosen.some((c) => c.name.trim() === selected.name && c.value.trim() === selected.value),
            ),
    );
    return match?.id ?? null;
}

// Whether an event on an order's timeline says Shopify notified someone, e.g.
// "Order confirmation email was sent to Jan (jan@example.com)." or an SMS.
// Migrated orders are history and must never do that. "Confirmation #ABC was
// generated" is only the order's confirmation number, not a message.
export function isNotificationEvent(event: { action: string | null; message: string }): boolean {
    return /mail|sms|notif/i.test(event.action ?? "") || /\b(e-?mail|sms|text message|notification)\b/i.test(event.message);
}

// "VAT (20%)" or "BTW 21%" → "VAT", "BTW": Shopify shows the rate next to the title itself.
function taxTitle(title: string): string {
    return title.replace(/\s*\(?\s*[\d.,]+\s*%\s*\)?\s*$/, "").trim() || title;
}

// Turns an OpenCart order into Shopify's orderCreate input. Amounts stay in the
// store currency, as OpenCart stores them.
// variantIds: the Shopify variant for each line (null: not migrated, so the
// line keeps only its title, SKU and price). customerId: the Shopify customer,
// null for a guest order.
// Throws if the order has totals Shopify can't show (e.g. a coupon) or doesn't add up.
export function toOrderInput(
    order: Order,
    currency: string,
    variantIds: (string | null)[],
    customerId: string | null,
): OrderInput {
    const status = ORDER_STATUSES[order.statusId];
    if (!status) throw new Error(`OpenCart order status "${order.statusName}" can't be migrated.`);
    const money = (amount: number): MoneyBag => ({
        shopMoney: { amount: roundCents(amount).toFixed(2), currencyCode: currency },
    });
    const rate = (tax: number, price: number) => (price > 0 ? Math.round((tax / price) * 10000) / 10000 : 0);

    for (const total of order.totals)
        if (!["sub_total", "shipping", "handling", "coupon", "voucher", "tax", "total"].includes(total.code))
            throw new Error(`The order total "${total.title}" (${total.code}) isn't supported.`);
    const taxTotals = order.totals.filter((t) => t.code === "tax");
    if (taxTotals.length > 1)
        throw new Error(`The order has ${taxTotals.length} taxes (${taxTotals.map((t) => t.title).join(", ")}); only one is supported.`);
    const tax = taxTotals[0];
    const shipping = order.totals.find((t) => t.code === "shipping");
    // A handling fee of 0.00 (OpenCart's handling extension adds one to every order) is left out.
    const handling = order.totals.filter((t) => t.code === "handling" && roundCents(t.value) !== 0);
    const coupons = order.totals.filter((t) => t.code === "coupon");
    if (coupons.length > 1) throw new Error(`The order has ${coupons.length} coupons; only one is supported.`);
    const coupon = coupons[0];
    // Gift vouchers pay for (part of) the order: OpenCart's total is what's left to pay.
    const vouchers = order.totals.filter((t) => t.code === "voucher");

    // OpenCart charges tax on the price after the coupon, but keeps each line's tax
    // from before it. A coupon takes the same share off every product, so each
    // line's tax goes down by that share. That isn't so for a coupon that only
    // applies to some products, or one that also takes off the shipping (and its
    // tax): the tax can't be split over the lines then.
    // (With shipping of 0.00 a free-shipping coupon has nothing to take off.)
    if (coupon && order.coupon?.freeShipping && (shipping?.value ?? 0) > 0)
        throw new Error(`The coupon "${coupon.title}" gives free shipping, which isn't supported.`);
    if (coupon && order.coupon?.limitedToProducts)
        throw new Error(`The coupon "${coupon.title}" only applies to some products, which isn't supported.`);
    const subTotal = order.totals.find((t) => t.code === "sub_total")?.value ?? 0;
    const couponShare = coupon && subTotal > 0 ? -coupon.value / subTotal : 0;
    if (coupon && couponShare > 1)
        throw new Error(`The coupon "${coupon.title}" (${-coupon.value}) is more than the products cost (${subTotal}).`);

    // Shipping and handling: Shopify has no handling fee, so it's a charge like shipping.
    const charges = [
        ...(shipping ? [{ title: shipping.title, code: order.shippingCode, value: shipping.value }] : []),
        ...handling.map((h) => ({ title: h.title, code: "handling", value: h.value })),
    ];
    // OpenCart doesn't store the shipping tax separately: it's what's left of the
    // tax, and it goes on the first charge that costs something.
    const lineTaxes = order.lines.map((line) => roundCents(line.tax * line.quantity * (1 - couponShare)));
    let chargeTax = tax ? roundCents(tax.value - lineTaxes.reduce((sum, t) => sum + t, 0)) : 0;
    const taxedCharge = charges.findIndex((c) => c.value > 0);
    // A cent or two from rounding the shares goes on the last taxed line.
    const last = lineTaxes.findLastIndex((t) => t > 0);
    if (chargeTax !== 0 && last >= 0 && (chargeTax < 0 || taxedCharge < 0) && Math.abs(chargeTax) <= 0.05) {
        lineTaxes[last] = roundCents(lineTaxes[last]! + chargeTax);
        chargeTax = 0;
    }
    if (chargeTax < 0)
        throw new Error(`The order's tax (${tax?.value}) is less than the tax on its lines (${roundCents(tax!.value - chargeTax)}).`);
    if (chargeTax > 0 && taxedCharge < 0)
        throw new Error(
            `The order's tax (${tax?.value}) is ${chargeTax} more than the tax on its lines, with no shipping or fee it could be on.`,
        );
    // Tax on a charge at a higher rate than any product's means the split is wrong.
    const highestRate = Math.max(0, ...order.lines.map((line) => (line.price > 0 ? line.tax / line.price : 0)));
    if (chargeTax > 0 && highestRate > 0 && chargeTax / charges[taxedCharge]!.value > highestRate + 0.01)
        throw new Error(
            `The tax left for "${charges[taxedCharge]!.title}" (${chargeTax} on ${charges[taxedCharge]!.value}) is more ` +
                "than the products' rate, so the order's tax can't be split over its lines.",
        );

    // OpenCart keeps amounts to 4 decimals and rounds only the total, which is
    // what the customer paid. Shopify adds up the parts in cents, which can be a
    // cent or two off: that goes on the tax too, so the order isn't left with a
    // cent to pay or to refund.
    const sentTax = tax ? lineTaxes.filter((t) => t > 0).reduce((s, t) => s + t, 0) + Math.max(chargeTax, 0) : 0;
    const shopifyTotal =
        order.lines.reduce((s, line) => s + roundCents(line.total / line.quantity) * line.quantity, 0) +
        charges.reduce((s, c) => s + roundCents(c.value), 0) +
        sentTax -
        (coupon ? roundCents(-coupon.value) : 0);
    const paidTotal = vouchers.reduce((s, v) => s + roundCents(-v.value), 0) + roundCents(order.total);
    const rounding = roundCents(paidTotal - shopifyTotal);
    if (rounding !== 0) {
        if (Math.abs(rounding) > 0.05)
            throw new Error(`The order's parts add up to ${roundCents(shopifyTotal)} in cents, not its total ${roundCents(paidTotal)}.`);
        if (tax && last >= 0 && lineTaxes[last]! + rounding > 0) lineTaxes[last] = roundCents(lineTaxes[last]! + rounding);
        else if (tax && taxedCharge >= 0 && chargeTax + rounding > 0) chargeTax = roundCents(chargeTax + rounding);
        else
            throw new Error(
                `The order's parts add up to ${roundCents(shopifyTotal)} in cents, not its total ${roundCents(paidTotal)}, ` +
                    "and it has no tax to put the difference on.",
            );
    }

    const lineItems: OrderInput["lineItems"] = order.lines.map((line, i) => {
        const variantId = variantIds[i] ?? undefined;
        // Options that are part of the variant show as its title; the rest as properties.
        const properties = line.options
            .filter((option) => !variantId || !isVariantOption(option))
            .map((option) => ({ name: option.name, value: option.value }));
        const lineTax = lineTaxes[i]!;
        return {
            ...(variantId && { variantId }),
            title: tidyText(line.name),
            // A variant brings its own SKU; OpenCart's order only has the model.
            ...(!variantId && line.model.trim() && { sku: line.model.trim() }),
            quantity: line.quantity,
            // From the line total: OpenCart may have charged less than the unit price.
            priceSet: money(line.total / line.quantity),
            requiresShipping: order.shipping !== null,
            ...(tax && lineTax > 0 && {
                taxLines: [{ title: taxTitle(tax.title), rate: rate(line.tax, line.price), priceSet: money(lineTax) }],
            }),
            ...(properties.length > 0 && { properties }),
        };
    });

    const shippingLines: OrderInput["shippingLines"] = charges.map((charge, i) => ({
        title: charge.title,
        code: charge.code,
        priceSet: money(charge.value),
        ...(tax && i === taxedCharge && chargeTax > 0 && {
            taxLines: [{ title: taxTitle(tax.title), rate: rate(chargeTax, charge.value), priceSet: money(chargeTax) }],
        }),
    }));

    const add = (totals: { value: number }[]) => totals.reduce((s, t) => s + t.value, 0);
    const sum =
        order.lines.reduce((s, line) => s + line.total, 0) +
        (shipping?.value ?? 0) + add(handling) + (tax?.value ?? 0) + (coupon?.value ?? 0) + add(vouchers);
    if (roundCents(sum) !== roundCents(order.total))
        throw new Error(
            `The order's lines, shipping, tax, coupon and vouchers add up to ${roundCents(sum)}, not its total ${order.total}.`,
        );

    // What was paid: each gift voucher, then the rest with the payment method.
    const voucherPayments = vouchers
        .map((v) => ({ gateway: v.title, amount: -v.value }))
        .filter((p) => roundCents(p.amount) > 0);
    const payments = [...voucherPayments, { gateway: order.paymentMethod || "manual", amount: order.total }].filter(
        (p) => roundCents(p.amount) > 0,
    );
    const transaction = (kind: "SALE" | "REFUND", processedAt: string) => (p: (typeof payments)[number]) => ({
        kind,
        status: "SUCCESS" as const,
        gateway: p.gateway,
        amountSet: money(p.amount),
        processedAt,
    });
    // A voucher was used at checkout, so it has paid even when the rest is still
    // pending: the order is then partly paid, or paid if the voucher covered it all.
    const pendingWithVoucher = status.financialStatus === "PENDING" && voucherPayments.length > 0;
    const financialStatus: FinancialStatus = pendingWithVoucher
        ? roundCents(order.total) > 0 ? "PARTIALLY_PAID" : "PAID"
        : status.financialStatus;
    const transactions =
        status.financialStatus === "PAID"
            ? payments.map(transaction("SALE", order.processedAt))
            : status.financialStatus === "REFUNDED"
              ? [...payments.map(transaction("SALE", order.processedAt)), ...payments.map(transaction("REFUND", order.modifiedAt))]
              : pendingWithVoucher
                ? voucherPayments.map(transaction("SALE", order.processedAt))
                : [];

    const email = order.email.trim().toLowerCase();
    const phone = toE164(order.telephone, order.payment.countryCode || undefined);

    return {
        currency,
        processedAt: order.processedAt,
        ...(email && { email }),
        ...(phone && { phone }),
        note: orderNote(order, currency),
        tags: ["OpenCart"],
        taxesIncluded: false, // OpenCart prices exclude tax
        financialStatus,
        ...(status.fulfilled && { fulfillmentStatus: "FULFILLED" as const }),
        ...(customerId && { customer: { toAssociate: { id: customerId } } }),
        billingAddress: toAddressInput(order.payment),
        ...(order.shipping && { shippingAddress: toAddressInput(order.shipping) }),
        lineItems,
        shippingLines,
        ...(coupon && {
            discountCode: { itemFixedDiscountCode: { code: couponCode(coupon.title), amountSet: money(-coupon.value) } },
        }),
        transactions,
    };
}

// "Kortingsbon (black2017)" → "black2017": OpenCart puts the code in brackets
// after the coupon's name.
export function couponCode(title: string): string {
    return /\(([^()]+)\)\s*$/.exec(title)?.[1]?.trim() || title;
}

// The order's background, for the note on the Shopify order: the OpenCart
// number, what the customer paid in their currency, comments and history.
function orderNote(order: Order, currency: string): string {
    const lines = [`Migrated from OpenCart: order #${order.id}, placed ${order.dateAdded}, status ${order.statusName}.`];
    if (order.paymentMethod) lines.push(`Payment method: ${order.paymentMethod}`);
    if (order.currencyCode !== currency)
        lines.push(`Paid in ${order.currencyCode}: ${roundCents(order.total * order.currencyValue).toFixed(2)} ${order.currencyCode}`);
    if (order.comment.trim()) lines.push(`Customer comment: ${order.comment.trim()}`);
    if (order.history.length > 0) {
        lines.push("History:");
        for (const h of order.history) lines.push(`- ${h.dateAdded} ${h.statusName}: ${h.comment.trim()}`);
    }
    return lines.join("\n");
}
