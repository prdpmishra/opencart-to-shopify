import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// "attribute" maps an OpenCart attribute to a Shopify metafield definition,
// "customer" an OpenCart customer to a Shopify customer, "address" a customer
// address to a Shopify customer address, "order" an OpenCart order to a Shopify order.
// A "linked" row points at something that already existed in Shopify (e.g. a
// customer with the same email): a rollback keeps it.
export type EntityType = "product" | "category" | "attribute" | "customer" | "address" | "order";

export interface Mapping {
    opencart_id: number;
    entity_type: EntityType;
    shopify_id: string;
    linked: number; // 1: already existed in Shopify, 0: created by the migration
    migrated_at: string;
}

let db: DatabaseSync | undefined;

// Opened on first use, so just importing this module doesn't create the file.
// Always in the project folder (next to src/), whichever folder the script is
// started from: a second, empty mapping file would lead to duplicate products.
function getDb(): DatabaseSync {
    if (db) return db;

    db = new DatabaseSync(join(import.meta.dirname, "..", "migration.sqlite"));
    db.exec(`
        CREATE TABLE IF NOT EXISTS mapping (
            opencart_id INTEGER NOT NULL,
            entity_type TEXT NOT NULL,
            shopify_id TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, opencart_id)
        );
        CREATE TABLE IF NOT EXISTS file_mapping (
            opencart_path TEXT PRIMARY KEY,
            shopify_id TEXT NOT NULL,
            shopify_url TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS redirect_mapping (
            path TEXT PRIMARY KEY,
            shopify_id TEXT NOT NULL,
            target TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS unaccepted_province (
            country_code TEXT NOT NULL,
            province_code TEXT NOT NULL,
            rejected INTEGER NOT NULL, -- 1: Shopify refused it, 0: Shopify dropped it
            PRIMARY KEY (country_code, province_code)
        );
        CREATE TABLE IF NOT EXISTS discount_mapping (
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            shopify_id TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (product_id, quantity)
        );
        -- Made in Shopify as a side effect of creating an order: a customer Shopify
        -- created for a guest order's email, or an address Shopify added to the
        -- address book of a customer that already existed.
        CREATE TABLE IF NOT EXISTS order_side_effect (
            shopify_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL, -- the customer itself, or the address's customer
            order_id INTEGER NOT NULL, -- the OpenCart order
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        -- What the migration changed in Shopify that isn't an item of its own,
        -- e.g. the menu items before they were replaced.
        CREATE TABLE IF NOT EXISTS saved_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);
    // Mapping files from before the linked column.
    const columns = db.prepare("PRAGMA table_info(mapping)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "linked"))
        db.exec("ALTER TABLE mapping ADD COLUMN linked INTEGER NOT NULL DEFAULT 0");
    return db;
}

// Files uploaded to Shopify Files, keyed by their path in OpenCart's image folder
// (e.g. "catalog/demo/ipod_classic_3.jpg").
export interface FileMapping {
    opencart_path: string;
    shopify_id: string;
    shopify_url: string;
    migrated_at: string;
}

export function findFileMapping(opencartPath: string): FileMapping | undefined {
    return getDb()
        .prepare("SELECT * FROM file_mapping WHERE opencart_path = ?")
        .get(opencartPath) as FileMapping | undefined;
}

export function saveFileMapping(
    opencartPath: string,
    shopifyId: string,
    shopifyUrl: string,
): void {
    getDb()
        .prepare(
            "INSERT INTO file_mapping (opencart_path, shopify_id, shopify_url) VALUES (?, ?, ?)",
        )
        .run(opencartPath, shopifyId, shopifyUrl);
}

export function findMapping(
    entityType: EntityType,
    opencartId: number,
): Mapping | undefined {
    return getDb()
        .prepare(
            "SELECT * FROM mapping WHERE entity_type = ? AND opencart_id = ?",
        )
        .get(entityType, opencartId) as Mapping | undefined;
}

export function saveMapping(
    entityType: EntityType,
    opencartId: number,
    shopifyId: string,
    linked = false,
): void {
    getDb()
        .prepare(
            "INSERT INTO mapping (opencart_id, entity_type, shopify_id, linked) VALUES (?, ?, ?, ?)",
        )
        .run(opencartId, entityType, shopifyId, linked ? 1 : 0);
}

// Whether this Shopify ID was created by the migration (e.g. a collection from an OpenCart category).
export function isMappedShopifyId(entityType: EntityType, shopifyId: string): boolean {
    return (
        getDb()
            .prepare("SELECT 1 FROM mapping WHERE entity_type = ? AND shopify_id = ?")
            .get(entityType, shopifyId) !== undefined
    );
}

// URL redirects created in Shopify, keyed by the old OpenCart path they redirect from.
export interface RedirectMapping {
    path: string;
    shopify_id: string;
    target: string;
    migrated_at: string;
}

export function findRedirectMapping(path: string): RedirectMapping | undefined {
    return getDb()
        .prepare("SELECT * FROM redirect_mapping WHERE path = ?")
        .get(path) as RedirectMapping | undefined;
}

export function saveRedirectMapping(path: string, shopifyId: string, target: string): void {
    getDb()
        .prepare("INSERT INTO redirect_mapping (path, shopify_id, target) VALUES (?, ?, ?)")
        .run(path, shopifyId, target);
}

// Shopify automatic discounts created from OpenCart quantity discount tiers.
// Keyed by product and quantity: OpenCart gives the tier rows new IDs every
// time the product is saved in its admin.
export interface DiscountMapping {
    product_id: number;
    quantity: number;
    shopify_id: string;
    migrated_at: string;
}

export function findDiscountMappings(productId: number): DiscountMapping[] {
    return getDb()
        .prepare("SELECT * FROM discount_mapping WHERE product_id = ? ORDER BY quantity")
        .all(productId) as unknown as DiscountMapping[];
}

export function saveDiscountMapping(productId: number, quantity: number, shopifyId: string): void {
    getDb()
        .prepare("INSERT INTO discount_mapping (product_id, quantity, shopify_id) VALUES (?, ?, ?)")
        .run(productId, quantity, shopifyId);
}

export function deleteDiscountMapping(productId: number, quantity: number): void {
    getDb()
        .prepare("DELETE FROM discount_mapping WHERE product_id = ? AND quantity = ?")
        .run(productId, quantity);
}

export function deleteMappingByShopifyId(entityType: EntityType, shopifyId: string): void {
    getDb()
        .prepare("DELETE FROM mapping WHERE entity_type = ? AND shopify_id = ?")
        .run(entityType, shopifyId);
}

// OpenCart zone codes that Shopify doesn't keep as a province: rejected ones
// (OpenCart's Delhi is "DE", Shopify's "DL") and silently dropped ones (countries
// without provinces in Shopify, e.g. the Netherlands). They aren't sent again,
// so a province set by hand in Shopify is kept.
export function findUnacceptedProvince(
    countryCode: string,
    provinceCode: string,
): { rejected: boolean } | undefined {
    const row = getDb()
        .prepare("SELECT rejected FROM unaccepted_province WHERE country_code = ? AND province_code = ?")
        .get(countryCode, provinceCode) as { rejected: number } | undefined;
    return row && { rejected: row.rejected === 1 };
}

export function saveUnacceptedProvince(countryCode: string, provinceCode: string, rejected: boolean): void {
    getDb()
        .prepare("INSERT OR IGNORE INTO unaccepted_province (country_code, province_code, rejected) VALUES (?, ?, ?)")
        .run(countryCode, provinceCode, rejected ? 1 : 0);
}

// See the order_side_effect table. A customer is saved with its own ID as customerId.
export function saveOrderSideEffect(shopifyId: string, customerId: string, orderId: number): void {
    getDb()
        .prepare("INSERT OR IGNORE INTO order_side_effect (shopify_id, customer_id, order_id) VALUES (?, ?, ?)")
        .run(shopifyId, customerId, orderId);
}

// Saved only the first time: a later run must not overwrite what Shopify had before the migration.
export function saveStateOnce(key: string, value: string): void {
    getDb().prepare("INSERT OR IGNORE INTO saved_state (key, value) VALUES (?, ?)").run(key, value);
}

export function findState(key: string): string | undefined {
    const row = getDb().prepare("SELECT value FROM saved_state WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    return row?.value;
}

// For the rollback: everything the migration recorded.
export function listMappings(entityType: EntityType): Mapping[] {
    return getDb()
        .prepare("SELECT * FROM mapping WHERE entity_type = ? ORDER BY opencart_id")
        .all(entityType) as unknown as Mapping[];
}

// The Shopify IDs in one of the other tables (files, redirects, discounts, order side effects).
export function listShopifyIds(
    table: "file_mapping" | "redirect_mapping" | "discount_mapping" | "order_side_effect",
): string[] {
    const rows = getDb().prepare(`SELECT shopify_id FROM ${table}`).all() as { shopify_id: string }[];
    return rows.map((row) => row.shopify_id);
}

// The customers Shopify created for guest orders (side effects whose customer is themselves).
export function listGuestOrderCustomers(): string[] {
    const rows = getDb()
        .prepare("SELECT shopify_id FROM order_side_effect WHERE shopify_id = customer_id")
        .all() as { shopify_id: string }[];
    return rows.map((row) => row.shopify_id);
}

// Removes a Shopify ID from every table, once the rollback deleted it (or unlinked it).
export function forgetShopifyId(shopifyId: string): void {
    for (const table of ["mapping", "file_mapping", "redirect_mapping", "discount_mapping", "order_side_effect"])
        getDb().prepare(`DELETE FROM ${table} WHERE shopify_id = ?`).run(shopifyId);
}

export function forgetState(key: string): void {
    getDb().prepare("DELETE FROM saved_state WHERE key = ?").run(key);
}
