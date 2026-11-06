import { buildHandle, cleanDescription, sameHtml } from "./convert.ts";
import { rewriteDescriptionImages, toShopifyFileUrl } from "./description.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import type { Category } from "./opencart.ts";
import {
    createCollection,
    getCollection,
    publishToOnlineStore,
    updateCollection,
    type CollectionInput,
} from "./shopify.ts";

export interface ProductCollection {
    /** null in a dry run for a collection that doesn't exist yet. */
    id: string | null;
    title: string;
}

// Makes sure each category has a Shopify collection: creates missing ones and
// updates the title and description of existing ones. In a dry run nothing is
// changed; it only reports what would happen.
export async function prepareCollections(
    categories: Category[],
    dryRun: boolean,
): Promise<ProductCollection[]> {
    const result: ProductCollection[] = [];

    for (const category of categories) {
        const title = category.name;
        const descriptionHtml = await rewriteDescriptionImages(
            cleanDescription(category.description),
            dryRun,
        );
        const mapping = findMapping("category", category.id);

        if (mapping) {
            await syncCollection(category.id, mapping.shopify_id, title, descriptionHtml, dryRun);
            result.push({ id: mapping.shopify_id, title });
            continue;
        }

        if (dryRun) {
            console.log(`Collection would be created for category ${category.id}: "${title}"`);
            result.push({ id: null, title });
            continue;
        }

        const handle = buildHandle(category, "category");
        const input: CollectionInput = { title, handle, descriptionHtml };
        if (category.image) {
            const url = await toShopifyFileUrl(category.image, "Category image", false);
            if (url) input.image = { src: url, altText: title };
        }

        const created = await createCollection(input);
        if (created.handle !== handle)
            console.log(`Category ${category.id}: handle "${handle}" was taken, Shopify used "${created.handle}"`);

        // A disabled OpenCart category stays hidden: the collection isn't published.
        if (category.enabled) await publishToOnlineStore(created.id);
        else console.log(`Category ${category.id} is disabled in OpenCart, so its collection is not published.`);

        saveMapping("category", category.id, created.id);
        console.log(`Created collection "${title}" for category ${category.id}: ${created.id}`);
        result.push({ id: created.id, title });
    }

    return result;
}

// Updates the title and description from OpenCart. Handle and image are kept.
async function syncCollection(
    categoryId: number,
    collectionId: string,
    title: string,
    descriptionHtml: string,
    dryRun: boolean,
): Promise<void> {
    const current = await getCollection(collectionId);
    if (!current)
        throw new Error(
            `Category ${categoryId} is mapped to ${collectionId}, but that collection no longer exists in Shopify. ` +
                "Delete its mapping row to create it again.",
        );

    const changes: string[] = [];
    if (current.title !== title) changes.push(`title "${current.title}" → "${title}"`);
    if (!sameHtml(current.descriptionHtml, descriptionHtml))
        changes.push(
            `description changed (${current.descriptionHtml.length} → ${descriptionHtml.length} characters)`,
        );
    if (changes.length === 0) return;

    if (dryRun) {
        console.log(`Collection "${current.title}" would be updated: ${changes.join(", ")}`);
        return;
    }

    await updateCollection(collectionId, { title, descriptionHtml });
    console.log(`Updated collection "${title}": ${changes.join(", ")}`);
}
