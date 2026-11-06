import mysql, { type RowDataPacket, type Connection } from "mysql2/promise";
import { decode } from "he";
import { requireEnv } from "./env.ts";

interface ProductRow extends RowDataPacket {
    product_id: number;
    price: string;
    name: string | null;
}

export interface Product {
    id: number;
    price: string;
    name: string;
}

export async function connect(): Promise<Connection> {
    return mysql.createConnection({
        host: requireEnv("DB_HOST"),
        user: requireEnv("DB_USER"),
        password: requireEnv("DB_PASSWORD", true),
        database: requireEnv("DB_NAME"),
    });
}

interface FullProductRow extends RowDataPacket {
    product_id: number;
    price: string;
    sku: string;
    model: string;
    quantity: number;
    subtract: number;
    name: string | null;
    description: string | null;
    keyword: string | null;
    stock_checkout: string | null;
    tax_class_id: number;
    tax_class_exists: number;
    has_tax_rules: number;
    has_fixed_tax: number;
    status: number;
    available_later: number;
    in_default_store: number;
    meta_title: string | null;
    meta_description: string | null;
    tag: string | null;
    manufacturer: string | null;
    weight: string;
    weight_unit: string | null;
    length: string;
    width: string;
    height: string;
    shipping: number;
}

export interface FullProduct {
    id: number;
    price: string;
    sku: string;
    model: string;
    name: string;
    description: string;
    /** SEO URL keyword for store 0 and LANGUAGE_ID, or null if none is set. */
    seoKeyword: string | null;
    quantity: number;
    /** OpenCart's "Subtract Stock": whether sales reduce the quantity. */
    subtractStock: boolean;
    /** Store setting: whether customers can buy when the quantity is 0. */
    allowOutOfStockCheckout: boolean;
    taxClassId: number;
    /** False when the tax class is set but doesn't exist in OpenCart. */
    taxClassExists: boolean;
    /** Whether OpenCart charges tax: the tax class has at least one tax rule. */
    taxable: boolean;
    /** Whether the tax class includes a fixed amount (e.g. an eco tax). */
    hasFixedTax: boolean;
    enabled: boolean;
    /** OpenCart hides a product until its "Date Available"; true while that's in the future. */
    availableLater: boolean;
    /** OpenCart only shows a product in the stores it's assigned to; store 0 is the default one. */
    inDefaultStore: boolean;
    metaTitle: string;
    metaDescription: string;
    /** Comma-separated in OpenCart, e.g. "iPhone, Apple, smartphone". */
    tags: string[];
    manufacturer: string | null;
    weight: number;
    /** The weight class's unit, e.g. "kg", "g", "lb", "oz". */
    weightUnit: string | null;
    hasDimensions: boolean;
    requiresShipping: boolean;
}

function getSettings() {
    const dbPrefix = process.env.DB_PREFIX || "";
    const languageId = Number(process.env.LANGUAGE_ID || 1);

    if (!Number.isInteger(languageId))
        throw new Error("LANGUAGE_ID must be a whole number.");

    return { dbPrefix, languageId };
}

