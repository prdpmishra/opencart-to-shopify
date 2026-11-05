import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { requireEnv } from "./env.ts";
import { connect, getProduct, getProductImages } from "./opencart.ts";
import { toProductSetInput } from "./convert.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import {
    adminProductUrl,
    createProduct,
    uploadImage,
    waitForImages,
} from "./shopify.ts";

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
        const product = await getProduct(connection, id);
        const input = toProductSetInput(product);
        console.log(JSON.stringify(input, null, 2));

        // Find the image files on disk. Missing ones are skipped with a warning.
        const imageDir = requireEnv("OPENCART_IMAGE_DIR");
        const imagePaths: string[] = [];
        for (const relativePath of await getProductImages(connection, id)) {
            const fullPath = join(imageDir, relativePath);
            if (existsSync(fullPath)) {
                imagePaths.push(fullPath);
                console.log(`Image found: ${fullPath}`);
            } else {
                console.warn(`Warning: image not found, skipping: ${fullPath}`);
            }
        }

        if (dryRun) {
            console.log("Dry run: Shopify was not called, nothing was uploaded and no mapping was saved.");
            return;
        }

        // Upload each image. A failed upload is skipped with a warning.
        const uploaded: string[] = [];
        const files: NonNullable<typeof input.files> = [];
        for (const imagePath of imagePaths) {
            try {
                const url = await uploadImage(imagePath);
                files.push({ originalSource: url, alt: product.name, contentType: "IMAGE" });
                uploaded.push(imagePath);
                console.log(`Uploaded: ${imagePath}`);
            } catch (error) {
                console.warn(
                    `Warning: upload failed, skipping ${imagePath}: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        if (files.length > 0) input.files = files;

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

        if (uploaded.length > 0) {
            console.log(`Waiting for Shopify to process ${uploaded.length} image(s)...`);
            const media = await waitForImages(created.id);

            // Shopify keeps the order we sent, so media[i] belongs to uploaded[i].
            uploaded.forEach((imagePath, i) => {
                const m = media[i];
                const detail = m ? m.status + (m.errors.length ? ` (${m.errors.join("; ")})` : "") : "MISSING";
                console.log(`  ${detail}: ${imagePath}`);
            });

            const ready = media.filter((m) => m.status === "READY").length;
            if (ready < uploaded.length)
                console.warn(`Warning: only ${ready} of ${uploaded.length} image(s) are ready. Check the product in Shopify admin.`);
        }
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
