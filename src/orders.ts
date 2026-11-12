// Migrates OpenCart orders to Shopify as order history.
//
// Usage: npm run orders -- <opencart-order-id> [--dry-run]
//        npm run orders -- --all [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import { canMigrateOrderStatus, describeAddress, matchVariant, roundCents, toOrderInput, type AddressInput, type OrderInput } from "./convert.ts";
import { findMapping, findUnacceptedProvince, saveMapping } from "./mapping.ts";
import { connect, getOrder, getOrderIds, getStoreCurrency } from "./opencart.ts";
import { adminCustomerUrl, adminOrderUrl, createOrder, getProductVariants, getShopCurrency } from "./shopify.ts";

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
    // Province codes Shopify refused or dropped for customer addresses aren't sent.
    for (const address of [input.billingAddress, input.shippingAddress])
        if (address?.countryCode && address.provinceCode && findUnacceptedProvince(address.countryCode, address.provinceCode))
            address.provinceCode = null;

    if (dryRun) {
        printOrder(input, customerId);
        return "dry run";
    }

    const created = await createOrder(input);
    saveMapping("order", order.id, created.id);
    console.log(`Created Shopify order ${created.name}: ${adminOrderUrl(created.id)}`);
    if (!customerId && created.customerId)
        console.log(`Guest order, linked by Shopify to the customer with its email: ${adminCustomerUrl(created.customerId)}`);
    return "created";
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
