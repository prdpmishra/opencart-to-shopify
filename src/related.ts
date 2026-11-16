// Copies OpenCart's "Related Products" links to Shopify's standard "Related products"
// metafield (from Search & Discovery), which the storefront's product recommendations use.
// OpenCart is the source of truth: a migrated product's related list is replaced, and
// cleared when it has no links in OpenCart. Run it after the products are migrated.
//
// Usage: npm run related -- [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import { findMapping, saveStateOnce } from "./mapping.ts";
import { connect, getProductIds, getRelatedProducts } from "./opencart.ts";
import {
    deleteProductMetafields,
    enableStandardProductMetafieldDefinition,
    findProductMetafieldDefinition,
    getProductMetafieldValues,
    setProductMetafields,
} from "./shopify.ts";

const USAGE = "Usage: npm run related -- [--dry-run]";
const NAMESPACE = "shopify--discovery--product_recommendation";
const KEY = "related_products";

interface Change {
    opencartId: number;
    shopifyId: string;
    relatedOpencartIds: number[];
    relatedShopifyIds: string[];
}

async function main() {
    let dryRun: boolean;
    try {
        const args = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
        dryRun = args.values["dry-run"];
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    let connection: Connection | undefined;
    try {
        connection = await connect();
        const productIds = await getProductIds(connection);
        const related = await getRelatedProducts(connection);

        // What each migrated product's list should be.
        const wanted: Change[] = [];
        for (const opencartId of productIds) {
            const links = related.get(opencartId) ?? [];
            const mapping = findMapping("product", opencartId);
            if (!mapping) {
                if (links.length > 0)
                    console.warn(`Warning: product ${opencartId} is not migrated; its related products are skipped.`);
                continue;
            }
            const relatedOpencartIds: number[] = [];
            const relatedShopifyIds: string[] = [];
            for (const relatedId of links) {
                const relatedMapping = findMapping("product", relatedId);
                if (!relatedMapping) {
                    console.warn(`Warning: product ${opencartId}: related product ${relatedId} is not migrated; left out.`);
                    continue;
                }
                relatedOpencartIds.push(relatedId);
                relatedShopifyIds.push(relatedMapping.shopify_id);
            }
            wanted.push({ opencartId, shopifyId: mapping.shopify_id, relatedOpencartIds, relatedShopifyIds });
        }

        const current = await getProductMetafieldValues(wanted.map((w) => w.shopifyId), NAMESPACE, KEY);
        const changes: Change[] = [];
        let unchanged = 0;
        for (const w of wanted) {
            if (!current.has(w.shopifyId)) {
                console.warn(`Warning: product ${w.opencartId} is no longer in Shopify (${w.shopifyId}); skipped.`);
                continue;
            }
            const value = current.get(w.shopifyId);
            const now: string[] = value ? JSON.parse(value) : [];
            if (JSON.stringify(now) === JSON.stringify(w.relatedShopifyIds)) unchanged++;
            else changes.push(w);
        }

        if (changes.some((c) => c.relatedShopifyIds.length > 0)) {
            if (await findProductMetafieldDefinition(NAMESPACE, KEY)) {
                // Already enabled.
            } else if (dryRun) {
                console.log(`Would enable Shopify's standard "Related products" metafield definition.`);
            } else {
                await enableStandardProductMetafieldDefinition(NAMESPACE, KEY);
                // So a rollback turns it off again (it stays on if it was on before).
                saveStateOnce("related-definition-enabled", "1");
                console.log(`Enabled Shopify's standard "Related products" metafield definition.`);
            }
        }

        for (const c of changes) {
            if (c.relatedShopifyIds.length === 0) {
                console.log(`${dryRun ? "Would clear" : "Cleared"} product ${c.opencartId}'s related products (none in OpenCart).`);
                if (!dryRun) await deleteProductMetafields(c.shopifyId, [{ namespace: NAMESPACE, key: KEY }]);
            } else {
                console.log(`${dryRun ? "Would set" : "Set"} product ${c.opencartId}'s related products: ${c.relatedOpencartIds.join(", ")}.`);
                if (!dryRun)
                    await setProductMetafields(c.shopifyId, [
                        { namespace: NAMESPACE, key: KEY, type: "list.product_reference", value: JSON.stringify(c.relatedShopifyIds) },
                    ]);
            }
        }
        console.log(`Done: ${changes.length} ${dryRun ? "to change" : "changed"}, ${unchanged} up to date.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        await connection?.end();
    }
}

await main();
