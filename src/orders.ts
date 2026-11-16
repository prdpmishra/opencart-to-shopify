// Migrates OpenCart orders to Shopify as order history.
//
// Usage: npm run orders -- <opencart-order-id> [--dry-run]
//        npm run orders -- --all [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import {
    canMigrateOrderStatus,
    describeAddress,
    isNotificationEvent,
    matchVariant,
    roundCents,
    toOrderInput,
    type AddressInput,
    type OrderInput,
} from "./convert.ts";
import {
    deleteMappingByShopifyId,
    findMapping,
    findUnacceptedProvince,
    saveMapping,
    saveOrderSideEffect,
    saveUnacceptedProvince,
} from "./mapping.ts";
import { connect, getOrder, getOrderIds, getStoreCurrency } from "./opencart.ts";
import {
    adminCustomerUrl,
    adminOrderUrl,
    createOrder,
    deleteOrder,
    getOrderEvents,
    findCustomerIdByEmail,
    getProductVariants,
    getShopCurrency,
    getShopifyCustomer,
    setDefaultCustomerAddress,
    type CreatedOrder,
    type ShopifyCustomer,
} from "./shopify.ts";

const USAGE =
    "Usage: npm run orders -- <opencart-order-id> [--dry-run]\n" +
    "       npm run orders -- --all [--dry-run]";

// What happened to one order.
type Result = "created" | "skipped" | "dry run";

