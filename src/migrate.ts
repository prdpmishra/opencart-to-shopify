import type { Connection } from "mysql2/promise";
import { connect, getProduct } from "./opencart.ts";
import { toProductSetInput } from "./convert.ts";
import { findMapping } from "./mapping.ts";

async function main() {
    const id = Number(process.argv[2]);
    if (!Number.isInteger(id) || id < 1) {
        console.error("Usage: npm run migrate -- <opencart-product-id>");
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
