import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canMigrateOrderStatus, matchVariant, toOrderInput, utcOffset, zonedTimeToUtc } from "./convert.ts";
import type { Order, OrderAddress, OrderLine } from "./opencart.ts";

function address(changes: Partial<OrderAddress> = {}): OrderAddress {
    return {
        firstName: "Jan",
        lastName: "Jansen",
        company: "",
        address1: "Main street 1",
        address2: "",
        city: "London",
        postcode: "SW1A 1AA",
        countryCode: "GB",
        zoneCode: "",
        zoneName: "",
        ...changes,
    };
}

function line(changes: Partial<OrderLine> = {}): OrderLine {
    return { productId: 40, name: "iPhone", model: "product 11", quantity: 1, price: 101, total: 101, tax: 0, options: [], ...changes };
}

// A pending guest order: one iPhone at 101 plus 5 shipping, no tax.
function order(changes: Partial<Order> = {}): Order {
    return {
        id: 7,
        customerId: 0,
        email: "Jan@Example.com ",
        telephone: "",
        statusId: 1,
        statusName: "Pending",
        currencyCode: "USD",
        currencyValue: 1,
        total: 106,
        comment: "",
        paymentMethod: "iDEAL",
        shippingCode: "flat.flat",
        payment: address(),
        shipping: address(),
        dateAdded: "2026-07-07 10:09",
        processedAt: "2026-07-07T08:09:16.000Z",
        modifiedAt: "2026-07-07T08:33:14.000Z",
        lines: [line()],
        totals: [
            { code: "sub_total", title: "Sub-Total", value: 101 },
            { code: "shipping", title: "Flat Shipping Rate", value: 5 },
            { code: "total", title: "Total", value: 106 },
        ],
        history: [],
        ...changes,
    };
}

// The same order with 20% VAT on the product and on shipping.
function orderWithVat(changes: Partial<Order> = {}): Order {
    return order({
        total: 127.2,
        lines: [line({ tax: 20.2 })],
        totals: [
            { code: "sub_total", title: "Sub-Total", value: 101 },
            { code: "shipping", title: "Flat Shipping Rate", value: 5 },
            { code: "tax", title: "VAT (20%)", value: 21.2 },
            { code: "total", title: "Total", value: 127.2 },
        ],
        ...changes,
    });
}

const VARIANT = "gid://shopify/ProductVariant/1";
const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "USD" } });

describe("zonedTimeToUtc", () => {
    it("converts winter time", () =>
        assert.equal(zonedTimeToUtc("2026-02-18 07:31:34", "Europe/Berlin"), "2026-02-18T06:31:34.000Z"));
    it("converts summer time", () =>
        assert.equal(zonedTimeToUtc("2026-07-07 10:09:16", "Europe/Berlin"), "2026-07-07T08:09:16.000Z"));
    it("converts a zone with half hours", () =>
        assert.equal(zonedTimeToUtc("2026-11-05 14:55:14", "Asia/Kolkata"), "2026-11-05T09:25:14.000Z"));
    it("uses the right offset on the day the clocks change", () => {
        assert.equal(zonedTimeToUtc("2026-03-29 01:30:00", "Europe/Berlin"), "2026-03-29T00:30:00.000Z");
        assert.equal(zonedTimeToUtc("2026-03-29 04:00:00", "Europe/Berlin"), "2026-03-29T02:00:00.000Z");
    });
    it("converts a date at midnight", () =>
        assert.equal(zonedTimeToUtc("2026-06-01 00:00:00", "Europe/Berlin"), "2026-05-31T22:00:00.000Z"));
    it("refuses something that isn't a date", () => assert.throws(() => zonedTimeToUtc("0000-00-00 00:00:00", "Europe/Berlin")));
    it("refuses an unknown time zone", () => assert.throws(() => zonedTimeToUtc("2026-06-01 00:00:00", "Mars/Olympus")));
});

describe("utcOffset", () => {
    it("gives the winter offset", () => assert.equal(utcOffset("Europe/Berlin", Date.UTC(2026, 0, 15)), "+01:00"));
    it("gives the summer offset", () => assert.equal(utcOffset("Europe/Berlin", Date.UTC(2026, 6, 15)), "+02:00"));
    it("gives half hours", () => assert.equal(utcOffset("Asia/Kolkata", Date.UTC(2026, 0, 15)), "+05:30"));
    it("gives negative offsets", () => assert.equal(utcOffset("America/St_Johns", Date.UTC(2026, 0, 15)), "-03:30"));
    it("gives zero for UTC", () => assert.equal(utcOffset("UTC"), "+00:00"));
});

