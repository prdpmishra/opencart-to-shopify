import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { connect, getProduct } from "./opencart.ts";
import { toProductSetInput } from "./convert.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import { adminProductUrl, createProduct } from "./shopify.ts";

const USAGE = "Usage: npm run migrate -- <opencart-product-id> [--dry-run]";

async function main() {
    let args;
    try {
        // strict: an unknown flag (e.g. a typo of --dry-run) is an error, not ignored.
        args = parseArgs({
            allowPositionals: true,
            options: { "dry-run": { type: "boolean", default: false } },
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const dryRun = args.values["dry-run"];
    const id = Number(args.positionals[0]);
    if (args.positionals.length !== 1 || !Number.isInteger(id) || id < 1) {
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const existing = findMapping("product", id);
    if (existing) {
        console.log(
            `Product ${id} was already migrated to ${existing.shopify_id} on ${existing.migrated_at} (UTC). Nothing to do.`,
        );
        return;
    }

    let connection: Connection | undefined;

    try {
        connection = await connect();
        const input = toProductSetInput(await getProduct(connection, id));
        console.log(JSON.stringify(input, null, 2));

        if (dryRun) {
            console.log("Dry run: Shopify was not called and no mapping was saved.");
            return;
        }

        const created = await createProduct(input);

        if (created.handle !== input.handle)
            console.log(
                `Product ${id}: handle "${input.handle}" was taken, Shopify used "${created.handle}"`,
            );

        // Only save the mapping once the product fully exists in Shopify.
        try {
            saveMapping("product", id, created.id);
        } catch (error) {
            throw new Error(
                `Product was created in Shopify as ${created.id}, but saving the mapping failed ` +
                    `(${error instanceof Error ? error.message : error}). ` +
                    "Add the mapping by hand or delete the Shopify product before running again.",
            );
        }

        console.log(
            `Created product ${id} in Shopify as a draft: ${created.id}\n` +
                `  handle: ${created.handle}, price: ${created.price}, sku: ${created.sku ?? "(none)"}\n` +
                `  ${adminProductUrl(created.id)}`,
        );
    } catch (error) {
        console.error(
            "Something went wrong:",
            error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

main();
