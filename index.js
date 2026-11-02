import mysql from "mysql2/promise";
import { decode } from "he";

async function main() {
    let connection;

    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
        });

        console.log("Connected to OpenCart database");

        const dbPrefix = process.env.DB_PREFIX || "";
        const languageId = Number(process.env.LANGUAGE_ID || 1);

        const [results] = await connection.execute(
            `SELECT p.product_id, p.price, pd.name FROM \`${dbPrefix}product\` p LEFT JOIN \`${dbPrefix}product_description\` pd ON (p.product_id = pd.product_id) AND pd.language_id = ? ORDER BY p.product_id LIMIT 20`,
            [languageId],
        );

        const products = results.map((row) => ({
            id: row.product_id,
            name: decode(row.name ?? ""),
            price: row.price,
        }));

        console.log(products);
    } catch (error) {
        console.error("Something went wrong:", error.message);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

main();
