// Migrates OpenCart customers to Shopify customers, with their addresses.
//
// Usage: npm run customers -- <opencart-customer-id> [--update] [--dry-run]
//        npm run customers -- --all [--update] [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import {
    describeAddress,
    sameAddress,
    toAddressInput,
    toCustomerInput,
    type AddressInput,
    type CustomerInput,
} from "./convert.ts";
import {
    deleteMappingByShopifyId,
    findMapping,
    findUnacceptedProvince,
    isMappedShopifyId,
    saveMapping,
    saveUnacceptedProvince,
} from "./mapping.ts";
import { connect, getCustomer, getCustomerIds, type Customer } from "./opencart.ts";
import {
    adminCustomerUrl,
    createCustomerAddress,
    deleteCustomerAddress,
    findCustomerIdByEmail,
    findCustomerIdByPhone,
    getShopifyCustomer,
    setCustomer,
    setDefaultCustomerAddress,
    setEmailMarketing,
    updateCustomerAddress,
    type SavedAddress,
} from "./shopify.ts";

const USAGE =
    "Usage: npm run customers -- <opencart-customer-id> [--update] [--dry-run]\n" +
    "       npm run customers -- --all [--update] [--dry-run]";

// What happened to one customer.
type Result = "created" | "linked" | "updated" | "up to date" | "skipped" | "dry run";

interface RunOptions {
    update: boolean;
    dryRun: boolean;
    // Create customers that aren't migrated yet. Always true with --all; for one
    // customer, --update means "update only", so a missing customer is an error.
    createMissing: boolean;
}

// An OpenCart address with what it becomes in Shopify.
interface WantedAddress {
    opencartId: number;
    input: AddressInput;
    isDefault: boolean;
    zoneName: string; // for warnings
    // OpenCart's zone code when Shopify refused it before, so it isn't sent.
    rejectedProvince: string | null;
}

