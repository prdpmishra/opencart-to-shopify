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
            pd.name, pd.description, su.keyword,
            (SELECT value FROM \`${dbPrefix}setting\`
                WHERE store_id = 0 AND \`key\` = 'config_stock_checkout') AS stock_checkout
        FROM \`${dbPrefix}product\` p
        LEFT JOIN \`${dbPrefix}product_description\` pd
            ON pd.product_id = p.product_id AND pd.language_id = ?
        LEFT JOIN \`${dbPrefix}seo_url\` su
            ON su.query = CONCAT('product_id=', p.product_id) AND su.store_id = 0 AND su.language_id = ?
        WHERE p.product_id = ?`,
        [languageId, languageId, id],
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
        `SELECT pov.product_option_id, ovd.name, pov.price, pov.price_prefix, pov.quantity, pov.subtract
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
                quantity: v.quantity,
                subtractStock: v.subtract === 1,
            }));

        // An option without values offers no choice, so there is nothing to migrate.
        if (values.length > 0) options.push({ name, values });
    }

    return { options, skipped };
}
