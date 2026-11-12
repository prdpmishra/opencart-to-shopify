import mysql, { type RowDataPacket, type Connection } from "mysql2/promise";
import { decode } from "he";
import { zonedTimeToUtc } from "./convert.ts";
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
    manufacturer_id: number;
    manufacturer_keyword: string | null;
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
    manufacturerId: number;
    /** SEO URL keyword of the manufacturer page, or null. */
    manufacturerSeoKeyword: string | null;
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
            pd.meta_title, pd.meta_description, pd.tag, m.name AS manufacturer, p.manufacturer_id,
            (SELECT keyword FROM \`${dbPrefix}seo_url\` msu
                WHERE msu.query = CONCAT('manufacturer_id=', p.manufacturer_id)
                    AND msu.store_id = 0 AND msu.language_id = pd.language_id) AS manufacturer_keyword
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
        manufacturerId: row.manufacturer_id,
        manufacturerSeoKeyword: row.manufacturer_keyword || null,
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

/** A quantity discount tier: buying `quantity` or more costs `price` each. */
export interface QuantityDiscount {
    quantity: number;
    price: number;
    /** When the tier starts, or null when it has no start date. */
    startsAt: Date | null;
    /** When the tier ends, or null when it has no end date. */
    endsAt: Date | null;
}

interface DiscountRow extends RowDataPacket {
    quantity: number;
    price: string;
    for_default_group: number;
    // Seconds since 1970, or null for 0000-00-00 ("no date").
    starts_at: number | null;
    ends_at: number | null;
}

// The special price OpenCart shows right now to the default customer group, its
// quantity discount tiers that aren't over yet, plus notes about price rules
// that are not migrated (other groups, future specials).
export async function getPriceRules(
    connection: Connection,
    id: number,
): Promise<{ special: Special | null; discounts: QuantityDiscount[]; notMigrated: string[] }> {
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

    // OpenCart compares the dates with MySQL's NOW(), so MySQL turns them into
    // moments too (UNIX_TIMESTAMP uses the same time zone as NOW()).
    const [rows] = await connection.execute<DiscountRow[]>(
        `SELECT pd.quantity, pd.price,
            pd.customer_group_id = (SELECT value FROM \`${dbPrefix}setting\`
                WHERE store_id = 0 AND \`key\` = 'config_customer_group_id') AS for_default_group,
            IF(pd.date_start = '0000-00-00', NULL, UNIX_TIMESTAMP(pd.date_start)) AS starts_at,
            IF(pd.date_end = '0000-00-00', NULL, UNIX_TIMESTAMP(pd.date_end)) AS ends_at
        FROM \`${dbPrefix}product_discount\` pd
        WHERE pd.product_id = ? AND (pd.date_end = '0000-00-00' OR pd.date_end > NOW())
        ORDER BY pd.quantity, pd.priority, pd.price`,
        [id],
    );

    const discounts: QuantityDiscount[] = [];
    for (const row of rows) {
        const tier = `quantity discount: ${row.quantity}+ for ${Number(row.price).toFixed(2)} each`;
        if (!row.for_default_group) notMigrated.push(`${tier} for another customer group`);
        // OpenCart picks one tier per quantity (lowest priority, then lowest price); Shopify needs one.
        else if (discounts.some((d) => d.quantity === row.quantity))
            notMigrated.push(`${tier} (another tier for the same quantity is used)`);
        else
            discounts.push({
                quantity: row.quantity,
                price: Number(row.price),
                startsAt: row.starts_at === null ? null : new Date(Number(row.starts_at) * 1000),
                endsAt: row.ends_at === null ? null : new Date(Number(row.ends_at) * 1000),
            });
    }

    return { special, discounts, notMigrated };
}

export interface Attribute {
    id: number;
    name: string;
    /** The attribute group, e.g. "Processor"; Shopify has no groups. */
    group: string;
    /** The product's value, e.g. "6.1 inch". */
    text: string;
}

interface AttributeRow extends RowDataPacket {
    attribute_id: number;
    name: string | null;
    group_name: string | null;
    text: string;
}

