import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { requireEnv } from "./env.ts";
import { connect, getProduct, getProductImages, type FullProduct } from "./opencart.ts";
import { toProductSetInput, type ProductSetInput } from "./convert.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import {
    adminProductUrl,
    getShopifyProduct,
    saveProduct,
    uploadImage,
    waitForImages,
} from "./shopify.ts";

const USAGE =
    "Usage: npm run migrate -- <opencart-product-id> [--update] [--dry-run]";

async function main() {
    let args;
    try {
        // strict: an unknown flag (e.g. a typo of --dry-run) is an error, not ignored.
        args = parseArgs({
            allowPositionals: true,
            options: {
                "dry-run": { type: "boolean", default: false },
                update: { type: "boolean", default: false },
            },
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const dryRun = args.values["dry-run"];
    const update = args.values.update;
    const id = Number(args.positionals[0]);
    if (args.positionals.length !== 1 || !Number.isInteger(id) || id < 1) {
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const existing = findMapping("product", id);
    if (existing && !update) {
        console.log(
            `Product ${id} was already migrated to ${existing.shopify_id} on ${existing.migrated_at} (UTC). ` +
                "Nothing to do. Use --update to update it.",
        );
        return;
    }
    if (!existing && update) {
        console.error(
            `Product ${id} has not been migrated yet, so there is nothing to update. Run without --update to create it.`,
        );
        process.exitCode = 1;
        return;
    }

    let connection: Connection | undefined;

    try {
        connection = await connect();
        const product = await getProduct(connection, id);
        const input = toProductSetInput(product);

        if (existing) await updateProduct(id, existing.shopify_id, input, dryRun);
        else await createProduct(connection, product, input, dryRun);
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

async function createProduct(
    connection: Connection,
    product: FullProduct,
    input: ProductSetInput,
    dryRun: boolean,
) {
    const id = product.id;
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

    const created = await saveProduct(input);

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
}

// Updates title, description, price and SKU from OpenCart.
// Handle, status and images are left as they are in Shopify.
async function updateProduct(
    id: number,
    shopifyId: string,
    input: ProductSetInput,
    dryRun: boolean,
) {
    const current = await getShopifyProduct(shopifyId);
    if (!current)
        throw new Error(
            `Product ${id} is mapped to ${shopifyId}, but that product no longer exists in Shopify. ` +
                "Delete its mapping row to migrate it again.",
        );

    // Updating sends exactly one variant, so Shopify would delete any others.
    const currentVariant = current.variants[0];
    if (!currentVariant || current.variants.length > 1)
        throw new Error(
            `Shopify product ${shopifyId} doesn't have exactly one variant. ` +
                "Updating would replace its variants, so it was not updated.",
        );

    const newVariant = input.variants[0]!;
    const changes: string[] = [];
    if (current.title !== input.title)
        changes.push(`title: "${current.title}" → "${input.title}"`);
    if (current.descriptionHtml !== input.descriptionHtml)
        changes.push(
            `description: changed (${current.descriptionHtml.length} → ${input.descriptionHtml.length} characters)`,
        );
    if (currentVariant.price !== newVariant.price)
        changes.push(`price: ${currentVariant.price} → ${newVariant.price}`);
    if ((currentVariant.sku ?? "") !== (newVariant.sku ?? ""))
        changes.push(`sku: "${currentVariant.sku ?? ""}" → "${newVariant.sku ?? ""}"`);

    if (changes.length === 0) {
        console.log(`Product ${id} is already up to date in Shopify (${shopifyId}). Nothing to do.`);
        return;
    }

    console.log(`Product ${id} changes:\n  ${changes.join("\n  ")}`);

    if (dryRun) {
        console.log("Dry run: Shopify was not called.");
        return;
    }

    // No handle, status or files, so Shopify keeps them. The variant ID makes
    // Shopify update the existing variant instead of replacing it.
    const updateInput: ProductSetInput = {
        title: input.title,
        descriptionHtml: input.descriptionHtml,
        productOptions: input.productOptions,
        variants: [{ ...newVariant, id: currentVariant.id }],
    };
    const updated = await saveProduct(updateInput, shopifyId);

    console.log(
        `Updated product ${id} in Shopify: ${updated.id}\n` +
            `  price: ${updated.price}, sku: ${updated.sku ?? "(none)"}\n` +
            `  ${adminProductUrl(updated.id)}`,
    );
}

main();
