import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Connection } from "mysql2/promise";
import { requireEnv } from "./env.ts";
import {
    connect,
    getProduct,
    getProductAttributes,
    getProductImages,
    getPriceRules,
    getProductCategories,
    getProductIds,
    getProductOptions,
    getSeoUrlsEnabled,
    type FullProduct,
} from "./opencart.ts";
import {
    sameHtml,
    shopifyWeightUnit,
    toMetafields,
    toProductSetInput,
    type ProductMetafield,
    type ProductSetInput,
} from "./convert.ts";
import { prepareMetafieldDefinitions } from "./attributes.ts";
import { prepareCollections, type ProductCollection } from "./collections.ts";
import { rewriteDescriptionImages } from "./description.ts";
import { syncDiscounts } from "./discounts.ts";
import { buildRedirects, createRedirects } from "./redirects.ts";
import { findMapping, isMappedShopifyId, saveMapping } from "./mapping.ts";
import {
    adminProductUrl,
    deleteProductMetafields,
    getShopTaxesIncluded,
    getShopifyProduct,
    publishToOnlineStore,
    saveProduct,
    setAvailableQuantity,
    setProductMetafields,
    type ShopifyVariant,
    uploadImage,
    waitForImages,
} from "./shopify.ts";

const USAGE =
    "Usage: npm run migrate -- <opencart-product-id> [--update] [--dry-run]\n" +
    "       npm run migrate -- --all [--update] [--dry-run]";

// What happened to one product.
type Result = "created" | "updated" | "up to date" | "skipped" | "dry run";

interface RunOptions {
    update: boolean;
    dryRun: boolean;
    // Create products that aren't migrated yet. Always true with --all; for one
    // product, --update means "update only", so a missing product is an error.
    createMissing: boolean;
    locationId: string;
    priceTaxRate: number | null;
    // OpenCart's "Use SEO URLs" setting: which old URLs need redirects.
    seoUrls: boolean;
}

