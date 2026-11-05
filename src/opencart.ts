import mysql, { type RowDataPacket, type Connection } from "mysql2/promise";
import { decode } from "he";
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

export async function getProducts(
    connection: Connection,
    limit = 20,
): Promise<Product[]> {
    const dbPrefix = process.env.DB_PREFIX || "";
    const languageId = Number(process.env.LANGUAGE_ID || 1);

    if (!Number.isInteger(languageId))
        throw new Error("LANGUAGE_ID must be a whole number.");
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