export async function getProduct(
    connection: Connection,
    id: number,
): Promise<FullProduct> {
    const { dbPrefix, languageId } = getSettings();

    // OpenCart 3.0 keeps SEO keywords in seo_url, keyed by query = 'product_id=<id>'.
    const [results] = await connection.execute<FullProductRow[]>(
        `SELECT p.product_id, p.price, p.sku, p.model, p.quantity, p.subtract,
            pd.name, pd.description, su.keyword, p.tax_class_id,
            EXISTS(SELECT 1 FROM \`${dbPrefix}tax_class\` tc
                WHERE tc.tax_class_id = p.tax_class_id) AS tax_class_exists,
            EXISTS(SELECT 1 FROM \`${dbPrefix}tax_rule\` trl
                WHERE trl.tax_class_id = p.tax_class_id) AS has_tax_rules,
            EXISTS(SELECT 1 FROM \`${dbPrefix}tax_rule\` trl
                JOIN \`${dbPrefix}tax_rate\` tr ON tr.tax_rate_id = trl.tax_rate_id
                WHERE trl.tax_class_id = p.tax_class_id AND tr.type = 'F') AS has_fixed_tax,
            (SELECT value FROM \`${dbPrefix}setting\`
                WHERE store_id = 0 AND \`key\` = 'config_stock_checkout') AS stock_checkout,
            p.status, p.shipping, p.weight, wcd.unit AS weight_unit, p.length, p.width, p.height,
            (p.date_available <> '0000-00-00' AND p.date_available > NOW()) AS available_later,
            EXISTS(SELECT 1 FROM \`${dbPrefix}product_to_store\` p2s
                WHERE p2s.product_id = p.product_id AND p2s.store_id = 0) AS in_default_store,
            pd.meta_title, pd.meta_description, pd.tag, m.name AS manufacturer
        FROM \`${dbPrefix}product\` p
        LEFT JOIN \`${dbPrefix}product_description\` pd
            ON pd.product_id = p.product_id AND pd.language_id = ?
        LEFT JOIN \`${dbPrefix}seo_url\` su
            ON su.query = CONCAT('product_id=', p.product_id) AND su.store_id = 0 AND su.language_id = ?
        LEFT JOIN \`${dbPrefix}weight_class_description\` wcd
            ON wcd.weight_class_id = p.weight_class_id AND wcd.language_id = ?
        LEFT JOIN \`${dbPrefix}manufacturer\` m ON m.manufacturer_id = p.manufacturer_id
        WHERE p.product_id = ?`,
        [languageId, languageId, languageId, id],
    );

    const row = results[0];
    if (!row) throw new Error(`OpenCart product ${id} not found.`);

    return {
        id: row.product_id,
        price: row.price,
        sku: row.sku,
        model: row.model,
        name: decode(row.name ?? ""),
        description: decode(row.description ?? ""),
        seoKeyword: row.keyword || null,
        quantity: row.quantity,
        subtractStock: row.subtract === 1,
        allowOutOfStockCheckout: row.stock_checkout === "1",
        taxClassId: row.tax_class_id,
        taxClassExists: row.tax_class_exists === 1,
        taxable: row.has_tax_rules === 1,
        hasFixedTax: row.has_fixed_tax === 1,
        enabled: row.status === 1,
        availableLater: row.available_later === 1,
        inDefaultStore: row.in_default_store === 1,
        metaTitle: decode(row.meta_title ?? ""),
        metaDescription: decode(row.meta_description ?? ""),
        tags: decode(row.tag ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== ""),
        manufacturer: row.manufacturer ? decode(row.manufacturer) : null,
        weight: Number(row.weight),
        weightUnit: row.weight_unit?.trim() || null,
        hasDimensions: [row.length, row.width, row.height].some((d) => Number(d) !== 0),
        requiresShipping: row.shipping === 1,
    };
}

export async function getProducts(
    connection: Connection,
    limit = 20,
): Promise<Product[]> {
    const { dbPrefix, languageId } = getSettings();

    if (!Number.isInteger(limit) || limit < 1)
        throw new Error("limit must be a positive whole number.");

    // LIMIT is inlined because mysql2's execute() rejects it as a bound parameter.
    const [results] = await connection.execute<ProductRow[]>(
        `SELECT p.product_id, p.price, pd.name FROM \`${dbPrefix}product\` p LEFT JOIN \`${dbPrefix}product_description\` pd ON (p.product_id = pd.product_id) AND pd.language_id = ? ORDER BY p.product_id LIMIT ${limit}`,
        [languageId],
    );

    return results.map(
        (row): Product => ({
            id: row.product_id,
            name: decode(row.name ?? ""),
            price: row.price,
        }),
    );
}

interface ImageRow extends RowDataPacket {
    image: string | null;
}

// Image paths relative to OpenCart's image/ folder: the main image first,
// then the additional images. Empty paths and duplicates are skipped.
export async function getProductImages(
    connection: Connection,
    id: number,
): Promise<string[]> {
    const { dbPrefix } = getSettings();

    const [main] = await connection.execute<ImageRow[]>(
        `SELECT image FROM \`${dbPrefix}product\` WHERE product_id = ?`,
        [id],
    );
    const [additional] = await connection.execute<ImageRow[]>(
        `SELECT image FROM \`${dbPrefix}product_image\` WHERE product_id = ? ORDER BY sort_order, product_image_id`,
        [id],
    );

    const paths = [...main, ...additional]
        .map((row) => row.image?.trim() ?? "")
        .filter((path) => path !== "");

    return [...new Set(paths)];
}

