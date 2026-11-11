// Migrates OpenCart customers to Shopify customers, with their addresses.
//
// Usage: npm run customers -- <opencart-customer-id> [--dry-run]
//        npm run customers -- --all [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import { toAddressInput, toCustomerInput, type AddressInput } from "./convert.ts";
import { findMapping, saveMapping } from "./mapping.ts";
import { connect, getCustomer, getCustomerIds } from "./opencart.ts";
import {
    adminCustomerUrl,
    createCustomerAddress,
    findCustomerIdByEmail,
    setCustomer,
    subscribeToEmailMarketing,
} from "./shopify.ts";

const USAGE =
    "Usage: npm run customers -- <opencart-customer-id> [--dry-run]\n" +
    "       npm run customers -- --all [--dry-run]";

// What happened to one customer.
type Result = "created" | "linked" | "skipped" | "dry run";

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

        if (!all) {
            await migrateCustomer(connection, id, dryRun);
            return;
        }

        // --all: one customer failing doesn't stop the others; everything is reported at the end.
        const ids = await getCustomerIds(connection);
        const counts = new Map<Result | "failed", number>();
        const failures: string[] = [];

        for (const [i, customerId] of ids.entries()) {
            console.log(`\n── Customer ${customerId} (${i + 1}/${ids.length}) ──`);
            let result: Result | "failed";
            try {
                result = await migrateCustomer(connection, customerId, dryRun);
            } catch (error) {
                result = "failed";
                const message = error instanceof Error ? error.message : String(error);
                failures.push(`  ${customerId}: ${message}`);
                console.error(`Failed: ${message}`);
            }
            counts.set(result, (counts.get(result) ?? 0) + 1);
        }

        console.log(`\n── Summary: ${ids.length} customer(s) ──`);
        for (const [result, count] of counts) console.log(`  ${result}: ${count}`);
        if (failures.length > 0) {
            console.log(`Failed customers:\n${failures.join("\n")}`);
            process.exitCode = 1;
        }
    } catch (error) {
        console.error("Something went wrong:", error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

// Migrates one customer. Errors are thrown to the caller.
async function migrateCustomer(connection: Connection, id: number, dryRun: boolean): Promise<Result> {
    const customer = await getCustomer(connection, id);
    console.log(`OpenCart customer ${id}: ${customer.firstName} ${customer.lastName} <${customer.email}>`);

    const mapping = findMapping("customer", id);
    if (mapping) {
        console.log(`Already migrated: ${adminCustomerUrl(mapping.shopify_id)}`);
        return "skipped";
    }
    if (!customer.enabled) {
        console.warn("Warning: the customer is disabled in OpenCart, skipping it.");
        return "skipped";
    }

    const input = toCustomerInput(customer);
    if (!input.phone && customer.telephone.trim())
        console.warn(`Warning: "${customer.telephone}" isn't a valid phone number, leaving it out.`);

    const addresses = customer.addresses.map((address) => ({
        input: toAddressInput(address),
        isDefault: address.id === customer.defaultAddressId,
    }));

    // customerSet with an email identifier updates a customer that already has this email.
    const existingId = await findCustomerIdByEmail(input.email);

    if (dryRun) {
        console.log(
            existingId
                ? `Would link to the existing Shopify customer with this email: ${adminCustomerUrl(existingId)}`
                : "Would create a Shopify customer:",
        );
        console.log(`  Name:  ${input.firstName} ${input.lastName}`);
        console.log(`  Email: ${input.email}`);
        console.log(`  Phone: ${input.phone ?? "(none)"}`);
        console.log(`  Tags:  ${input.tags.join(", ") || "(none)"}`);
        console.log(`  Note:  ${input.note}`);
        console.log(`  Email marketing: ${customer.newsletter ? "subscribed" : "not subscribed"}`);
        for (const { input: address, isDefault } of addresses)
            console.log(`  Address${isDefault ? " (default)" : ""}: ${describeAddress(address)}`);
        if (addresses.length === 0) console.log("  Addresses: (none)");
        return "dry run";
    }

    // The mapping is saved straight after each step, so a failure halfway
    // (e.g. a rejected address) doesn't lose track of what was created.
    const customerId = await setCustomer(input);
    saveMapping("customer", id, customerId);
    console.log(`${existingId ? "Linked to the existing" : "Created"} Shopify customer: ${adminCustomerUrl(customerId)}`);

    for (const [i, { input: address, isDefault }] of addresses.entries()) {
        const addressId = await createCustomerAddress(customerId, address, isDefault);
        saveMapping("address", customer.addresses[i]!.id, addressId);
        console.log(`Address added${isDefault ? " (default)" : ""}: ${describeAddress(address)}`);
    }

    // OpenCart doesn't record when the box was ticked; the registration date is the closest.
    if (customer.newsletter) {
        await subscribeToEmailMarketing(customerId, `${customer.dateAdded}T00:00:00Z`);
        console.log("Subscribed to email marketing.");
    }

    return existingId ? "linked" : "created";
}

function describeAddress(a: AddressInput): string {
    return [
        `${a.firstName} ${a.lastName}`,
        a.company,
        a.address1,
        a.address2,
        `${a.zip} ${a.city}`.trim(),
        a.provinceCode,
        a.countryCode,
    ]
        .filter(Boolean)
        .join(", ");
}

main();
