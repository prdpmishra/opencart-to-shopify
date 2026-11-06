import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { requireEnv } from "./env.ts";
import {
    connect,
    getProduct,
    getProductImages,
    getPriceRules,
    getProductCategories,
    getProductOptions,
    type FullProduct,
} from "./opencart.ts";
import { sameHtml, toProductSetInput, type ProductSetInput } from "./convert.ts";
import { prepareCollections, type ProductCollection } from "./collections.ts";
import { rewriteDescriptionImages } from "./description.ts";
import { findMapping, isMappedShopifyId, saveMapping } from "./mapping.ts";
import {
    adminProductUrl,
    getShopTaxesIncluded,
    getShopifyProduct,
    saveProduct,
    setAvailableQuantity,
    type ShopifyVariant,
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
        const locationId = requireEnv("SHOPIFY_LOCATION_ID");
        const product = await getProduct(connection, id);
        const { options, skipped } = await getProductOptions(connection, id);

        // Customer inputs (checkbox, text, date, file, ...) have no Shopify equivalent.
        for (const option of skipped)
            console.warn(
                `Warning: product ${id}: option "${option.name}" (${option.type}) is not migrated, ` +
                    "Shopify has no standard equivalent." +
                    (option.required ? " It is required in OpenCart, but Shopify customers won't be asked for it." : ""),
            );

        const { special, notMigrated } = await getPriceRules(connection, id);
        for (const rule of notMigrated)
            console.warn(`Warning: product ${id}: ${rule} is not migrated.`);
        if (special?.endDate)
            console.warn(
                `Warning: product ${id}: the special price ends on ${special.endDate} in OpenCart, ` +
                    "but Shopify won't end the sale by itself. Run --update after that date.",
            );

        // OpenCart prices exclude tax. If Shopify's prices include tax, add it.
        let priceTaxRate: number | null = null;
        if (await getShopTaxesIncluded()) {
            priceTaxRate = Number(requireEnv("PRICE_TAX_RATE"));
            if (!Number.isFinite(priceTaxRate) || priceTaxRate < 0)
                throw new Error("PRICE_TAX_RATE must be a number of percent, e.g. 20.");
            console.log(`Shopify prices include tax: adding ${priceTaxRate}% to OpenCart's prices.`);
        }

        if (product.taxClassId !== 0 && !product.taxClassExists)
            console.warn(
                `Warning: product ${id}: tax class ${product.taxClassId} doesn't exist in OpenCart, ` +
                    "so OpenCart charges no tax for it. It is migrated as not taxable.",
            );
        if (product.hasFixedTax)
            console.warn(
                `Warning: product ${id}: its tax class includes a fixed tax amount (e.g. an eco tax), ` +
                    "which Shopify has no equivalent for. It is not migrated.",
            );

        const input = toProductSetInput(product, locationId, options, special, priceTaxRate);

        // Before comparing or sending, so the description has Shopify image URLs.
        input.descriptionHtml = await rewriteDescriptionImages(input.descriptionHtml, dryRun);

        // Each category becomes a collection; missing ones are created first.
        const collections = await prepareCollections(
            await getProductCategories(connection, id),
            dryRun,
        );

        if (existing)
            await updateProduct(id, existing.shopify_id, input, collections, locationId, dryRun);
        else {
            input.collections = collections.flatMap((c) => (c.id ? [c.id] : []));
            await createProduct(connection, product, input, dryRun);
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
            `  handle: ${created.handle}, ${input.variants.length} variant(s)\n` +
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

// Identifies a variant by its option values, e.g. "Color=Red|Size=Small".
// Sorted, so the order of the options doesn't matter.
function variantKey(options: { name: string; value: string }[]): string {
    return options
        .map((o) => `${o.name}=${o.value}`)
        .sort()
        .join("|");
}

// Updates title, description, variants and inventory from OpenCart.
// Handle, status and images are left as they are in Shopify.
async function updateProduct(
    id: number,
    shopifyId: string,
    input: ProductSetInput,
    collections: ProductCollection[],
    locationId: string,
    dryRun: boolean,
) {
    const current = await getShopifyProduct(shopifyId, locationId);
    if (!current)
        throw new Error(
            `Product ${id} is mapped to ${shopifyId}, but that product no longer exists in Shopify. ` +
                "Delete its mapping row to migrate it again.",
        );

    const changes: string[] = [];
    if (current.title !== input.title)
        changes.push(`title: "${current.title}" → "${input.title}"`);
    if (!sameHtml(current.descriptionHtml, input.descriptionHtml))
        changes.push(
            `description: changed (${current.descriptionHtml.length} → ${input.descriptionHtml.length} characters)`,
        );
    let productChanged = changes.length > 0;

    // Match each OpenCart variant to the Shopify variant with the same option values.
    // Matched variants keep their Shopify ID; unmatched ones are created or deleted.
    const currentByKey = new Map(current.variants.map((v) => [variantKey(v.selectedOptions), v]));
    const variants: ProductSetInput["variants"] = [];
    const quantityUpdates: { variant: ShopifyVariant; quantity: number }[] = [];

    for (const newVariant of input.variants) {
        const name = newVariant.optionValues.map((o) => o.name).join(" / ");
        const key = variantKey(newVariant.optionValues.map((o) => ({ name: o.optionName, value: o.name })));
        const currentVariant = currentByKey.get(key);
        currentByKey.delete(key);

        if (!currentVariant) {
            // A new variant gets its quantity from productSet, like when creating.
            const quantity = newVariant.inventoryQuantities?.[0]?.quantity;
            changes.push(`variant "${name}": new (price ${newVariant.price}, available ${quantity ?? "not tracked"})`);
            variants.push(newVariant);
            productChanged = true;
            continue;
        }

        // The quantity is left out of productSet and set below, with compare-and-swap.
        const { inventoryQuantities, ...variant } = newVariant;
        variants.push({ ...variant, id: currentVariant.id });

        const variantChanges: string[] = [];
        if (currentVariant.price !== newVariant.price)
            variantChanges.push(`price ${currentVariant.price} → ${newVariant.price}`);
        if (currentVariant.compareAtPrice !== newVariant.compareAtPrice)
            variantChanges.push(
                `compare-at ${currentVariant.compareAtPrice ?? "none"} → ${newVariant.compareAtPrice ?? "none"}`,
            );
        if (currentVariant.taxable !== newVariant.taxable)
            variantChanges.push(`charge tax ${currentVariant.taxable} → ${newVariant.taxable}`);
        if ((currentVariant.sku ?? "") !== (newVariant.sku ?? ""))
            variantChanges.push(`sku "${currentVariant.sku ?? ""}" → "${newVariant.sku ?? ""}"`);
        if (currentVariant.tracked !== newVariant.inventoryItem.tracked)
            variantChanges.push(`track quantity ${currentVariant.tracked} → ${newVariant.inventoryItem.tracked}`);
        if (currentVariant.inventoryPolicy !== newVariant.inventoryPolicy)
            variantChanges.push(`out-of-stock policy ${currentVariant.inventoryPolicy} → ${newVariant.inventoryPolicy}`);
        if (variantChanges.length > 0) productChanged = true;

        // The quantity is only set for tracked items (see toProductSetInput).
        const quantity = inventoryQuantities?.[0]?.quantity;
        if (quantity !== undefined && currentVariant.available !== quantity) {
            variantChanges.push(`available ${currentVariant.available ?? "not stocked"} → ${quantity}`);
            quantityUpdates.push({ variant: currentVariant, quantity });
        }

        if (variantChanges.length > 0)
            changes.push(`variant "${name}": ${variantChanges.join(", ")}`);
    }

    // Shopify variants that no longer exist in OpenCart. productSet deletes them.
    for (const removed of currentByKey.values()) {
        changes.push(`variant "${removed.selectedOptions.map((o) => o.value).join(" / ")}": deleted`);
        productChanged = true;
    }

    // Collections: only those created from OpenCart categories are added or removed.
    // Collections added by hand in Shopify (e.g. the home page) are kept.
    const currentIds = new Set(current.collections.map((c) => c.id));
    const wantedIds = new Set(collections.flatMap((c) => (c.id ? [c.id] : [])));
    const added = collections.filter((c) => !c.id || !currentIds.has(c.id)).map((c) => `+ ${c.title}`);
    const removed = current.collections
        .filter((c) => !wantedIds.has(c.id) && isMappedShopifyId("category", c.id))
        .map((c) => `− ${c.title}`);
    let collectionIds: string[] | undefined;
    if (added.length > 0 || removed.length > 0) {
        changes.push(`collections: ${[...added, ...removed].join(", ")}`);
        // productSet replaces the whole list, so send the ones we keep as well.
        const kept = current.collections.filter((c) => !isMappedShopifyId("category", c.id));
        collectionIds = [...kept.map((c) => c.id), ...wantedIds];
        productChanged = true;
    }

    if (changes.length === 0) {
        console.log(`Product ${id} is already up to date in Shopify (${shopifyId}). Nothing to do.`);
        return;
    }

    console.log(`Product ${id} changes:\n  ${changes.join("\n  ")}`);

    if (dryRun) {
        console.log("Dry run: Shopify was not called.");
        return;
    }

    if (productChanged) {
        // No handle, status or files, so Shopify keeps them. Collections are only
        // sent when they changed; left out, Shopify keeps the current ones.
        const updateInput: ProductSetInput = {
            title: input.title,
            descriptionHtml: input.descriptionHtml,
            productOptions: input.productOptions,
            variants,
        };
        if (collectionIds) updateInput.collections = collectionIds;
        await saveProduct(updateInput, shopifyId);
    }

    for (const { variant, quantity } of quantityUpdates)
        await setAvailableQuantity(variant.inventoryItemId, locationId, quantity, variant.available);

    console.log(`Updated product ${id} in Shopify: ${shopifyId}\n  ${adminProductUrl(shopifyId)}`);
}

main();