describe("canMigrateOrderStatus", () => {
    it("migrates pending, complete and refunded orders", () =>
        assert.ok([1, 2, 3, 5, 11, 14, 15, 16].every(canMigrateOrderStatus)));
    it("skips missing, canceled, denied and failed orders", () =>
        assert.ok(![0, 7, 8, 9, 10, 12, 13].some(canMigrateOrderStatus)));
});

describe("matchVariant", () => {
    const sizes = [
        { id: "small", selectedOptions: [{ name: "Size", value: "Small" }] },
        { id: "large", selectedOptions: [{ name: "Size", value: "Large" }] },
    ];
    it("uses the only variant of a product without options", () =>
        assert.equal(matchVariant([{ id: VARIANT, selectedOptions: [{ name: "Title", value: "Default Title" }] }], []), VARIANT));
    it("finds the variant with the chosen options", () =>
        assert.equal(matchVariant(sizes, [{ name: "Size", value: "Large", type: "select" }]), "large"));
    it("ignores options that aren't variants", () =>
        assert.equal(
            matchVariant(sizes, [
                { name: "Size", value: "Small", type: "radio" },
                { name: "Engraving", value: "Jan", type: "text" },
            ]),
            "small",
        ));
    it("finds nothing when the option value is gone", () =>
        assert.equal(matchVariant(sizes, [{ name: "Size", value: "Medium", type: "select" }]), null));
    it("can't choose without options when there are several variants", () => assert.equal(matchVariant(sizes, []), null));
});

