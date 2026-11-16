// Rolls back the migration: deletes from Shopify what the migration created and
// puts back what it replaced (the main menu). What already existed in Shopify
// before the migration is kept; only what the migration added to it is removed.
//
// Usage: npm run rollback          (shows what a rollback would do; nothing is changed)
//        npm run rollback -- --yes (rolls back)
//
// Each item is removed from the mapping as soon as it's deleted, so a rollback
// that stopped halfway can simply be run again.
import { parseArgs } from "node:util";
import {
    findState,
    forgetShopifyId,
    forgetState,
    listOrderSideEffectCustomers,
    listMappings,
    listShopifyIds,
    oldestMigratedAt,
} from "./mapping.ts";
import {
    adminCustomerUrl,
    deleteById,
    deleteCustomerAddress,
    findExistingIds,
    findProductMetafieldDefinition,
    getAccessScopes,
    getCustomerOrdersAndAddresses,
    getMetafieldDefinitionUse,
    getMenu,
    getShopifyCustomer,
    setMenuItems,
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
    // The addresses of each customer that is deleted.
    customerAddresses: Map<string, string[]>;
    // Created by the migration, but kept: they have orders that weren't migrated.
    keptCustomers: { id: string; reason: string; addressIds: string[] }[];
    // Already in Shopify before the migration: kept, minus the addresses the migration added.
    linkedCustomers: { id: string; addressIds: string[] }[];
    linkedDefinitions: string[];
    // Set when the migration enabled the related products definition.
    relatedDefinitionId: string | null;
    // Why rolling back would be unsafe; --yes refuses while there are any.
    blockers: string[];
}

async function main() {
    try {
        const args = parseArgs({ options: { yes: { type: "boolean", default: false } } });
        const plan = await makePlan();
        printPlan(plan, args.values.yes && plan.blockers.length === 0);
        if (plan.blockers.length > 0) {
            console.error(`\nRolling back isn't safe:\n${plan.blockers.map((b) => `  - ${b}`).join("\n")}`);
            if (args.values.yes) {
                console.error("Nothing was changed.");
                process.exitCode = 1;
            }
            return;
        }
        if (!args.values.yes) return;

        const failed = await rollBack(plan);
        if (failed > 0) {
            console.error(
                `\n${failed} item(s) failed, see above. Fix the cause and run "npm run rollback -- --yes" again: ` +
                    "what's already rolled back is skipped.",
            );
            process.exitCode = 1;
        } else console.log("\nRollback complete.");
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
    // guest orders) are deleted. Ones that already existed in Shopify are kept:
    // linked ones (same email) and ones Shopify gave addresses from guest orders.
    const sideEffects = listOrderSideEffectCustomers();
    const createdCustomers = [...new Set([...ids("customer"), ...sideEffects.created])];
    const linkedCustomerIds = [...new Set([...ids("customer", true), ...sideEffects.givenAddress])].filter(
        (id) => !createdCustomers.includes(id),
    );

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
    const customerAddresses = new Map<string, string[]>();
    const keptCustomers: Plan["keptCustomers"] = [];
    for (const id of customers.ids) {
        const customer = await getCustomerOrdersAndAddresses(id);
        // Deleted in Shopify just now: only removed from the mapping.
        if (!customer) {
            customers.gone.push(id);
            continue;
        }
        const others = customer.orderIds.filter((orderId) => !migratedOrders.has(orderId)).length;
        if (others > 0 || customer.totalOrders > customer.orderIds.length)
            keptCustomers.push({
                id,
                reason:
                    others > 0
                        ? `has ${others} order(s) that weren't migrated`
                        : `has ${customer.totalOrders} orders, too many to check`,
                addressIds: customer.addressIds,
            });
        else customerAddresses.set(id, customer.addressIds);
    }
    customers.ids = customers.ids.filter((id) => customerAddresses.has(id));

    // The addresses the migration added to customers that already existed.
    const migratedAddresses = new Set([
        ...listMappings("address").map((m) => m.shopify_id),
        ...listShopifyIds("order_side_effect"),
    ]);
    const linkedCustomers: Plan["linkedCustomers"] = [];
    for (const id of linkedCustomerIds) {
        const customer = existing.has(id) ? await getShopifyCustomer(id) : null;
        // Deleted in Shopify since: only unlinked.
        if (!customer) {
            customers.gone.push(id);
            continue;
        }
        const addressIds = customer.addresses.map((a) => a.id).filter((a) => migratedAddresses.has(a));
        linkedCustomers.push({ id, addressIds });
    }

    const blockers: string[] = [];
    if (!findState("recording-since"))
        blockers.push(
            "migration.sqlite was started before the migration recorded what a rollback needs. It can't tell " +
                "customers and metafield definitions that already existed in Shopify from created ones, so those " +
                "could be deleted. Roll back by hand, or migrate again into a fresh mapping file.",
        );
    // Without read_all_orders Shopify hides orders created more than 60 days ago:
    // they'd look deleted and only be removed from the mapping.
    const oldestOrder = oldestMigratedAt("order");
    const daysOld = oldestOrder ? (Date.now() - Date.parse(`${oldestOrder.replace(" ", "T")}Z`)) / 86_400_000 : 0;
    if (daysOld > 55 && !(await getAccessScopes()).includes("read_all_orders"))
        blockers.push(
            `The oldest migrated order was created in Shopify ${Math.floor(daysOld)} days ago, and the app has no ` +
                "read_all_orders scope, so Shopify hides orders older than 60 days from it. Add read_all_orders.",
        );

    const savedMenu = findState(`menu:${MENU_HANDLE}`);
    return {
        savedMenu: savedMenu ? (JSON.parse(savedMenu) as MenuItem[]) : null,
        groups,
        customerAddresses,
        keptCustomers,
        linkedCustomers,
        linkedDefinitions: ids("attribute", true),
        relatedDefinitionId: relatedDefinition?.id ?? null,
        blockers,
    };
}

function printPlan(plan: Plan, yes: boolean): void {
    console.log(yes ? "Rolling back:\n" : "Rollback check: nothing is changed.\n");

    console.log(
        plan.savedMenu
            ? `Main menu: ${yes ? "will" : "would"} be put back to the ${plan.savedMenu.length} item(s) it had before ` +
                  `the migration: ${plan.savedMenu.map((item) => item.title).join(", ") || "(empty)"}.`
            : "Main menu: no copy from before the migration was saved, so it's left as it is.",
    );

    for (const group of plan.groups) {
        const parts = [];
        if (group.ids.length > 0) parts.push(`${group.ids.length} ${yes ? "to delete" : "would be deleted"}`);
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
                `${addresses} address(es) the migration added ${yes ? "to remove" : "would be removed"}. ` +
                "The migration may have changed their name, phone, note, tags and email marketing; that isn't undone.",
        );
        for (const { id } of plan.linkedCustomers) console.log(`  ${adminCustomerUrl(id)}`);
    }
    if (plan.linkedDefinitions.length > 0)
        console.log(
            `Metafield definitions that already existed in Shopify: ${plan.linkedDefinitions.length} kept ` +
                "(their values on migrated products go with the products).",
        );

    if (!yes && plan.blockers.length === 0) console.log('\nTo roll back, run "npm run rollback -- --yes".');
}