export interface OptionValue {
    name: string;
    /** Added to the product price; negative for OpenCart's "-" prefix. */
    priceModifier: number;
    /** Added to the product weight (same unit); negative for OpenCart's "-" prefix. */
    weightModifier: number;
    quantity: number;
    /** OpenCart's "Subtract Stock" for this value. */
    subtractStock: boolean;
}

export interface ProductOption {
    name: string;
    values: OptionValue[];
}

export interface SkippedOption {
    name: string;
    type: string;
    required: boolean;
}

interface OptionRow extends RowDataPacket {
    product_option_id: number;
    name: string;
    type: string;
    required: number;
}

interface OptionValueRow extends RowDataPacket {
    product_option_id: number;
    name: string;
    price: string;
    price_prefix: string;
    weight: string;
    weight_prefix: string;
    quantity: number;
    subtract: number;
}

// Select and radio options (one choice each) can become Shopify variants.
// Other types (checkbox, text, date, file, ...) are returned as skipped.
export async function getProductOptions(
    connection: Connection,
    id: number,
): Promise<{ options: ProductOption[]; skipped: SkippedOption[] }> {
    const { dbPrefix, languageId } = getSettings();

    const [optionRows] = await connection.execute<OptionRow[]>(
        `SELECT po.product_option_id, od.name, o.type, po.required
        FROM \`${dbPrefix}product_option\` po
        JOIN \`${dbPrefix}option\` o ON o.option_id = po.option_id
        LEFT JOIN \`${dbPrefix}option_description\` od
            ON od.option_id = o.option_id AND od.language_id = ?
        WHERE po.product_id = ?
        ORDER BY o.sort_order, po.product_option_id`,
        [languageId, id],
    );

    const [valueRows] = await connection.execute<OptionValueRow[]>(
        `SELECT pov.product_option_id, ovd.name, pov.price, pov.price_prefix, pov.weight, pov.weight_prefix, pov.quantity, pov.subtract
        FROM \`${dbPrefix}product_option_value\` pov
        JOIN \`${dbPrefix}option_value\` ov ON ov.option_value_id = pov.option_value_id
        LEFT JOIN \`${dbPrefix}option_value_description\` ovd
            ON ovd.option_value_id = pov.option_value_id AND ovd.language_id = ?
        WHERE pov.product_id = ?
        ORDER BY ov.sort_order, pov.product_option_value_id`,
        [languageId, id],
    );

    const options: ProductOption[] = [];
    const skipped: SkippedOption[] = [];

    for (const row of optionRows) {
        const name = decode(row.name ?? "");
        if (row.type !== "select" && row.type !== "radio") {
            skipped.push({ name, type: row.type, required: row.required === 1 });
            continue;
        }

        const values = valueRows
            .filter((v) => v.product_option_id === row.product_option_id)
            .map((v) => ({
                name: decode(v.name ?? ""),
                priceModifier: Number(v.price) * (v.price_prefix === "-" ? -1 : 1),
                weightModifier: Number(v.weight) * (v.weight_prefix === "-" ? -1 : 1),
                quantity: v.quantity,
                subtractStock: v.subtract === 1,
            }));

        // An option without values offers no choice, so there is nothing to migrate.
        if (values.length > 0) options.push({ name, values });
    }

    return { options, skipped };
}

export interface Special {
    price: number;
    /** "YYYY-MM-DD", or null when the special has no end date. */
    endDate: string | null;
}

interface SpecialRow extends RowDataPacket {
    price: string;
    for_default_group: number;
    started: number;
    ended: number;
    date_start: string;
    date_end: string;
}

interface DiscountRow extends RowDataPacket {
    quantity: number;
    price: string;
}