// The product's attributes (OpenCart's "Specification" tab), in the order OpenCart
// shows them: by group, then attribute, each by sort order and then name.
export async function getProductAttributes(connection: Connection, id: number): Promise<Attribute[]> {
    const { dbPrefix, languageId } = getSettings();

    const [rows] = await connection.execute<AttributeRow[]>(
        `SELECT a.attribute_id, ad.name, agd.name AS group_name, pa.text
        FROM \`${dbPrefix}product_attribute\` pa
        JOIN \`${dbPrefix}attribute\` a ON a.attribute_id = pa.attribute_id
        JOIN \`${dbPrefix}attribute_group\` ag ON ag.attribute_group_id = a.attribute_group_id
        LEFT JOIN \`${dbPrefix}attribute_description\` ad
            ON ad.attribute_id = a.attribute_id AND ad.language_id = pa.language_id
        LEFT JOIN \`${dbPrefix}attribute_group_description\` agd
            ON agd.attribute_group_id = ag.attribute_group_id AND agd.language_id = pa.language_id
        WHERE pa.product_id = ? AND pa.language_id = ?
        ORDER BY ag.sort_order, agd.name, a.sort_order, ad.name`,
        [id, languageId],
    );

    return rows.map((row) => ({
        id: row.attribute_id,
        name: decode(row.name ?? ""),
        group: decode(row.group_name ?? ""),
        text: decode(row.text),
    }));
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
    /** Category IDs from the top level down to this one, e.g. [20, 27] for Desktops › Mac. */
    pathIds: number[];
    /** The SEO keywords of pathIds, or null when one of them has none. */
    pathKeywords: string[] | null;
}

interface CategoryPathRow extends RowDataPacket {
    category_id: number;
    path_id: number;
    keyword: string | null;
}

interface CategoryRow extends RowDataPacket {
    category_id: number;
    parent_id: number;
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
        `SELECT c.category_id, c.parent_id, cd.name, cd.description, c.image, su.keyword, c.status
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

    return toCategories(connection, rows);
}

export interface MenuCategory {
    category: Category;
    /** Its subcategories, in menu order. */
    children: Category[];
}

// The categories in OpenCart's header menu, picked the way its common/menu
// controller does: enabled top-level categories with "Show in top menu" on, each
// with its enabled subcategories, all in the default store, sorted by sort order
// and then name.
export async function getMenuCategories(connection: Connection): Promise<MenuCategory[]> {
    const { dbPrefix, languageId } = getSettings();

    const [rows] = await connection.execute<CategoryRow[]>(
        `SELECT c.category_id, c.parent_id, cd.name, cd.description, c.image, su.keyword, c.status
        FROM \`${dbPrefix}category\` c
        JOIN \`${dbPrefix}category_to_store\` c2s ON c2s.category_id = c.category_id AND c2s.store_id = 0
        JOIN \`${dbPrefix}category_description\` cd
            ON cd.category_id = c.category_id AND cd.language_id = ?
        LEFT JOIN \`${dbPrefix}seo_url\` su
            ON su.query = CONCAT('category_id=', c.category_id) AND su.store_id = 0 AND su.language_id = ?
        WHERE c.status = 1 AND (
            (c.parent_id = 0 AND c.top = 1)
            OR c.parent_id IN (SELECT category_id FROM \`${dbPrefix}category\` WHERE parent_id = 0 AND top = 1)
        )
        ORDER BY c.sort_order, LCASE(cd.name)`,
        [languageId, languageId],
    );

    const categories = (await toCategories(connection, rows)).map((category, i) => ({
        category,
        parentId: rows[i]?.parent_id,
    }));
    // Subcategories of a top-level category that isn't in the menu (disabled,
    // not in the default store) aren't shown either: no parent here to go under.
    return categories
        .filter(({ parentId }) => parentId === 0)
        .map(({ category }) => ({
            category,
            children: categories
                .filter(({ parentId }) => parentId === category.id)
                .map((child) => child.category),
        }));
}