describe("toOrderInput", () => {
    it("converts a pending guest order", () => {
        const input = toOrderInput(order(), "USD", [VARIANT], null);
        assert.equal(input.currency, "USD");
        assert.equal(input.processedAt, "2026-07-07T08:09:16.000Z");
        assert.equal(input.email, "jan@example.com");
        assert.equal(input.financialStatus, "PENDING");
        assert.equal(input.fulfillmentStatus, undefined);
        assert.equal(input.customer, undefined);
        assert.equal(input.taxesIncluded, false);
        assert.deepEqual(input.tags, ["OpenCart"]);
        assert.deepEqual(input.transactions, []);
        assert.deepEqual(input.lineItems, [
            { variantId: VARIANT, title: "iPhone", quantity: 1, priceSet: money("101.00"), requiresShipping: true },
        ]);
        assert.deepEqual(input.shippingLines, [{ title: "Flat Shipping Rate", code: "flat.flat", priceSet: money("5.00") }]);
        assert.equal(input.shippingAddress?.countryCode, "GB");
    });

    it("links a registered customer", () =>
        assert.deepEqual(toOrderInput(order({ customerId: 1 }), "USD", [VARIANT], "gid://shopify/Customer/1").customer, {
            toAssociate: { id: "gid://shopify/Customer/1" },
        }));

    it("splits the tax between the product and shipping, with Shopify's title", () => {
        const input = toOrderInput(orderWithVat(), "USD", [VARIANT], null);
        assert.deepEqual(input.lineItems[0]!.taxLines, [{ title: "VAT", rate: 0.2, priceSet: money("20.20") }]);
        assert.deepEqual(input.shippingLines[0]!.taxLines, [{ title: "VAT", rate: 0.2, priceSet: money("1.00") }]);
    });

    it("has no shipping tax when all of it is on the products", () => {
        const input = toOrderInput(
            orderWithVat({
                total: 126.2,
                totals: [
                    { code: "sub_total", title: "Sub-Total", value: 101 },
                    { code: "shipping", title: "Flat Shipping Rate", value: 5 },
                    { code: "tax", title: "VAT (20%)", value: 20.2 },
                    { code: "total", title: "Total", value: 126.2 },
                ],
            }),
            "USD",
            [VARIANT],
            null,
        );
        assert.equal(input.shippingLines[0]!.taxLines, undefined);
    });

    it("records a paid and fulfilled order", () => {
        const input = toOrderInput(order({ statusId: 5, statusName: "Complete" }), "USD", [VARIANT], null);
        assert.equal(input.financialStatus, "PAID");
        assert.equal(input.fulfillmentStatus, "FULFILLED");
        assert.deepEqual(input.transactions, [
            { kind: "SALE", status: "SUCCESS", gateway: "iDEAL", amountSet: money("106.00"), processedAt: "2026-07-07T08:09:16.000Z" },
        ]);
    });

    it("records a refund at the order's last change", () => {
        const input = toOrderInput(order({ statusId: 11, statusName: "Refunded" }), "USD", [VARIANT], null);
        assert.equal(input.financialStatus, "REFUNDED");
        assert.deepEqual(
            input.transactions.map((t) => [t.kind, t.amountSet.shopMoney.amount, t.processedAt]),
            [
                ["SALE", "106.00", "2026-07-07T08:09:16.000Z"],
                ["REFUND", "106.00", "2026-07-07T08:33:14.000Z"],
            ],
        );
    });

    it("refuses a status Shopify can't record", () =>
        assert.throws(() => toOrderInput(order({ statusId: 7, statusName: "Canceled" }), "USD", [VARIANT], null), /Canceled/));

    it("charges what the customer paid when the line total is below the price", () => {
        const input = toOrderInput(
            order({
                total: 95.9,
                lines: [line({ total: 90.9 })],
                totals: [
                    { code: "sub_total", title: "Sub-Total", value: 90.9 },
                    { code: "shipping", title: "Flat Shipping Rate", value: 5 },
                    { code: "total", title: "Total", value: 95.9 },
                ],
            }),
            "USD",
            [VARIANT],
            null,
        );
        assert.deepEqual(input.lineItems[0]!.priceSet, money("90.90"));
    });

    it("keeps a product that isn't in Shopify as a custom line with its SKU and options", () => {
        const input = toOrderInput(
            order({ lines: [line({ options: [{ name: "Size", value: "Small", type: "select" }] })] }),
            "USD",
            [null],
            null,
        );
        assert.deepEqual(input.lineItems[0], {
            title: "iPhone",
            sku: "product 11",
            quantity: 1,
            priceSet: money("101.00"),
            requiresShipping: true,
            properties: [{ name: "Size", value: "Small" }],
        });
    });

    it("shows only options that aren't variants as properties", () => {
        const options = [
            { name: "Size", value: "Small", type: "select" },
            { name: "Engraving", value: "Jan", type: "text" },
        ];
        const input = toOrderInput(order({ lines: [line({ options })] }), "USD", [VARIANT], null);
        assert.deepEqual(input.lineItems[0]!.properties, [{ name: "Engraving", value: "Jan" }]);
    });

    it("has no shipping when nothing needed it", () => {
        const input = toOrderInput(
            order({
                shipping: null,
                total: 101,
                totals: [
                    { code: "sub_total", title: "Sub-Total", value: 101 },
                    { code: "total", title: "Total", value: 101 },
                ],
            }),
            "USD",
            [VARIANT],
            null,
        );
        assert.equal(input.shippingAddress, undefined);
        assert.deepEqual(input.shippingLines, []);
        assert.equal(input.lineItems[0]!.requiresShipping, false);
    });

    it("turns the phone into E.164 using the billing country", () =>
        assert.equal(toOrderInput(order({ telephone: "020 7946 0018" }), "USD", [VARIANT], null).phone, "+442079460018"));

    it("refuses totals Shopify orders can't show", () =>
        assert.throws(
            () =>
                toOrderInput(
                    order({ totals: [...order().totals, { code: "coupon", title: "Coupon (TEST)", value: -10 }] }),
                    "USD",
                    [VARIANT],
                    null,
                ),
            /coupon/,
        ));

    it("refuses an order that doesn't add up", () =>
        assert.throws(() => toOrderInput(order({ total: 110 }), "USD", [VARIANT], null), /add up/));

    it("refuses more than one tax", () =>
        assert.throws(
            () =>
                toOrderInput(
                    orderWithVat({ totals: [...orderWithVat().totals, { code: "tax", title: "Eco Tax (2.00)", value: 2 }] }),
                    "USD",
                    [VARIANT],
                    null,
                ),
            /2 taxes/,
        ));

    it("puts the OpenCart number, paid currency, comment and history in the note", () => {
        const input = toOrderInput(
            order({
                currencyCode: "EUR",
                currencyValue: 0.7846,
                comment: "Ring the bell",
                history: [{ statusName: "Pending", comment: "Waiting for payment", dateAdded: "2026-07-07 10:10" }],
            }),
            "USD",
            [VARIANT],
            null,
        );
        assert.equal(
            input.note,
            [
                "Migrated from OpenCart: order #7, placed 2026-07-07 10:09, status Pending.",
                "Payment method: iDEAL",
                "Paid in EUR: 83.17 EUR",
                "Customer comment: Ring the bell",
                "History:",
                "- 2026-07-07 10:10 Pending: Waiting for payment",
            ].join("\n"),
        );
    });
});