// The special price OpenCart shows right now to the default customer group,
// plus notes about price rules that are not migrated (other groups, future
// specials, quantity discounts).
export async function getPriceRules(
    connection: Connection,
    id: number,
): Promise<{ special: Special | null; notMigrated: string[] }> {
    const { dbPrefix } = getSettings();

    // Dates are compared in SQL: OpenCart stores "no date" as 0000-00-00,
    // which isn't a valid JavaScript date.
    const [specials] = await connection.execute<SpecialRow[]>(
        `SELECT ps.price,
            ps.customer_group_id = (SELECT value FROM \`${dbPrefix}setting\`
                WHERE store_id = 0 AND \`key\` = 'config_customer_group_id') AS for_default_group,
            (ps.date_start = '0000-00-00' OR ps.date_start < NOW()) AS started,
            (ps.date_end <> '0000-00-00' AND ps.date_end <= NOW()) AS ended,
            CAST(ps.date_start AS CHAR) AS date_start,
            CAST(ps.date_end AS CHAR) AS date_end
        FROM \`${dbPrefix}product_special\` ps
        WHERE ps.product_id = ?
        ORDER BY ps.priority, ps.price`,
        [id],
    );

    const notMigrated: string[] = [];
    let special: Special | null = null;

    for (const row of specials) {
        const price = Number(row.price).toFixed(2);
        if (row.ended) continue; // already over in OpenCart too
        if (!row.for_default_group)
            notMigrated.push(`special price ${price} for another customer group`);
        else if (!row.started)
            notMigrated.push(`special price ${price} starting ${row.date_start}`);
        // The first active one wins, as in OpenCart (lowest priority, then lowest price).
        else if (!special)
            special = {
                price: Number(row.price),
                endDate: row.date_end === "0000-00-00" ? null : row.date_end,
            };
    }

    const [discounts] = await connection.execute<DiscountRow[]>(
        `SELECT quantity, price FROM \`${dbPrefix}product_discount\`
        WHERE product_id = ? ORDER BY quantity`,
        [id],
    );
    for (const row of discounts)
        notMigrated.push(`quantity discount: ${row.quantity}+ for ${Number(row.price).toFixed(2)} each`);

    return { special, notMigrated };
}

export interface Category {
    id: number;
    name: string;
    description: string;
    /** Path inside OpenCart's image folder, or null. */
    image: string | null;
    /** SEO URL keyword for store 0 and LANGUAGE_ID, or null if none is set. */
    seoKeyword: string | null;
    enabled: boolean;
}

interface CategoryRow extends RowDataPacket {
    category_id: number;
    name: string | null;
    description: string | null;
    image: string | null;
    keyword: string | null;
    status: number;
}

// The categories a product is in.
export async function getProductCategories(
    connection: Connection,
    id: number,
): Promise<Category[]> {
    const { dbPrefix, languageId } = getSettings();

    const [rows] = await connection.execute<CategoryRow[]>(
        `SELECT c.category_id, cd.name, cd.description, c.image, su.keyword, c.status
        FROM \`${dbPrefix}product_to_category\` ptc
        JOIN \`${dbPrefix}category\` c ON c.category_id = ptc.category_id
        LEFT JOIN \`${dbPrefix}category_description\` cd
            ON cd.category_id = c.category_id AND cd.language_id = ?
        LEFT JOIN \`${dbPrefix}seo_url\` su
            ON su.query = CONCAT('category_id=', c.category_id) AND su.store_id = 0 AND su.language_id = ?
        WHERE ptc.product_id = ?
        ORDER BY c.sort_order, c.category_id`,
        [languageId, languageId, id],
    );

    return rows.map((row) => ({
        id: row.category_id,
        name: decode(row.name ?? ""),
        description: decode(row.description ?? ""),
        image: row.image?.trim() || null,
        seoKeyword: row.keyword || null,
        enabled: row.status === 1,
    }));
}

interface ProductIdRow extends RowDataPacket {
    product_id: number;
}

// Every product ID in OpenCart, in order.
export async function getProductIds(connection: Connection): Promise<number[]> {
    const { dbPrefix } = getSettings();
    const [rows] = await connection.execute<ProductIdRow[]>(
        `SELECT product_id FROM \`${dbPrefix}product\` ORDER BY product_id`,
    );
    return rows.map((row) => row.product_id);
}