// Turns category rows into Categories, adding each one's path from category_path.
async function toCategories(connection: Connection, rows: CategoryRow[]): Promise<Category[]> {
    if (rows.length === 0) return [];
    const { dbPrefix, languageId } = getSettings();

    // OpenCart's category_path lists every category's ancestors with their level.
    const ids = rows.map((row) => row.category_id);
    const [paths] = await connection.query<CategoryPathRow[]>(
        `SELECT cp.category_id, cp.path_id, su.keyword
        FROM \`${dbPrefix}category_path\` cp
        LEFT JOIN \`${dbPrefix}seo_url\` su
            ON su.query = CONCAT('category_id=', cp.path_id) AND su.store_id = 0 AND su.language_id = ?
        WHERE cp.category_id IN (?)
        ORDER BY cp.category_id, cp.level`,
        [languageId, ids],
    );

    return rows.map((row) => {
        const path = paths.filter((p) => p.category_id === row.category_id);
        const keywords = path.map((p) => p.keyword || null);
        return {
            id: row.category_id,
            name: decode(row.name ?? ""),
            description: decode(row.description ?? ""),
            image: row.image?.trim() || null,
            seoKeyword: row.keyword || null,
            enabled: row.status === 1,
            pathIds: path.map((p) => p.path_id),
            pathKeywords: keywords.every((k) => k !== null) ? (keywords as string[]) : null,
        };
    });
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

// Whether OpenCart's "Use SEO URLs" setting is on (URLs like /desktops/mac instead of index.php?...).
export async function getSeoUrlsEnabled(connection: Connection): Promise<boolean> {
    const { dbPrefix } = getSettings();
    const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT value FROM \`${dbPrefix}setting\` WHERE store_id = 0 AND \`key\` = 'config_seo_url'`,
    );
    return rows[0]?.value === "1";
}

export interface CustomerAddress {
    id: number;
    firstName: string;
    lastName: string;
    company: string;
    address1: string;
    address2: string;
    city: string;
    postcode: string;
    /** ISO 3166-1 alpha-2, e.g. "NL"; empty if the country was deleted. */
    countryCode: string;
    /** OpenCart's zone code, e.g. "UP"; empty if none. */
    zoneCode: string;
    zoneName: string;
}

export interface Customer {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    telephone: string;
    newsletter: boolean;
    enabled: boolean;
    /** The customer group name, or null for the store's default group. */
    group: string | null;
    /** e.g. "2026-02-19" */
    dateAdded: string;
    addresses: CustomerAddress[];
    /** The default address's ID, if it is one of the customer's addresses. */
    defaultAddressId: number | null;
}

interface CustomerRow extends RowDataPacket {
    customer_id: number;
    firstname: string;
    lastname: string;
    email: string;
    telephone: string;
    newsletter: number;
    status: number;
    address_id: number;
    group_name: string | null;
    is_default_group: number;
    date_added: string;
}

interface AddressRow extends RowDataPacket {
    address_id: number;
    firstname: string;
    lastname: string;
    company: string;
    address_1: string;
    address_2: string;
    city: string;
    postcode: string;
    iso_code_2: string | null;
    zone_code: string | null;
    zone_name: string | null;
}

export async function getCustomer(connection: Connection, id: number): Promise<Customer> {
    const { dbPrefix, languageId } = getSettings();

    // The date is formatted in SQL, so the JavaScript time zone can't shift it.
    const [rows] = await connection.execute<CustomerRow[]>(
        `SELECT c.customer_id, c.firstname, c.lastname, c.email, c.telephone,
            c.newsletter, c.status, c.address_id, cgd.name AS group_name,
            c.customer_group_id = (SELECT value FROM \`${dbPrefix}setting\`
                WHERE store_id = 0 AND \`key\` = 'config_customer_group_id') AS is_default_group,
            DATE_FORMAT(c.date_added, '%Y-%m-%d') AS date_added
        FROM \`${dbPrefix}customer\` c
        LEFT JOIN \`${dbPrefix}customer_group_description\` cgd
            ON cgd.customer_group_id = c.customer_group_id AND cgd.language_id = ?
        WHERE c.customer_id = ?`,
        [languageId, id],
    );
    const row = rows[0];
    if (!row) throw new Error(`OpenCart has no customer with ID ${id}.`);

    const [addressRows] = await connection.execute<AddressRow[]>(
        `SELECT a.address_id, a.firstname, a.lastname, a.company, a.address_1, a.address_2,
            a.city, a.postcode, co.iso_code_2, z.code AS zone_code, z.name AS zone_name
        FROM \`${dbPrefix}address\` a
        LEFT JOIN \`${dbPrefix}country\` co ON co.country_id = a.country_id
        LEFT JOIN \`${dbPrefix}zone\` z ON z.zone_id = a.zone_id
        WHERE a.customer_id = ?
        ORDER BY a.address_id`,
        [id],
    );

    const addresses = addressRows.map((a) => ({
        id: a.address_id,
        firstName: decode(a.firstname),
        lastName: decode(a.lastname),
        company: decode(a.company),
        address1: decode(a.address_1),
        address2: decode(a.address_2),
        city: decode(a.city),
        postcode: decode(a.postcode),
        countryCode: a.iso_code_2 ?? "",
        zoneCode: a.zone_code ?? "",
        zoneName: decode(a.zone_name ?? ""),
    }));

    return {
        id: row.customer_id,
        firstName: decode(row.firstname),
        lastName: decode(row.lastname),
        email: row.email,
        telephone: row.telephone,
        newsletter: row.newsletter === 1,
        enabled: row.status === 1,
        group: row.is_default_group ? null : decode(row.group_name ?? ""),
        dateAdded: row.date_added,
        addresses,
        defaultAddressId: addresses.some((a) => a.id === row.address_id) ? row.address_id : null,
    };
}

