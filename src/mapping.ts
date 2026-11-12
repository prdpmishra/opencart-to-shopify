import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// "attribute" maps an OpenCart attribute to a Shopify metafield definition,
// "customer" an OpenCart customer to a Shopify customer, "address" a customer
// address to a Shopify customer address, "order" an OpenCart order to a Shopify order.
export type EntityType = "product" | "category" | "attribute" | "customer" | "address" | "order";

export interface Mapping {
    opencart_id: number;
    entity_type: EntityType;
    shopify_id: string;
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
        )
    `);
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
): void {
    getDb()
        .prepare(
            "INSERT INTO mapping (opencart_id, entity_type, shopify_id) VALUES (?, ?, ?)",
        )
        .run(opencartId, entityType, shopifyId);
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
