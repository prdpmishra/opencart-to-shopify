import { roundCents } from "./convert.ts";
import { deleteDiscountMapping, findDiscountMappings, saveDiscountMapping } from "./mapping.ts";
import type { QuantityDiscount } from "./opencart.ts";
import {
    createAutomaticDiscount,
    deleteAutomaticDiscount,
    getAutomaticDiscount,
    getShopCurrency,
    updateAutomaticDiscount,
    type AutomaticDiscount,
} from "./shopify.ts";

// Makes the product's Shopify automatic discounts match its OpenCart quantity
// discount tiers: missing tiers are created, changed ones updated, and ones
// gone from OpenCart deleted. Each tier takes (normal price − tier price) off
// each item, like OpenCart, where option price modifiers are added on top of
// the tier price. shopifyProductId is null in a dry run of a new product.
// Returns how many discounts were created, updated or deleted.
export async function syncDiscounts(
    productId: number,
    shopifyProductId: string | null,
    tiers: QuantityDiscount[],
    normalPrice: number,
    priceTaxRate: number | null,
    dryRun: boolean,
): Promise<number> {
    const taxFactor = priceTaxRate === null ? 1 : 1 + priceTaxRate / 100;
    const mappings = findDiscountMappings(productId);
    const kept = new Set<number>();
    let changed = 0;
    const money = new Intl.NumberFormat("en", { style: "currency", currency: await getShopCurrency() });

    for (const tier of tiers) {
        const amount = roundCents((normalPrice - tier.price) * taxFactor);
        if (amount <= 0) {
            console.warn(
                `Warning: product ${productId}: quantity discount ${tier.quantity}+ for ${tier.price.toFixed(2)} ` +
                    "is not lower than the normal price, so it is not migrated.",
            );
            continue;
        }
        kept.add(tier.quantity);

        const mapping = mappings.find((m) => m.quantity === tier.quantity);
        const current = mapping ? await getAutomaticDiscount(mapping.shopify_id) : null;
        // Without a start date the tier applies straight away. An existing discount
        // that has already started keeps its start, so it doesn't count as a change;
        // one scheduled for later (the start date was removed in OpenCart) starts now.
        const now = new Date();
        const started = current && new Date(current.startsAt) <= now ? current.startsAt : null;
        const discount: AutomaticDiscount = {
            title: `Buy ${tier.quantity}+, save ${money.format(amount)} each`,
            amount: amount.toFixed(2),
            minimumQuantity: tier.quantity,
            startsAt: tier.startsAt?.toISOString() ?? started ?? now.toISOString(),
            endsAt: tier.endsAt?.toISOString() ?? null,
        };

        if (!current) {
            if (mapping)
                console.warn(`Warning: discount ${mapping.shopify_id} no longer exists in Shopify; it is created again.`);
            if (dryRun || !shopifyProductId) {
                console.log(`Discount would be created: "${discount.title}"`);
                continue;
            }
            const id = await createAutomaticDiscount(shopifyProductId, discount);
            if (mapping) deleteDiscountMapping(productId, tier.quantity);
            saveDiscountMapping(productId, tier.quantity, id);
            changed++;
            console.log(`Created discount "${discount.title}": ${id}`);
            continue;
        }

        const changes = discountChanges(current, discount);
        if (changes.length === 0) continue;
        if (dryRun || !shopifyProductId) {
            console.log(`Discount "${current.title}" would be updated: ${changes.join(", ")}`);
            continue;
        }
        await updateAutomaticDiscount(mapping!.shopify_id, shopifyProductId, discount);
        changed++;
        console.log(`Updated discount "${discount.title}": ${changes.join(", ")}`);
    }

    // Tiers removed in OpenCart (or no longer migrated) are removed from Shopify too.
    for (const mapping of mappings.filter((m) => !kept.has(m.quantity))) {
        const current = await getAutomaticDiscount(mapping.shopify_id);
        const name = current ? `"${current.title}"` : mapping.shopify_id;
        if (dryRun) {
            console.log(`Discount ${name} would be deleted`);
            continue;
        }
        if (current) await deleteAutomaticDiscount(mapping.shopify_id);
        deleteDiscountMapping(productId, mapping.quantity);
        changed++;
        console.log(`Deleted discount ${name}`);
    }

    return changed;
}

function discountChanges(current: AutomaticDiscount, wanted: AutomaticDiscount): string[] {
    const changes: string[] = [];
    if (current.title !== wanted.title) changes.push(`title "${current.title}" → "${wanted.title}"`);
    if (current.amount !== wanted.amount) changes.push(`amount ${current.amount} → ${wanted.amount}`);
    if (current.minimumQuantity !== wanted.minimumQuantity)
        changes.push(`minimum quantity ${current.minimumQuantity} → ${wanted.minimumQuantity}`);
    if (!sameTime(current.startsAt, wanted.startsAt)) changes.push(`start ${current.startsAt} → ${wanted.startsAt}`);
    if (!sameTime(current.endsAt, wanted.endsAt))
        changes.push(`end ${current.endsAt ?? "none"} → ${wanted.endsAt ?? "none"}`);
    return changes;
}

// Shopify returns times in its own format (e.g. without milliseconds).
function sameTime(a: string | null, b: string | null): boolean {
    return a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime();
}
