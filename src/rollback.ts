// Rolls back the migration: deletes from Shopify what the migration created and
// puts back what it replaced (the main menu). What already existed in Shopify
// before the migration is kept; only what the migration added to it is removed.
//
// Usage: npm run rollback    (shows what a rollback would do; nothing is changed)
import { parseArgs } from "node:util";
import {
    findState,
    listGuestOrderCustomers,
    listMappings,
    listShopifyIds,
} from "./mapping.ts";
import {
    adminCustomerUrl,
    findExistingIds,
    findProductMetafieldDefinition,
    getCustomerOrderIds,
    getShopifyCustomer,
    type MenuItem,
} from "./shopify.ts";

// The same as in menu.ts and related.ts.
const MENU_HANDLE = "main-menu";
const RELATED = { namespace: "shopify--discovery--product_recommendation", key: "related_products" };

// One kind of item, in the order they are deleted: what's still in Shopify,
// and what's already gone (deleted by hand; only removed from the mapping).
interface Group {
    title: string;
    ids: string[];
    gone: string[];
}

interface Plan {
    savedMenu: MenuItem[] | null;
    groups: Group[];
    // Created by the migration, but kept: they have orders that weren't migrated.
    keptCustomers: { id: string; reason: string }[];
    // Already in Shopify before the migration: kept, minus the addresses the migration added.
    linkedCustomers: { id: string; addressIds: string[] }[];
    linkedDefinitions: number;
}

async function main() {
    try {
        parseArgs({ options: {} });
        printPlan(await makePlan());
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}

async function makePlan(): Promise<Plan> {
    const ids = (type: Parameters<typeof listMappings>[0], linked = false) =>
        listMappings(type)
            .filter((m) => m.linked === (linked ? 1 : 0))
            .map((m) => m.shopify_id);

    // Customers: created ones (registered customers and the ones Shopify made for
    // guest orders) are deleted; linked ones (same email, already in Shopify) are kept.
    const createdCustomers = [...new Set([...ids("customer"), ...listGuestOrderCustomers()])];
    const linkedCustomerIds = ids("customer", true).filter((id) => !createdCustomers.includes(id));

    const relatedDefinition = findState("related-definition-enabled")
        ? await findProductMetafieldDefinition(RELATED.namespace, RELATED.key)
        : null;

    const wanted: [string, string[]][] = [
        ["Orders", ids("order")],
        ["Customers", createdCustomers],
        ["Quantity discounts", listShopifyIds("discount_mapping")],
        ["URL redirects", listShopifyIds("redirect_mapping")],
        ["Products", ids("product")],
        ["Collections", ids("category")],
        ["Metafield definitions", [...ids("attribute"), ...(relatedDefinition ? [relatedDefinition.id] : [])]],
        ["Files", listShopifyIds("file_mapping")],
    ];
    const existing = await findExistingIds([...wanted.flatMap(([, list]) => list), ...linkedCustomerIds]);
    const groups = wanted.map(([title, list]) => ({
        title,
        ids: list.filter((id) => existing.has(id)),
        gone: list.filter((id) => !existing.has(id)),
    }));

    // A customer with orders that weren't migrated (e.g. placed after going live) is kept.
    const migratedOrders = new Set(listMappings("order").map((m) => m.shopify_id));
    const customers = groups.find((g) => g.title === "Customers") as Group;
    const keptCustomers: Plan["keptCustomers"] = [];
    for (const id of customers.ids) {
        const orders = await getCustomerOrderIds(id);
        if (!orders) continue;
        const others = orders.ids.filter((orderId) => !migratedOrders.has(orderId)).length;
        if (others > 0 || orders.total > orders.ids.length)
            keptCustomers.push({
                id,
                reason:
                    others > 0
                        ? `has ${others} order(s) that weren't migrated`
                        : `has ${orders.total} orders, too many to check`,
            });
    }
    customers.ids = customers.ids.filter((id) => !keptCustomers.some((k) => k.id === id));

    // The addresses the migration added to customers that already existed.
    const migratedAddresses = new Set([
        ...listMappings("address").map((m) => m.shopify_id),
        ...listShopifyIds("order_side_effect"),
    ]);
    const linkedCustomers: Plan["linkedCustomers"] = [];
    for (const id of linkedCustomerIds.filter((id) => existing.has(id))) {
        const customer = await getShopifyCustomer(id);
        if (!customer) continue;
        const addressIds = customer.addresses.map((a) => a.id).filter((a) => migratedAddresses.has(a));
        linkedCustomers.push({ id, addressIds });
    }

    const savedMenu = findState(`menu:${MENU_HANDLE}`);
    return {
        savedMenu: savedMenu ? (JSON.parse(savedMenu) as MenuItem[]) : null,
        groups,
        keptCustomers,
        linkedCustomers,
        linkedDefinitions: ids("attribute", true).length,
    };
}

function printPlan(plan: Plan): void {
    console.log("Rollback check: nothing is changed.\n");

    console.log(
        plan.savedMenu
            ? `Main menu: would be put back to the ${plan.savedMenu.length} item(s) it had before the migration: ` +
                  `${plan.savedMenu.map((item) => item.title).join(", ") || "(empty)"}.`
            : "Main menu: no copy from before the migration was saved, so it's left as it is.",
    );

    for (const group of plan.groups) {
        const parts = [];
        if (group.ids.length > 0) parts.push(`${group.ids.length} would be deleted`);
        if (group.gone.length > 0) parts.push(`${group.gone.length} already deleted in Shopify (only removed from the mapping)`);
        console.log(`${group.title}: ${parts.join(", ") || "none"}.`);
        if (group.title === "Customers")
            for (const { id, reason } of plan.keptCustomers)
                console.log(`  Kept: ${adminCustomerUrl(id)} ${reason}.`);
    }

    if (plan.linkedCustomers.length > 0) {
        const addresses = plan.linkedCustomers.reduce((sum, c) => sum + c.addressIds.length, 0);
        console.log(
            `Customers that already existed in Shopify: ${plan.linkedCustomers.length} kept, ` +
                `${addresses} address(es) the migration added would be removed. The migration may have changed ` +
                "their name, phone, note, tags and email marketing; that isn't undone.",
        );
        for (const { id } of plan.linkedCustomers) console.log(`  ${adminCustomerUrl(id)}`);
    }
    if (plan.linkedDefinitions > 0)
        console.log(
            `Metafield definitions that already existed in Shopify: ${plan.linkedDefinitions} kept ` +
                "(their values on migrated products go with the products).",
        );

    console.log("\nRolling back isn't built yet; this only shows what it would do.");
}

await main();
