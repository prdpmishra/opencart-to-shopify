import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { connect, getProduct } from "./opencart.ts";
import { toProductSetInput } from "./convert.ts";
import { findMapping } from "./mapping.ts";

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

        console.log("Creating the product in Shopify is not implemented yet.");
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
