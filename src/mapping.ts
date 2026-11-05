import { DatabaseSync } from "node:sqlite";

export type EntityType = "product";

export interface Mapping {
    opencart_id: number;
    entity_type: EntityType;
    shopify_id: string;
    migrated_at: string;
}

let db: DatabaseSync | undefined;

// Opened on first use, so just importing this module doesn't create the file.
function getDb(): DatabaseSync {
    if (db) return db;

    db = new DatabaseSync("migration.sqlite");
    db.exec(`
        CREATE TABLE IF NOT EXISTS mapping (
            opencart_id INTEGER NOT NULL,
            entity_type TEXT NOT NULL,
            shopify_id TEXT NOT NULL,
            migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, opencart_id)
        )
    `);
    return db;
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