async function main() {
    let args;
    try {
        // strict: an unknown flag (e.g. a typo of --dry-run) is an error, not ignored.
        args = parseArgs({
            allowPositionals: true,
            options: {
                "dry-run": { type: "boolean", default: false },
                update: { type: "boolean", default: false },
                all: { type: "boolean", default: false },
            },
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const { all, update } = args.values;
    const dryRun = args.values["dry-run"];
    const id = Number(args.positionals[0]);
    const validId = args.positionals.length === 1 && Number.isInteger(id) && id >= 1;
    if (all ? args.positionals.length > 0 : !validId) {
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    let connection: Connection | undefined;

    try {
        connection = await connect();

        // OpenCart prices exclude tax. If Shopify's prices include tax, add it.
        let priceTaxRate: number | null = null;
        if (await getShopTaxesIncluded()) {
            priceTaxRate = Number(requireEnv("PRICE_TAX_RATE"));
            if (!Number.isFinite(priceTaxRate) || priceTaxRate < 0)
                throw new Error("PRICE_TAX_RATE must be a number of percent, e.g. 20.");
            console.log(`Shopify prices include tax: adding ${priceTaxRate}% to OpenCart's prices.`);
        }

        const options: RunOptions = {
            update,
            dryRun,
            createMissing: all || !update,
            locationId: requireEnv("SHOPIFY_LOCATION_ID"),
            priceTaxRate,
            seoUrls: await getSeoUrlsEnabled(connection),
        };

        if (!all) {
            await migrateProduct(connection, id, options);
            return;
        }

        // --all: one product failing doesn't stop the others; everything is reported at the end.
        const ids = await getProductIds(connection);
        const counts = new Map<Result | "failed", number>();
        const failures: string[] = [];

        for (const [i, productId] of ids.entries()) {
            console.log(`\n── Product ${productId} (${i + 1}/${ids.length}) ──`);
            let result: Result | "failed";
            try {
                result = await migrateProduct(connection, productId, options);
            } catch (error) {
                result = "failed";
                const message = error instanceof Error ? error.message : String(error);
                failures.push(`  ${productId}: ${message}`);
                console.error(`Failed: ${message}`);
            }
            counts.set(result, (counts.get(result) ?? 0) + 1);
        }

        console.log(`\n── Summary: ${ids.length} product(s) ──`);
        for (const [result, count] of counts) console.log(`  ${result}: ${count}`);
        if (failures.length > 0) {
            console.log(`Failed products:\n${failures.join("\n")}`);
            process.exitCode = 1;
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

// Migrates one product: creates it, updates it or skips it, depending on the
// mapping and the options. Errors are thrown to the caller.
async function migrateProduct(
    connection: Connection,
    id: number,
    { update, dryRun, createMissing, locationId, priceTaxRate, seoUrls }: RunOptions,
): Promise<Result> {
    const existing = findMapping("product", id);
    if (existing && !update) {
        console.log(
            `Product ${id} was already migrated to ${existing.shopify_id} on ${existing.migrated_at} (UTC). ` +
                "Nothing to do. Use --update to update it.",
        );
        return "skipped";
    }
    if (!existing && !createMissing)
        throw new Error(
            `Product ${id} has not been migrated yet, so there is nothing to update. Run without --update to create it.`,
        );

    const product = await getProduct(connection, id);
    const { options, skipped } = await getProductOptions(connection, id);

    // Customer inputs (checkbox, text, date, file, ...) have no Shopify equivalent.
    for (const option of skipped)
        console.warn(
            `Warning: product ${id}: option "${option.name}" (${option.type}) is not migrated, ` +
                "Shopify has no standard equivalent." +
                (option.required ? " It is required in OpenCart, but Shopify customers won't be asked for it." : ""),
        );

    const { special, discounts, notMigrated } = await getPriceRules(connection, id);
    for (const rule of notMigrated)
        console.warn(`Warning: product ${id}: ${rule} is not migrated.`);
    // In OpenCart's cart an active special replaces the quantity discount price,
    // so the tiers have no effect. In Shopify they'd come off the special price.
    if (special && discounts.length > 0)
        console.warn(
            `Warning: product ${id}: its quantity discounts are not migrated while the special price is active, ` +
                "because OpenCart ignores them then. Run --update after the special ends.",
        );
    const tiers = special ? [] : discounts;
    if (special?.endDate)
        console.warn(
            `Warning: product ${id}: the special price ends on ${special.endDate} in OpenCart, ` +
                "but Shopify won't end the sale by itself. Run --update after that date.",
        );

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
    if (product.weight !== 0 && !shopifyWeightUnit(product.weightUnit))
        console.warn(
            `Warning: product ${id}: weight unit "${product.weightUnit ?? "none"}" has no Shopify equivalent ` +
                "(kg, g, lb or oz), so the weight is not migrated.",
        );
    if (product.hasDimensions)
        console.warn(
            `Warning: product ${id}: length, width and height are not migrated. ` +
                "Shopify products have no dimensions; parcel sizes are set as shipping packages.",
        );
    if (!product.enabled)
        console.log(`Product ${id} is disabled in OpenCart, so it becomes a draft in Shopify.`);
    else if (!product.inDefaultStore)
        console.log(`Product ${id} isn't assigned to OpenCart's default store, so it becomes a draft in Shopify.`);
    else if (product.availableLater)
        console.log(
            `Product ${id}'s "Date Available" is in the future, so it becomes a draft in Shopify. ` +
                "Run --update after that date to make it active.",
        );

    const input = toProductSetInput(product, locationId, options, special, priceTaxRate);

    // Before comparing or sending, so the description has Shopify image URLs.
    input.descriptionHtml = await rewriteDescriptionImages(input.descriptionHtml, dryRun);

    // Attributes (OpenCart's "Specification" tab) → product metafields; missing
    // definitions are created first.
    const metafields = await prepareMetafieldDefinitions(
        toMetafields(id, await getProductAttributes(connection, id)),
        dryRun,
    );

    // Each category becomes a collection; missing ones are created first.
    const collections = await prepareCollections(
        await getProductCategories(connection, id),
        dryRun,
    );

    let outcome: { result: Result; handle: string };
    if (existing)
        outcome = await updateProduct(id, existing.shopify_id, input, collections, metafields, locationId, dryRun);
    else {
        input.collections = collections.flatMap((c) => (c.id ? [c.id] : []));
        if (metafields.length > 0)
            input.metafields = metafields.map(({ namespace, key, type, value }) => ({ namespace, key, type, value }));
        outcome = await createProduct(connection, product, input, dryRun);
    }

    // Old OpenCart URLs of the product, its categories and manufacturer → the new pages.
    const created = await createRedirects(buildRedirects(product, outcome.handle, collections, seoUrls), dryRun);
    if (created > 0) console.log(`Created ${created} URL redirect(s) from old OpenCart URLs.`);

    // Quantity discount tiers → automatic discounts on the product.
    const shopifyId = findMapping("product", id)?.shopify_id ?? null;
    const discountChanges = await syncDiscounts(id, shopifyId, tiers, Number(product.price), priceTaxRate, dryRun);

    return outcome.result === "up to date" && discountChanges > 0 ? "updated" : outcome.result;
}

async function createProduct(
    connection: Connection,
    product: FullProduct,
    input: ProductSetInput,
    dryRun: boolean,
): Promise<{ result: Result; handle: string }> {
    const id = product.id;

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
        console.log(JSON.stringify(input, null, 2));
        console.log("Dry run: Shopify was not called, nothing was uploaded and no mapping was saved.");
        return { result: "dry run", handle: input.handle ?? "" };
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

    // Active products aren't visible until they are published to a sales channel.
    if (input.status === "ACTIVE") await publishToOnlineStore(created.id);

    console.log(
        `Created product ${id} in Shopify (${input.status === "ACTIVE" ? "active, on the Online Store" : "draft"}): ${created.id}\n` +
            `  handle: ${created.handle}, ${input.variants.length} variant(s)\n` +
            `  ${adminProductUrl(created.id)}`,
    );

    if (uploaded.length > 0) {
        console.log(`Waiting for Shopify to process ${uploaded.length} image(s)...`);
        const media = await waitForImages(created.id, uploaded.length);

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

    return { result: "created", handle: created.handle };
}

// A weight of 0 is the same in any unit; otherwise unit and value must match.
function sameWeight(
    current: { value: number; unit: string } | null,
    wanted: { value: number; unit: string },
): boolean {
    if ((current?.value ?? 0) === 0 && wanted.value === 0) return true;
    return current?.unit === wanted.unit && Math.abs(current.value - wanted.value) < 1e-6;
}

// Identifies a variant by its option values, e.g. "Color=Red|Size=Small".
// Sorted, so the order of the options doesn't matter.
function variantKey(options: { name: string; value: string }[]): string {
    return options
        .map((o) => `${o.name}=${o.value}`)
        .sort()
        .join("|");
}

// Updates the product from OpenCart: title, description, status, SEO, vendor,
// tags, collections, metafields, variants and inventory. Handle and images are left as they are.
async function updateProduct(
    id: number,
    shopifyId: string,
    input: ProductSetInput,
    collections: ProductCollection[],
    metafields: ProductMetafield[],
    locationId: string,
    dryRun: boolean,
): Promise<{ result: Result; handle: string }> {
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
    if (current.status !== input.status)
        changes.push(`status: ${current.status} → ${input.status}`);
    if ((current.seo.title ?? "") !== input.seo.title)
        changes.push(`SEO title: "${current.seo.title ?? ""}" → "${input.seo.title}"`);
    if ((current.seo.description ?? "") !== input.seo.description)
        changes.push(`SEO description: changed`);
    if (input.vendor !== undefined && current.vendor !== input.vendor)
        changes.push(`vendor: "${current.vendor}" → "${input.vendor}"`);
    if ([...current.tags].sort().join(",") !== [...input.tags].sort().join(","))
        changes.push(`tags: [${current.tags.join(", ")}] → [${input.tags.join(", ")}]`);
    let productChanged = changes.length > 0;

    // Active products must also be published to the Online Store to be visible.
    const publish = input.status === "ACTIVE" && !current.onlineStore;
    if (publish) changes.push("Online Store: not published → published");

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
        if (currentVariant.requiresShipping !== newVariant.inventoryItem.requiresShipping)
            variantChanges.push(
                `physical product ${currentVariant.requiresShipping} → ${newVariant.inventoryItem.requiresShipping}`,
            );
        const newWeight = newVariant.inventoryItem.measurement?.weight;
        if (newWeight && !sameWeight(currentVariant.weight, newWeight))
            variantChanges.push(
                `weight ${currentVariant.weight ? `${currentVariant.weight.value} ${currentVariant.weight.unit}` : "none"}` +
                    ` → ${newWeight.value} ${newWeight.unit}`,
            );
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

    // Metafields: new and changed values are set. Values of OpenCart attributes the
    // product no longer has are deleted; metafields added by hand in Shopify are kept.
    const metafieldsToSet: ProductMetafield[] = [];
    for (const metafield of metafields) {
        const currentValue = current.metafields.find((m) => m.key === metafield.key)?.value;
        if (currentValue === metafield.value) continue;
        const from = currentValue === undefined ? "none" : `"${currentValue}"`;
        changes.push(`metafield custom.${metafield.key}: ${from} → "${metafield.value}"`);
        metafieldsToSet.push(metafield);
    }
    const metafieldsToDelete = current.metafields.filter(
        (m) =>
            !metafields.some((wanted) => wanted.key === m.key) &&
            m.definitionId !== null &&
            isMappedShopifyId("attribute", m.definitionId),
    );
    for (const m of metafieldsToDelete) changes.push(`metafield custom.${m.key}: "${m.value}" → deleted`);

    if (changes.length === 0) {
        console.log(`Product ${id} is already up to date in Shopify (${shopifyId}).`);
        return { result: "up to date", handle: current.handle };
    }

    console.log(`Product ${id} changes:\n  ${changes.join("\n  ")}`);

    if (dryRun) {
        console.log("Dry run: Shopify was not called.");
        return { result: "dry run", handle: current.handle };
    }

    if (productChanged) {
        // No handle or files, so Shopify keeps them. Collections are only
        // sent when they changed; left out, Shopify keeps the current ones.
        const { handle, files, collections: _, ...fields } = input;
        const updateInput: ProductSetInput = { ...fields, variants };
        if (collectionIds) updateInput.collections = collectionIds;
        await saveProduct(updateInput, shopifyId);
    }

    for (const { variant, quantity } of quantityUpdates)
        await setAvailableQuantity(variant.inventoryItemId, locationId, quantity, variant.available);

    if (metafieldsToSet.length > 0)
        await setProductMetafields(
            shopifyId,
            metafieldsToSet.map(({ namespace, key, type, value }) => ({ namespace, key, type, value })),
        );
    if (metafieldsToDelete.length > 0)
        await deleteProductMetafields(
            shopifyId,
            metafieldsToDelete.map((m) => ({ namespace: "custom", key: m.key })),
        );

    if (publish) await publishToOnlineStore(shopifyId);

    console.log(`Updated product ${id} in Shopify: ${shopifyId}\n  ${adminProductUrl(shopifyId)}`);
    return { result: "updated", handle: current.handle };
}

main();