// Rolls back in the order of the plan, carrying on after a failure. Returns the number of failures.
async function rollBack(plan: Plan): Promise<number> {
    let failed = 0;
    const attempt = async (what: string, action: () => Promise<void>): Promise<boolean> => {
        try {
            await action();
            return true;
        } catch (error) {
            failed++;
            console.error(`Failed ${what}: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    };
    console.log("");

    const savedMenu = plan.savedMenu;
    if (savedMenu)
        await attempt("to put back the main menu", async () => {
            const menu = await getMenu(MENU_HANDLE);
            if (!menu) throw new Error(`Shopify has no menu with the handle "${MENU_HANDLE}".`);
            await setMenuItems(menu, toMenuInput(savedMenu));
            forgetState(`menu:${MENU_HANDLE}`);
            console.log("Main menu put back.");
        });

    for (const group of plan.groups) {
        for (const id of group.gone) forgetShopifyId(id);
        // Addresses of customers that are still in Shopify after this step: their mapping is kept.
        const remainingAddresses = new Set(plan.keptCustomers.flatMap((c) => c.addressIds));
        let deleted = 0;
        for (const id of group.ids) {
            const ok = await attempt(`to delete ${id}`, async () => {
                // The migrated products are gone by now, so values left on a definition are
                // on products made in Shopify, which deleting it would wipe. (Shopify may
                // also still be clearing the deleted products' values: a rerun retries.)
                if (group.title === "Metafield definitions") {
                    const used = await getMetafieldDefinitionUse(id);
                    if (used)
                        throw new Error(
                            `it still has values on ${used} product(s) that weren't migrated. Delete it by hand if ` +
                                "they don't need it, or run the rollback again if that count goes down to 0.",
                        );
                }
                await deleteById(id);
                forgetShopifyId(id);
                if (id === plan.relatedDefinitionId) forgetState("related-definition-enabled");
            });
            if (ok) deleted++;
            else for (const addressId of plan.customerAddresses.get(id) ?? []) remainingAddresses.add(addressId);
        }
        if (group.ids.length > 0) console.log(`${group.title}: ${deleted} of ${group.ids.length} deleted.`);
        if (group.title !== "Customers") continue;

        // Once the orders are gone: the addresses the migration added to customers that already existed.
        for (const { id, addressIds } of plan.linkedCustomers) {
            let removed = 0;
            for (const addressId of addressIds) {
                const ok = await attempt(`to remove address ${addressId} from ${adminCustomerUrl(id)}`, () =>
                    deleteCustomerAddress(id, addressId),
                );
                if (ok) removed++;
                else remainingAddresses.add(addressId);
            }
            // Unlinked once all its migrated addresses are gone (else a rerun tries again).
            if (removed === addressIds.length) forgetShopifyId(id);
            console.log(`Kept ${adminCustomerUrl(id)}, removed ${removed} of ${addressIds.length} migrated address(es).`);
        }

        // Every other migrated address went with its customer (or was deleted by hand).
        // Left in the mapping, it would stop the customer from being migrated again.
        const migratedAddresses = [
            ...listMappings("address").map((m) => m.shopify_id),
            ...listShopifyIds("order_side_effect").filter((id) => id.includes("/MailingAddress/")),
        ];
        for (const addressId of migratedAddresses)
            if (!remainingAddresses.has(addressId)) forgetShopifyId(addressId);
    }

    // The migration enabled the related products definition, but it's already gone.
    if (findState("related-definition-enabled") && !plan.relatedDefinitionId) forgetState("related-definition-enabled");
    for (const id of plan.linkedDefinitions) forgetShopifyId(id);
    return failed;
}

// The saved items as menuUpdate takes them: a plain link keeps its URL; an
// item that points at a collection, product, … is linked by its resourceId.
function toMenuInput(items: MenuItem[]): MenuItem[] {
    return items.map(({ title, type, resourceId, url, tags, items }) => ({
        title,
        type,
        resourceId,
        url: resourceId ? null : (url ?? null),
        tags: tags ?? [],
        items: toMenuInput(items),
    }));
}

await main();
