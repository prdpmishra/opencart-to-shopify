import type { ProductMetafield } from "./convert.ts";
import { findMapping, isMappedShopifyId, saveMapping } from "./mapping.ts";
import {
    createProductMetafieldDefinition,
    findProductMetafieldDefinition,
    getMetafieldDefinition,
} from "./shopify.ts";

// Makes sure each attribute has a Shopify metafield definition: creates missing
// ones, so the values show up on the product page in admin. Returns the
// metafields with the key of their definition. In a dry run nothing is changed.
export async function prepareMetafieldDefinitions(
    metafields: ProductMetafield[],
    dryRun: boolean,
): Promise<ProductMetafield[]> {
    const result: ProductMetafield[] = [];

    for (const metafield of metafields) {
        const label = `Attribute ${metafield.attributeId} ("${metafield.name}")`;
        const mapping = findMapping("attribute", metafield.attributeId);

        if (mapping) {
            const definition = await getMetafieldDefinition(mapping.shopify_id);
            if (!definition)
                throw new Error(
                    `${label} is mapped to ${mapping.shopify_id}, but that metafield definition no longer exists in Shopify. ` +
                        "Delete its mapping row to create it again.",
                );
            // The key stays as first created, even if the attribute is renamed in OpenCart.
            result.push({ ...metafield, key: definition.key });
            continue;
        }

        const existing = await findProductMetafieldDefinition(metafield.namespace, metafield.key);
        if (existing) {
            if (isMappedShopifyId("attribute", existing.id))
                throw new Error(
                    `${label} would become metafield ${metafield.namespace}.${metafield.key}, ` +
                        "which another OpenCart attribute already uses. Rename one of them in OpenCart.",
                );
            if (existing.type.name !== metafield.type)
                throw new Error(
                    `${label}: Shopify already has a metafield ${metafield.namespace}.${metafield.key} ` +
                        `of type ${existing.type.name}, not ${metafield.type}.`,
                );
            // Made by hand in Shopify (or by a run that stopped before saving the mapping).
            if (dryRun) console.log(`${label} would use the existing metafield definition ${existing.id}`);
            else {
                saveMapping("attribute", metafield.attributeId, existing.id);
                console.log(`${label} uses the existing metafield definition ${existing.id}`);
            }
            result.push(metafield);
            continue;
        }

        if (dryRun) {
            console.log(`Metafield definition would be created for ${label}: ${metafield.namespace}.${metafield.key}`);
            result.push(metafield);
            continue;
        }

        const id = await createProductMetafieldDefinition({
            namespace: metafield.namespace,
            key: metafield.key,
            name: metafield.name,
            description: metafield.group ? `OpenCart attribute group: ${metafield.group}` : "OpenCart attribute",
            type: metafield.type,
        });
        // Saved straight away: if anything below fails, a rerun must not create it again.
        saveMapping("attribute", metafield.attributeId, id);
        console.log(`Created metafield definition ${metafield.namespace}.${metafield.key} for ${label}: ${id}`);
        result.push(metafield);
    }

    return result;
}
