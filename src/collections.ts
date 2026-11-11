import { buildHandle, cleanDescription, sameHtml } from "./convert.ts";
import { rewriteDescriptionImages, toShopifyFileUrl } from "./description.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import type { Category } from "./opencart.ts";
import {
    createCollection,
    getCollection,
    publishToOnlineStore,
    unpublishFromOnlineStore,
    updateCollection,
    type CollectionInput,
} from "./shopify.ts";

export interface ProductCollection {
    /** null in a dry run for a collection that doesn't exist yet. */
    id: string | null;
    title: string;
    /** The collection's handle; in a dry run for a new collection, the one it would get. */
    handle: string;
    category: Category;
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
            const handle = await syncCollection(category, mapping.shopify_id, descriptionHtml, dryRun);
            result.push({ id: mapping.shopify_id, title, handle, category });
            continue;
        }

        const handle = buildHandle(category, "category");
        if (dryRun) {
            console.log(`Collection would be created for category ${category.id}: "${title}"`);
            result.push({ id: null, title, handle, category });
            continue;
        }

        const input: CollectionInput = { title, handle, descriptionHtml };
        if (category.image) {
            const url = await toShopifyFileUrl(category.image, "Category image", false);
            if (url) input.image = { src: url, altText: title };
        }

        const created = await createCollection(input);
        // Saved straight away: if anything below fails, a rerun must not create it again.
        saveMapping("category", category.id, created.id);
        console.log(`Created collection "${title}" for category ${category.id}: ${created.id}`);
        if (created.handle !== handle)
            console.log(`Category ${category.id}: handle "${handle}" was taken, Shopify used "${created.handle}"`);

        // A disabled OpenCart category stays hidden: the collection isn't published.
        if (category.enabled) await publishToOnlineStore(created.id);
        else console.log(`Category ${category.id} is disabled in OpenCart, so its collection is not published.`);
        result.push({ id: created.id, title, handle: created.handle, category });
    }

    return result;
}

// Updates the title and description from OpenCart, and publishes the collection
// of an enabled category if it isn't published yet (or unpublishes the one of a
// disabled category). Handle and image are kept.
// Returns the collection's handle.
async function syncCollection(
    category: Category,
    collectionId: string,
    descriptionHtml: string,
    dryRun: boolean,
): Promise<string> {
    const title = category.name;
    const current = await getCollection(collectionId);
    if (!current)
        throw new Error(
            `Category ${category.id} is mapped to ${collectionId}, but that collection no longer exists in Shopify. ` +
                "Delete its mapping row to create it again.",
        );

    const changes: string[] = [];
    if (current.title !== title) changes.push(`title "${current.title}" → "${title}"`);
    if (!sameHtml(current.descriptionHtml, descriptionHtml))
        changes.push(
            `description changed (${current.descriptionHtml.length} → ${descriptionHtml.length} characters)`,
        );
    const publish = category.enabled && !current.onlineStore;
    if (publish) changes.push("Online Store: not published → published");
    // A category disabled in OpenCart after it was migrated is hidden again.
    const unpublish = !category.enabled && current.onlineStore;
    if (unpublish) changes.push("Online Store: published → not published (category disabled in OpenCart)");
    if (changes.length === 0) return current.handle;

    if (dryRun) {
        console.log(`Collection "${current.title}" would be updated: ${changes.join(", ")}`);
        return current.handle;
    }

    if (current.title !== title || !sameHtml(current.descriptionHtml, descriptionHtml))
        await updateCollection(collectionId, { title, descriptionHtml });
    if (publish) await publishToOnlineStore(collectionId);
    if (unpublish) await unpublishFromOnlineStore(collectionId);
    console.log(`Updated collection "${title}": ${changes.join(", ")}`);
    return current.handle;
}
