import mysql, { type RowDataPacket, type Connection } from "mysql2/promise";
import { decode } from "he";

interface ProductRow extends RowDataPacket {
    product_id: number;
    price: string;
    name: string | null;
}

interface Product {
    id: number;
    price: string;
    name: string;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined)
        throw new Error(`Missing environment variable: ${name}`);

    return value;
}

async function main() {
    let connection: Connection | undefined;

    try {
        const dbHost = requireEnv("DB_HOST");
        const dbUser = requireEnv("DB_USER");
        const dbPassword = requireEnv("DB_PASSWORD");
        const dbName = requireEnv("DB_NAME");

        connection = await mysql.createConnection({
            host: dbHost,
            user: dbUser,
            password: dbPassword,
            database: dbName,
        });

        console.log("Connected to OpenCart database");

        const dbPrefix = process.env.DB_PREFIX || "";
        const languageId = Number(process.env.LANGUAGE_ID || 1);

        if (!Number.isInteger(languageId))
            throw new Error("LANGUAGE_ID must be a whole number.");

        const [results] = await connection.execute<ProductRow[]>(
            `SELECT p.product_id, p.price, pd.name FROM \`${dbPrefix}product\` p LEFT JOIN \`${dbPrefix}product_description\` pd ON (p.product_id = pd.product_id) AND pd.language_id = ? ORDER BY p.product_id LIMIT 20`,
            [languageId],
        );

        const products = results.map(
            (row): Product => ({
                id: row.product_id,
                name: decode(row.name ?? ""),
                price: row.price,
            }),
        );

        console.log(products);
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