async function main() {
    let args;
    try {
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
    const options: RunOptions = { update, dryRun, createMissing: all || !update };

    let connection: Connection | undefined;
    try {
        connection = await connect();

        if (!all) {
            await migrateCustomer(connection, id, options);
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
                result = await migrateCustomer(connection, customerId, options);
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

// Migrates one customer: creates it, updates it or skips it, depending on the
// mapping and the options. Errors are thrown to the caller.
async function migrateCustomer(
    connection: Connection,
    id: number,
    { update, dryRun, createMissing }: RunOptions,
): Promise<Result> {
    const existing = findMapping("customer", id);
    if (existing && !update) {
        console.log(
            `Customer ${id} was already migrated: ${adminCustomerUrl(existing.shopify_id)}. ` +
                "Nothing to do. Use --update to update it.",
        );
        return "skipped";
    }
    if (!existing && !createMissing)
        throw new Error(
            `Customer ${id} has not been migrated yet, so there is nothing to update. Run without --update to create it.`,
        );

    const customer = await getCustomer(connection, id);
    console.log(`OpenCart customer ${id}: ${customer.firstName} ${customer.lastName} <${customer.email}>`);

    if (!customer.enabled) {
        console.warn(
            existing
                ? "Warning: the customer is disabled in OpenCart. The Shopify customer is left as it is."
                : "Warning: the customer is disabled in OpenCart, skipping it.",
        );
        return "skipped";
    }

    const input = toCustomerInput(customer);
    if (!input.phone && customer.telephone.trim())
        console.warn(`Warning: "${customer.telephone}" isn't a valid phone number, leaving it out.`);

    const addresses: WantedAddress[] = customer.addresses.map((address) => {
        const input = toAddressInput(address);
        // A code Shopify didn't keep before isn't sent again (see withProvinceFallback).
        const unaccepted = input.provinceCode
            ? findUnacceptedProvince(address.countryCode, input.provinceCode)
            : undefined;
        if (unaccepted) input.provinceCode = undefined;
        return {
            opencartId: address.id,
            input,
            isDefault: address.id === customer.defaultAddressId,
            zoneName: address.zoneName,
            rejectedProvince: unaccepted?.rejected ? address.zoneCode : null,
        };
    });

    if (existing) return updateCustomer(customer, existing.shopify_id, input, addresses, dryRun);
    return createCustomer(customer, input, addresses, dryRun);
}

async function createCustomer(
    customer: Customer,
    input: CustomerInput,
    addresses: WantedAddress[],
    dryRun: boolean,
): Promise<Result> {
    // customerSet with an email identifier updates a customer that already has this email.
    const existingId = await findCustomerIdByEmail(input.email);
    // ...unless that one was migrated from another OpenCart customer with the same email.
    if (existingId && isMappedShopifyId("customer", existingId))
        throw new Error(
            `Shopify customer ${adminCustomerUrl(existingId)} with the email ${input.email} was already migrated ` +
                "from another OpenCart customer. Give one of them a different email in OpenCart.",
        );
    input.phone = await phoneFor(input, existingId);

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
    saveMapping("customer", customer.id, customerId);
    console.log(`${existingId ? "Linked to the existing" : "Created"} Shopify customer: ${adminCustomerUrl(customerId)}`);

    for (const wanted of addresses) {
        const { id: addressId } = await withProvinceFallback(wanted, true, (address) =>
            createCustomerAddress(customerId, address, wanted.isDefault),
        );
        saveMapping("address", wanted.opencartId, addressId);
        console.log(`Address added${wanted.isDefault ? " (default)" : ""}: ${describeAddress(wanted.input)}`);
    }

    // OpenCart doesn't record when the box was ticked; the registration date is the closest.
    if (customer.newsletter) {
        await setEmailMarketing(customerId, true, `${customer.dateAdded}T00:00:00Z`);
        console.log("Subscribed to email marketing.");
    }

    return existingId ? "linked" : "created";
}

// Brings an already migrated customer in line with OpenCart: name, email, phone,
// note, tags, addresses, default address and email marketing. Addresses added
// by hand in Shopify are kept; only migrated ones are updated or deleted.
async function updateCustomer(
    customer: Customer,
    customerId: string,
    input: CustomerInput,
    addresses: WantedAddress[],
    dryRun: boolean,
): Promise<Result> {
    const current = await getShopifyCustomer(customerId);
    if (!current)
        throw new Error(
            `The Shopify customer ${customerId} no longer exists. ` +
                "Remove its row from the mapping table to create it again.",
        );
    console.log(`Shopify customer: ${adminCustomerUrl(customerId)}`);
    input.phone = await phoneFor(input, customerId);

    const changes: string[] = [];
    const quote = (value: string | null) => (value ? `"${value}"` : "(none)");
    const fields = [
        ["email", current.email?.toLowerCase() ?? null, input.email],
        ["first name", current.firstName, input.firstName],
        ["last name", current.lastName, input.lastName],
        ["phone", current.phone, input.phone],
        ["note", current.note, input.note],
    ] as const;
    for (const [name, from, to] of fields)
        if ((from ?? "") !== (to ?? "")) changes.push(`${name}: ${quote(from)} → ${quote(to)}`);
    const tagList = (tags: string[]) => [...tags].sort().join(", ");
    if (tagList(current.tags) !== tagList(input.tags))
        changes.push(`tags: [${current.tags.join(", ")}] → [${input.tags.join(", ")}]`);
    const customerChanged = changes.length > 0;

    // Addresses: each OpenCart address is mapped to the Shopify address made from it.
    const shopifyAddresses = new Map(current.addresses.map((a) => [a.id, a]));
    const toCreate: WantedAddress[] = [];
    const toUpdate: { addressId: string; wanted: WantedAddress }[] = [];
    const keptIds = new Set<string>();
    for (const wanted of addresses) {
        const addressId = findMapping("address", wanted.opencartId)?.shopify_id;
        const shopifyAddress = addressId ? shopifyAddresses.get(addressId) : undefined;
        if (!addressId || !shopifyAddress) {
            toCreate.push(wanted);
            changes.push(
                `address ${addressId ? "deleted in Shopify, adding it again" : "added"}` +
                    `${wanted.isDefault ? " (default)" : ""}: ${describeAddress(wanted.input)}`,
            );
            continue;
        }
        keptIds.add(addressId);
        if (!sameAddress(wanted.input, shopifyAddress)) {
            toUpdate.push({ addressId, wanted });
            changes.push(`address changed: ${describeAddress(wanted.input)}`);
        }
    }
    // Migrated addresses that OpenCart no longer has.
    const toDelete = current.addresses.filter((a) => !keptIds.has(a.id) && isMappedShopifyId("address", a.id));
    for (const address of toDelete)
        changes.push(`address deleted: ${describeAddress(address)}`);

    // The default, if it's an address that already exists (new ones are made default when created).
    const defaultWanted = addresses.find((a) => a.isDefault);
    const defaultId = defaultWanted && findMapping("address", defaultWanted.opencartId)?.shopify_id;
    const fixDefault = defaultId && keptIds.has(defaultId) && current.defaultAddressId !== defaultId ? defaultId : null;
    if (fixDefault && defaultWanted) changes.push(`default address: ${describeAddress(defaultWanted.input)}`);

    // Email marketing. Unsubscribing in OpenCart must reach Shopify too, but a
    // customer who never subscribed is left as "not subscribed".
    const subscribed = current.marketingState === "SUBSCRIBED" || current.marketingState === "PENDING";
    const marketingChanged = customer.newsletter !== subscribed;
    if (marketingChanged)
        changes.push(`email marketing: ${customer.newsletter ? "subscribe" : "unsubscribe"}`);

    if (changes.length === 0) {
        console.log("Up to date.");
        return "up to date";
    }
    console.log(dryRun ? "Would change:" : "Changes:");
    for (const change of changes) console.log(`  ${change}`);
    if (dryRun) return "dry run";

    if (customerChanged) await setCustomer(input, customerId);

    for (const { addressId, wanted } of toUpdate)
        await withProvinceFallback(wanted, false, (address) => updateCustomerAddress(customerId, addressId, address));
    for (const wanted of toCreate) {
        const { id: addressId } = await withProvinceFallback(wanted, true, (address) =>
            createCustomerAddress(customerId, address, wanted.isDefault),
        );
        const old = findMapping("address", wanted.opencartId);
        if (old) deleteMappingByShopifyId("address", old.shopify_id);
        saveMapping("address", wanted.opencartId, addressId);
    }
    for (const address of toDelete) {
        await deleteCustomerAddress(customerId, address.id);
        deleteMappingByShopifyId("address", address.id);
    }
    if (fixDefault) await setDefaultCustomerAddress(customerId, fixDefault);

    // Dated now: Shopify silently ignores a consent change dated before the
    // previous one (e.g. re-subscribing at the registration date after an unsubscribe).
    if (marketingChanged) await setEmailMarketing(customerId, customer.newsletter);

    console.log("Updated.");
    return "updated";
}

// Saves an address, remembering province codes Shopify doesn't keep, so they
// aren't sent again and a province set by hand in Shopify stays:
// - Shopify only accepts its own province codes. OpenCart's zone codes are mostly
//   the same (ISO 3166-2) but not always: Delhi is "DE" in OpenCart and "DL" in
//   Shopify. Rather than lose the whole address, it is saved without a province.
// - For countries without provinces in Shopify (e.g. the Netherlands), Shopify
//   drops the code without an error.
async function withProvinceFallback(
    wanted: WantedAddress,
    isNew: boolean,
    save: (address: AddressInput) => Promise<SavedAddress>,
): Promise<SavedAddress> {
    const { countryCode, provinceCode } = wanted.input;
    try {
        const saved = await save(wanted.input);
        if (countryCode && provinceCode && saved.provinceCode === null)
            saveUnacceptedProvince(countryCode, provinceCode, false);
        // Known before, so not sent: say so for a new address (not on every update).
        else if (wanted.rejectedProvince && isNew) warnRejectedProvince(wanted, wanted.rejectedProvince);
        return saved;
    } catch (error) {
        if (!countryCode || !provinceCode || !String(error).includes("Province is invalid")) throw error;
        saveUnacceptedProvince(countryCode, provinceCode, true);
        warnRejectedProvince(wanted, provinceCode);
        // null, not left out: on an update, leaving it out keeps the old province.
        return save({ ...wanted.input, provinceCode: null });
    }
}

function warnRejectedProvince(wanted: WantedAddress, provinceCode: string): void {
    console.warn(
        `Warning: Shopify doesn't accept OpenCart's province code "${provinceCode}" ` +
            `(${wanted.zoneName}, ${wanted.input.countryCode}). The address is saved without a province; ` +
            "set it by hand in Shopify.",
    );
}

// The phone to give the customer. Shopify allows a phone number on one customer
// only ("Phone has already been taken"), but family members often share one in
// OpenCart. Rather than not migrating the customer at all, it gets no phone.
// customerId is the Shopify customer being saved, or null for a new one.
async function phoneFor(input: CustomerInput, customerId: string | null): Promise<string | null> {
    if (!input.phone) return null;
    const owner = await findCustomerIdByPhone(input.phone);
    if (!owner || owner === customerId) return input.phone;
    console.warn(
        `Warning: phone ${input.phone} already belongs to another Shopify customer (${adminCustomerUrl(owner)}). ` +
            "This customer gets no phone.",
    );
    return null;
}

main();