async function main() {
    let args;
    try {
        args = parseArgs({
            allowPositionals: true,
            options: {
                "dry-run": { type: "boolean", default: false },
                all: { type: "boolean", default: false },
            },
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    const { all } = args.values;
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

        // OpenCart stores order amounts in its default currency; Shopify records
        // them in the shop's currency. Converting would change the history.
        const currency = await getShopCurrency();
        const storeCurrency = await getStoreCurrency(connection);
        if (storeCurrency !== currency)
            throw new Error(
                `OpenCart's default currency is ${storeCurrency}, but the Shopify shop's currency is ${currency}. ` +
                    "Orders can only be migrated when they are the same.",
            );

        if (!all) {
            await migrateOrder(connection, id, currency, dryRun);
            return;
        }

        // --all: one order failing doesn't stop the others; everything is reported at the end.
        const ids = await getOrderIds(connection);
        const counts = new Map<Result | "failed", number>();
        const failures: string[] = [];

        for (const [i, orderId] of ids.entries()) {
            console.log(`\n── Order ${orderId} (${i + 1}/${ids.length}) ──`);
            let result: Result | "failed";
            try {
                result = await migrateOrder(connection, orderId, currency, dryRun);
            } catch (error) {
                result = "failed";
                const message = error instanceof Error ? error.message : String(error);
                failures.push(`  ${orderId}: ${message}`);
                console.error(`Failed: ${message}`);
                if (error instanceof NotificationSentError) {
                    counts.set(result, (counts.get(result) ?? 0) + 1);
                    console.error("Stopped: the remaining orders were not migrated.");
                    break;
                }
            }
            counts.set(result, (counts.get(result) ?? 0) + 1);
        }

        console.log(`\n── Summary: ${ids.length} order(s) ──`);
        for (const [result, count] of counts) console.log(`  ${result}: ${count}`);
        if (failures.length > 0) {
            console.log(`Failed orders:\n${failures.join("\n")}`);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("Something went wrong:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

// Migrates one order, or skips it. Errors are thrown to the caller.
async function migrateOrder(connection: Connection, id: number, currency: string, dryRun: boolean): Promise<Result> {
    const existing = findMapping("order", id);
    if (existing) {
        console.log(`Order ${id} was already migrated: ${adminOrderUrl(existing.shopify_id)}. Nothing to do.`);
        return "skipped";
    }

    const order = await getOrder(connection, id);
    console.log(
        `OpenCart order ${id}: ${order.dateAdded}, ${order.statusName || "no status"}, ` +
            `${order.total.toFixed(2)} ${currency}, ${order.email}`,
    );
    if (order.statusId === 0) {
        console.warn("Warning: this is a \"missing order\" (the checkout was never completed), skipping it.");
        return "skipped";
    }
    if (!canMigrateOrderStatus(order.statusId)) {
        console.warn(`Warning: orders with the status "${order.statusName}" aren't migrated, skipping it.`);
        return "skipped";
    }

    // A registered customer's order goes to the migrated Shopify customer. For a
    // guest order, Shopify links the customer with the order's email itself,
    // creating one if there is none (as it does for its own guest checkouts).
    let customerId: string | null = null;
    if (order.customerId > 0) {
        customerId = findMapping("customer", order.customerId)?.shopify_id ?? null;
        if (!customerId)
            throw new Error(
                `OpenCart customer ${order.customerId} hasn't been migrated yet. ` +
                    `Run "npm run customers -- ${order.customerId}" first.`,
            );
    }

    // Each line is linked to the Shopify variant when the product was migrated.
    const variantIds: (string | null)[] = [];
    for (const line of order.lines) {
        const productId = findMapping("product", line.productId)?.shopify_id;
        const variants = productId ? await getProductVariants(productId) : null;
        const variantId = variants ? matchVariant(variants, line.options) : null;
        if (!variantId)
            console.warn(
                `Warning: "${line.name}" (OpenCart product ${line.productId}) ` +
                    `${!productId ? "hasn't been migrated" : !variants ? "no longer exists in Shopify" : "has no matching variant in Shopify"}. ` +
                    "The line keeps its title, SKU and price but isn't linked to a product.",
            );
        if (roundCents(line.price * line.quantity) !== roundCents(line.total))
            console.warn(
                `Warning: "${line.name}" costs ${line.price.toFixed(2)} × ${line.quantity}, but the line total is ` +
                    `${line.total.toFixed(2)}. The line total is used, as that is what the customer was charged.`,
            );
        variantIds.push(variantId);
    }

    const input = toOrderInput(order, currency, variantIds, customerId);
    // Billing and shipping address are often the same: one warning per code.
    const unaccepted = new Set<string>();
    for (const address of [input.billingAddress, input.shippingAddress])
        if (address?.countryCode && address.provinceCode && findUnacceptedProvince(address.countryCode, address.provinceCode))
            unaccepted.add(`"${address.provinceCode}" for ${address.countryCode}`);
    for (const code of unaccepted)
        console.warn(`Warning: Shopify doesn't accept OpenCart's province code ${code}, so the address has no province.`);
    dropUnacceptedProvinces(input);

    if (dryRun) {
        printOrder(input, customerId);
        return "dry run";
    }

    // Shopify adds the order's addresses to the customer's address book (as its
    // checkout does) and makes the last one the default. The customer's own
    // default is put back afterwards: OpenCart decides which address that is.
    const existingCustomerId = customerId ?? (input.email ? await findCustomerIdByEmail(input.email) : null);
    const existingCustomer = existingCustomerId ? await getShopifyCustomer(existingCustomerId) : null;
    const defaultAddressId = existingCustomer?.defaultAddressId ?? null;

    let created = await createOrder(input);
    saveMapping("order", order.id, created.id);
    await saveSideEffects(order.id, created, existingCustomerId, existingCustomer);
    await checkNoNotification(created);

    // Shopify keeps a province code it doesn't know (e.g. any code for the
    // Netherlands, which has no provinces in Shopify) as plain text, which its
    // own orders never have. Such codes are remembered and not sent again, and
    // the order is made again without them: it can't be fixed afterwards, as
    // orderUpdate can't change the billing address.
    const unknown = [
        { sent: input.billingAddress, kept: created.billingProvinceCode, zoneName: order.payment.zoneName },
        ...(input.shippingAddress
            ? [{ sent: input.shippingAddress, kept: created.shippingProvinceCode, zoneName: order.shipping?.zoneName ?? "" }]
            : []),
    ].filter(({ sent, kept }) => sent.countryCode && sent.provinceCode && !kept);
    if (unknown.length > 0) {
        for (const { sent, zoneName } of unknown) {
            if (findUnacceptedProvince(sent.countryCode!, sent.provinceCode!)) continue; // both addresses
            saveUnacceptedProvince(sent.countryCode!, sent.provinceCode!, false);
            console.warn(
                `Warning: Shopify doesn't know the province code "${sent.provinceCode}" (${zoneName}) for ${sent.countryCode}, ` +
                    "so it isn't sent. The order is created again without it.",
            );
        }
        dropUnacceptedProvinces(input);
        await deleteOrder(created.id);
        deleteMappingByShopifyId("order", created.id);
        created = await createOrder(input);
        saveMapping("order", order.id, created.id);
        await saveSideEffects(order.id, created, existingCustomerId, existingCustomer);
        await checkNoNotification(created);
    }

    console.log(`Created Shopify order ${created.name}: ${adminOrderUrl(created.id)}`);
    if (!customerId && created.customerId)
        console.log(
            `Guest order, ${existingCustomerId ? "linked by Shopify to the customer with its email" : "Shopify created a customer for its email"}: ` +
                adminCustomerUrl(created.customerId),
        );

    if (created.customerId && created.customerId === existingCustomerId && defaultAddressId) {
        const now = (await getShopifyCustomer(created.customerId))?.defaultAddressId;
        if (now !== defaultAddressId) await setDefaultCustomerAddress(created.customerId, defaultAddressId);
    }
    return "created";
}

// Records what Shopify made besides the order, so a rollback can remove it: the
// customer it creates for a guest order's email, and the addresses it adds to
// the address book of a customer that already existed.
async function saveSideEffects(
    orderId: number,
    created: CreatedOrder,
    existingCustomerId: string | null,
    existingCustomer: ShopifyCustomer | null,
): Promise<void> {
    if (!created.customerId) return;
    if (!existingCustomerId) {
        saveOrderSideEffect(created.customerId, created.customerId, orderId);
        return;
    }
    if (created.customerId !== existingCustomerId || !existingCustomer) return;
    const before = new Set(existingCustomer.addresses.map((a) => a.id));
    const after = (await getShopifyCustomer(existingCustomerId))?.addresses ?? [];
    for (const address of after)
        if (!before.has(address.id)) saveOrderSideEffect(address.id, existingCustomerId, orderId);
}

// Thrown when Shopify notified someone about a migrated order. It stops --all.
class NotificationSentError extends Error {}

// Migrated orders are history, not new orders: createOrder asks Shopify not to
// send anything, but notifications set up in the store (Shopify Flow, Shopify
// Email automations, apps) are outside its control. So each order's timeline is
// checked, and the run stops at the first notification, before other customers
// get one too.
async function checkNoNotification(created: CreatedOrder): Promise<void> {
    const sent = (await getOrderEvents(created.id)).filter(isNotificationEvent);
    if (sent.length === 0) return;
    throw new NotificationSentError(
        `Shopify sent a notification for order ${created.name} (${adminOrderUrl(created.id)}): ` +
            sent.map((e) => e.message.replace(/<[^>]*>/g, "")).join(" ") +
            " Stopping, so no other customer is notified. Turn off the store's notifications and " +
            "automations for new orders (Shopify Flow, Shopify Email, apps) before running again.",
    );
}

// Leaves out province codes Shopify refused or didn't keep before (for an order
// or a customer address), so the address has no province, like Shopify's own.
function dropUnacceptedProvinces(input: OrderInput): void {
    for (const address of [input.billingAddress, input.shippingAddress])
        if (address?.countryCode && address.provinceCode && findUnacceptedProvince(address.countryCode, address.provinceCode))
            address.provinceCode = null;
}

function printOrder(input: OrderInput, customerId: string | null): void {
    const amount = (bag: { shopMoney: { amount: string } }) => bag.shopMoney.amount;
    const taxes = (lines: { title: string; rate: number; priceSet: { shopMoney: { amount: string } } }[] | undefined) =>
        (lines ?? []).map((t) => `, ${t.title} ${roundCents(t.rate * 100)}% ${amount(t.priceSet)}`).join("");
    const address = (a: AddressInput | undefined) => (a ? describeAddress(a) : "(none)");

    console.log("Would create a Shopify order:");
    console.log(`  Date:     ${input.processedAt}`);
    console.log(`  Customer: ${customerId ? adminCustomerUrl(customerId) : "(guest: Shopify links the customer with this email, or creates one)"}`);
    console.log(`  Email:    ${input.email ?? "(none)"}   Phone: ${input.phone ?? "(none)"}`);
    console.log(`  Status:   ${input.financialStatus}, ${input.fulfillmentStatus ?? "UNFULFILLED"}`);
    for (const line of input.lineItems) {
        const properties = (line.properties ?? []).map((p) => `, ${p.name}: ${p.value}`).join("");
        console.log(
            `  Line:     ${line.quantity} × ${line.title} at ${amount(line.priceSet)}${taxes(line.taxLines)}` +
                `${properties} → ${line.variantId ?? `custom line (SKU ${line.sku ?? "none"})`}`,
        );
    }
    for (const line of input.shippingLines)
        console.log(`  Shipping: ${line.title} (${line.code}) ${amount(line.priceSet)}${taxes(line.taxLines)}`);
    for (const t of input.transactions)
        console.log(`  Payment:  ${t.kind} ${amount(t.amountSet)} ${input.currency} via ${t.gateway} at ${t.processedAt}`);
    if (input.transactions.length === 0) console.log("  Payment:  (no transaction)");
    console.log(`  Billing address:  ${address(input.billingAddress)}`);
    console.log(`  Shipping address: ${address(input.shippingAddress)}`);
    console.log(`  Tags: ${input.tags.join(", ")}`);
    console.log(`  Note:\n${input.note.replace(/^/gm, "    ")}`);
}

main();