// Every customer ID in OpenCart, in order.
export async function getCustomerIds(connection: Connection): Promise<number[]> {
    const { dbPrefix } = getSettings();
    const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT customer_id FROM \`${dbPrefix}customer\` ORDER BY customer_id`,
    );
    return rows.map((row) => row.customer_id as number);
}

// The store's default currency, e.g. "USD". OpenCart stores order amounts in it.
export async function getStoreCurrency(connection: Connection): Promise<string> {
    const { dbPrefix } = getSettings();
    const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT value FROM \`${dbPrefix}setting\` WHERE store_id = 0 AND \`key\` = 'config_currency'`,
    );
    if (!rows[0]) throw new Error("OpenCart has no default currency (config_currency).");
    return rows[0].value as string;
}

export type OrderAddress = Omit<CustomerAddress, "id">;

export interface OrderLine {
    productId: number;
    name: string;
    model: string;
    quantity: number;
    /** Unit price, excluding tax. */
    price: number;
    /** The line's total, excluding tax. Normally price × quantity. */
    total: number;
    /** Tax per unit. */
    tax: number;
    /** The options the customer chose, e.g. { name: "Size", value: "Small", type: "select" }. */
    options: { name: string; value: string; type: string }[];
}

export interface Order {
    id: number;
    /** 0 for a guest order. */
    customerId: number;
    email: string;
    telephone: string;
    /** 0 for a "missing order": a checkout that was never confirmed. */
    statusId: number;
    statusName: string;
    /** What the customer paid in, e.g. "EUR", and its rate to the store's currency. */
    currencyCode: string;
    currencyValue: number;
    /** All amounts are in the store's default currency. */
    total: number;
    comment: string;
    /** Plain text, e.g. "iDEAL" (OpenCart may store HTML with a logo). */
    paymentMethod: string;
    shippingCode: string;
    payment: OrderAddress;
    /** null when nothing in the order needed shipping. */
    shipping: OrderAddress | null;
    /** As OpenCart shows it, e.g. "2026-06-04 22:53". */
    dateAdded: string;
    /** The same moment, as a UTC ISO string for Shopify. */
    processedAt: string;
    /** When the order last changed (e.g. its status), as a UTC ISO string. */
    modifiedAt: string;
    lines: OrderLine[];
    /** OpenCart's order totals: sub_total, shipping, tax, total, coupon... */
    totals: { code: string; title: string; value: number }[];
    /** Status changes that have a comment. */
    history: { statusName: string; comment: string; dateAdded: string }[];
}

type OrderRow = RowDataPacket & Record<string, string | number | null>;

// The address fields of an order row, for prefix "payment" or "shipping".
function orderAddress(row: OrderRow, prefix: string): OrderAddress {
    const text = (field: string) => decode(String(row[`${prefix}_${field}`] ?? ""));
    return {
        firstName: text("firstname"),
        lastName: text("lastname"),
        company: text("company"),
        address1: text("address_1"),
        address2: text("address_2"),
        city: text("city"),
        postcode: text("postcode"),
        countryCode: text("iso_code_2"),
        zoneCode: text("zone_code"),
        zoneName: text("zone"),
    };
}

