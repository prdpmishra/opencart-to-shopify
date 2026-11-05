import type { Connection } from "mysql2/promise";
import { connect, getProducts } from "./opencart.ts";
import { graphql } from "./shopify.ts";

interface ProductsQuery {
    products: {
        edges: { node: { id: string; title: string; handle: string } }[];
    };
}

async function main() {
    let connection: Connection | undefined;

    try {
        connection = await connect();
        console.log("Connected to OpenCart database");
        console.log(await getProducts(connection));

        const data = await graphql<ProductsQuery>(
            "{ products(first: 3) { edges { node { id title handle } } } }",
        );
        console.log("Shopify products:", JSON.stringify(data, null, 2));
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