export async function getOrder(connection: Connection, id: number): Promise<Order> {
    const { dbPrefix, languageId } = getSettings();

    // OpenCart writes dates in PHP's time zone (it sets MySQL's session time zone
    // to match), which can differ from MySQL's own. So dates are read as text,
    // as OpenCart shows them, and converted with OPENCART_TIMEZONE.
    const timeZone = requireEnv("OPENCART_TIMEZONE");
    const [rows] = await connection.execute<OrderRow[]>(
        `SELECT o.*, os.name AS status_name,
            pc.iso_code_2 AS payment_iso_code_2, pz.code AS payment_zone_code,
            sc.iso_code_2 AS shipping_iso_code_2, sz.code AS shipping_zone_code,
            DATE_FORMAT(o.date_added, '%Y-%m-%d %H:%i:%s') AS added_text,
            DATE_FORMAT(o.date_modified, '%Y-%m-%d %H:%i:%s') AS modified_text
        FROM \`${dbPrefix}order\` o
        LEFT JOIN \`${dbPrefix}order_status\` os
            ON os.order_status_id = o.order_status_id AND os.language_id = ?
        LEFT JOIN \`${dbPrefix}country\` pc ON pc.country_id = o.payment_country_id
        LEFT JOIN \`${dbPrefix}zone\` pz ON pz.zone_id = o.payment_zone_id
        LEFT JOIN \`${dbPrefix}country\` sc ON sc.country_id = o.shipping_country_id
        LEFT JOIN \`${dbPrefix}zone\` sz ON sz.zone_id = o.shipping_zone_id
        WHERE o.order_id = ?`,
        [languageId, id],
    );
    const row = rows[0];
    if (!row) throw new Error(`OpenCart has no order with ID ${id}.`);

    const [lineRows] = await connection.execute<RowDataPacket[]>(
        `SELECT order_product_id, product_id, name, model, quantity, price, total, tax
        FROM \`${dbPrefix}order_product\` WHERE order_id = ? ORDER BY order_product_id`,
        [id],
    );
    const [optionRows] = await connection.execute<RowDataPacket[]>(
        `SELECT order_product_id, name, value, type
        FROM \`${dbPrefix}order_option\` WHERE order_id = ? ORDER BY order_option_id`,
        [id],
    );
    const [totalRows] = await connection.execute<RowDataPacket[]>(
        `SELECT code, title, value FROM \`${dbPrefix}order_total\` WHERE order_id = ? ORDER BY sort_order`,
        [id],
    );
    const [historyRows] = await connection.execute<RowDataPacket[]>(
        `SELECT os.name AS status_name, oh.comment, DATE_FORMAT(oh.date_added, '%Y-%m-%d %H:%i') AS added_text
        FROM \`${dbPrefix}order_history\` oh
        LEFT JOIN \`${dbPrefix}order_status\` os
            ON os.order_status_id = oh.order_status_id AND os.language_id = ?
        WHERE oh.order_id = ? AND oh.comment <> ''
        ORDER BY oh.date_added, oh.order_history_id`,
        [languageId, id],
    );

    return {
        id: Number(row.order_id),
        customerId: Number(row.customer_id),
        email: String(row.email),
        telephone: String(row.telephone),
        statusId: Number(row.order_status_id),
        statusName: decode(String(row.status_name ?? "")),
        currencyCode: String(row.currency_code),
        currencyValue: Number(row.currency_value),
        total: Number(row.total),
        comment: decode(String(row.comment ?? "")),
        // Payment extensions like Mollie put a logo <img> before the name.
        paymentMethod: decode(String(row.payment_method ?? "").replace(/<[^>]*>/g, "")).trim(),
        shippingCode: String(row.shipping_code ?? ""),
        payment: orderAddress(row, "payment"),
        shipping: row.shipping_method ? orderAddress(row, "shipping") : null,
        dateAdded: String(row.added_text).slice(0, 16),
        processedAt: zonedTimeToUtc(String(row.added_text), timeZone),
        modifiedAt: zonedTimeToUtc(String(row.modified_text), timeZone),
        lines: lineRows.map((line) => ({
            productId: line.product_id,
            name: decode(line.name),
            model: decode(line.model),
            quantity: line.quantity,
            price: Number(line.price),
            total: Number(line.total),
            tax: Number(line.tax),
            options: optionRows
                .filter((option) => option.order_product_id === line.order_product_id)
                .map((option) => ({ name: decode(option.name), value: decode(option.value), type: option.type })),
        })),
        totals: totalRows.map((total) => ({ code: total.code, title: decode(total.title), value: Number(total.value) })),
        history: historyRows.map((history) => ({
            statusName: decode(history.status_name ?? ""),
            comment: decode(history.comment),
            dateAdded: history.added_text,
        })),
    };
}

// Every real order ID, in order. Orders with status 0 are left out: they are
// OpenCart's "missing orders", checkouts the customer never completed.
export async function getOrderIds(connection: Connection): Promise<number[]> {
    const { dbPrefix } = getSettings();
    const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT order_id FROM \`${dbPrefix}order\` WHERE order_status_id > 0 ORDER BY order_id`,
    );
    return rows.map((row) => row.order_id as number);
}
