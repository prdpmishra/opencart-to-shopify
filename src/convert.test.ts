import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildHandle,
    cleanDescription,
    roundCents,
    sameAddress,
    sameHtml,
    tidyText,
    toAddressInput,
    toCustomerInput,
    toE164,
    toHandle,
    toMetafieldKey,
    toMetafields,
    toProductSetInput,
} from "./convert.ts";
import type { Customer, CustomerAddress, FullProduct, ProductOption } from "./opencart.ts";

// A simple enabled product; each test changes what it needs.
function product(changes: Partial<FullProduct> = {}): FullProduct {
    return {
        id: 1,
        price: "100.0000",
        sku: "SKU1",
        model: "Model 1",
        name: "Test product",
        description: "<p>Hello</p>",
        seoKeyword: "test-product",
        quantity: 5,
        subtractStock: true,
        allowOutOfStockCheckout: false,
        taxClassId: 9,
        taxClassExists: true,
        taxable: true,
        hasFixedTax: false,
        enabled: true,
        availableLater: false,
        inDefaultStore: true,
        metaTitle: "",
        metaDescription: "",
        tags: [],
        manufacturer: "Apple",
        manufacturerId: 8,
        manufacturerSeoKeyword: null,
        weight: 1.5,
        weightUnit: "kg",
        hasDimensions: false,
        requiresShipping: true,
        ...changes,
    };
}

const value = (name: string, changes: Partial<ProductOption["values"][number]> = {}) => ({
    name,
    priceModifier: 0,
    weightModifier: 0,
    quantity: 10,
    subtractStock: false,
    ...changes,
});

describe("toHandle", () => {
    it("lowercases and joins words with hyphens", () => assert.equal(toHandle("Apple iPod Classic"), "apple-ipod-classic"));
    it("drops accents", () => assert.equal(toHandle("Crème Brûlée"), "creme-brulee"));
    it("trims hyphens and collapses symbols", () => assert.equal(toHandle("--Hello,  World!--"), "hello-world"));
});

describe("buildHandle", () => {
    it("uses the SEO keyword", () => assert.equal(buildHandle({ id: 1, name: "X", seoKeyword: "my-item" }), "my-item"));
    it("normalises the SEO keyword", () => assert.equal(buildHandle({ id: 1, name: "X", seoKeyword: "My Item" }), "my-item"));
    it("falls back to the name", () => assert.equal(buildHandle({ id: 1, name: "iPod Nano", seoKeyword: null }), "ipod-nano"));
    it("falls back to kind and id", () =>
        assert.equal(buildHandle({ id: 7, name: "!!!", seoKeyword: null }, "category"), "category-7"));
});

describe("roundCents", () => {
    it("rounds half up where toFixed doesn't", () => assert.equal(roundCents(1.005), 1.01));
    it("keeps whole cents", () => assert.equal(roundCents(120), 120));
});

describe("tidyText", () => {
    it("collapses tabs and line breaks", () => assert.equal(tidyText("\t HTC\n Touch  HD "), "HTC Touch HD"));
});

describe("cleanDescription", () => {
    it("turns <b>/<i> into <strong>/<em> but leaves <br>, <blockquote> and <img>", () =>
        assert.equal(
            cleanDescription('<p><b>Bold</b> <i>it</i><br><img src="a.jpg"></p><blockquote>q</blockquote>'),
            '<p><strong>Bold</strong> <em>it</em><br><img src="a.jpg"></p><blockquote>q</blockquote>',
        ));
    it("removes comments, classes and <font>, keeping the text", () =>
        assert.equal(
            cleanDescription('<!-- x --><p class="intro"><font face="Arial">Text</font></p>'),
            "<p>Text</p>",
        ));
    it("collapses whitespace around block tags only", () =>
        assert.equal(cleanDescription("<p>\n  One  two\n</p>\n<p>Three</p>"), "<p>One two</p><p>Three</p>"));
    it("keeps non-breaking spaces", () => assert.equal(cleanDescription("<p>a b</p>"), "<p>a b</p>"));
});

describe("sameHtml", () => {
    it("ignores Shopify's reformatting", () =>
        assert.ok(sameHtml("<p>a &amp; b<br /></p><p>c</p>", "<p>a & b<br></p>\n<p>c</p>")));
    it("sees real changes", () => assert.ok(!sameHtml("<p>a</p>", "<p>b</p>")));
});

describe("toMetafieldKey", () => {
    it("uses lowercase words joined by underscores", () =>
        assert.equal(toMetafieldKey({ id: 2, name: "No. of Cores" }), "no_of_cores"));
    it("drops accents", () => assert.equal(toMetafieldKey({ id: 2, name: "Résolution" }), "resolution"));
    it("falls back to attribute_<id> without usable characters", () =>
        assert.equal(toMetafieldKey({ id: 9, name: "Ω" }), "attribute_9"));
    it("falls back when shorter than Shopify's 2-character minimum", () =>
        assert.equal(toMetafieldKey({ id: 5, name: "x" }), "attribute_5"));
    it("cuts at Shopify's 64-character maximum", () =>
        assert.equal(toMetafieldKey({ id: 1, name: "a".repeat(80) }).length, 64));
});

describe("toMetafields", () => {
    it("makes single-line custom metafields and skips empty values", () =>
        assert.deepEqual(
            toMetafields(1, [
                { id: 2, name: "No. of Cores", group: "Processor", text: " 4\n cores " },
                { id: 3, name: "Clockspeed", group: "Processor", text: "  " },
            ]),
            [
                {
                    attributeId: 2,
                    name: "No. of Cores",
                    group: "Processor",
                    namespace: "custom",
                    key: "no_of_cores",
                    type: "single_line_text_field",
                    value: "4 cores",
                },
            ],
        ));
});

describe("toProductSetInput", () => {
    it("gives a product without options Shopify's default variant", () => {
        const input = toProductSetInput(product(), "loc", [], null, null);
        assert.deepEqual(input.productOptions, [{ name: "Title", values: [{ name: "Default Title" }] }]);
        assert.equal(input.variants.length, 1);
        const [variant] = input.variants;
        assert.equal(variant!.price, "100.00");
        assert.equal(variant!.compareAtPrice, null);
        assert.equal(variant!.sku, "SKU1");
        assert.deepEqual(variant!.inventoryQuantities, [{ locationId: "loc", name: "available", quantity: 5 }]);
        assert.deepEqual(variant!.inventoryItem.measurement, { weight: { value: 1.5, unit: "KILOGRAMS" } });
        assert.equal(input.status, "ACTIVE");
        assert.equal(input.vendor, "Apple");
    });

    it("makes a variant per combination with summed price modifiers", () => {
        const options: ProductOption[] = [
            { name: "Size", values: [value("Small"), value("Large", { priceModifier: 10 })] },
            { name: "Color", values: [value("Red"), value("Blue", { priceModifier: -5 })] },
        ];
        const input = toProductSetInput(product(), "loc", options, null, null);
        assert.deepEqual(
            input.variants.map((v) => [v.optionValues.map((o) => o.name).join("/"), v.price, v.sku]),
            [
                ["Small/Red", "100.00", "SKU1-small-red"],
                ["Small/Blue", "95.00", "SKU1-small-blue"],
                ["Large/Red", "110.00", "SKU1-large-red"],
                ["Large/Blue", "105.00", "SKU1-large-blue"],
            ],
        );
    });

    it("uses the lowest tracked quantity", () => {
        const options = [{ name: "Size", values: [value("S", { quantity: 2, subtractStock: true }), value("M")] }];
        const input = toProductSetInput(product(), "loc", options, null, null);
        assert.deepEqual(
            input.variants.map((v) => v.inventoryQuantities?.[0]?.quantity),
            [2, 5],
        );
    });

    it("doesn't track or send a quantity when nothing is tracked", () => {
        const [variant] = toProductSetInput(product({ subtractStock: false }), "loc", [], null, null).variants;
        assert.equal(variant!.inventoryItem.tracked, false);
        assert.equal(variant!.inventoryQuantities, undefined);
    });

    it("turns a special into the price, with the normal price as compare-at", () => {
        const [variant] = toProductSetInput(product(), "loc", [], { price: 80, endDate: null }, null).variants;
        assert.equal(variant!.price, "80.00");
        assert.equal(variant!.compareAtPrice, "100.00");
    });

    it("adds the tax rate when Shopify prices include tax", () => {
        const [variant] = toProductSetInput(product({ price: "10.0000" }), "loc", [], null, 20).variants;
        assert.equal(variant!.price, "12.00");
    });

    it("makes disabled, future and other-store products drafts", () => {
        for (const changes of [{ enabled: false }, { availableLater: true }, { inDefaultStore: false }])
            assert.equal(toProductSetInput(product(changes), "loc", [], null, null).status, "DRAFT");
    });

    it("merges tags that differ only in case, keeping the first", () =>
        assert.deepEqual(
            toProductSetInput(product({ tags: ["Apple", "apple", "iPod"] }), "loc", [], null, null).tags,
            ["Apple", "iPod"],
        ));

    it("leaves the weight out for a unit Shopify doesn't have", () => {
        const [variant] = toProductSetInput(product({ weightUnit: "stone" }), "loc", [], null, null).variants;
        assert.equal(variant!.inventoryItem.measurement, undefined);
    });

    it("refuses more than 3 options and negative prices", () => {
        const four = ["A", "B", "C", "D"].map((name) => ({ name, values: [value("x")] }));
        assert.throws(() => toProductSetInput(product(), "loc", four, null, null), /at most 3/);
        const cheap = [{ name: "Size", values: [value("S", { priceModifier: -200 })] }];
        assert.throws(() => toProductSetInput(product(), "loc", cheap, null, null), /negative price/);
    });
});

describe("toE164", () => {
    const cases: [string, string, string | null][] = [
        ["1234567890", "IN", "+911234567890"],
        ["1234567890", "NL", null], // the same digits aren't a Dutch number
        ["06 12345678", "NL", "+31612345678"], // national format with spaces
        ["+44 20 7946 0958", "NL", "+442079460958"], // "+" wins over the country
        ["1234567890", "", null], // no "+" and no country: can't tell
        ["", "NL", null],
        ["n/a", "NL", null],
    ];
    for (const [telephone, country, expected] of cases)
        it(`"${telephone}" in ${country || "no country"}`, () => assert.equal(toE164(telephone, country), expected));
});

function address(changes: Partial<CustomerAddress> = {}): CustomerAddress {
    return {
        id: 1,
        firstName: "Jan",
        lastName: "Jansen",
        company: "",
        address1: "Main street 1",
        address2: "",
        city: "Eindhoven",
        postcode: "5611AB",
        countryCode: "NL",
        zoneCode: "NB",
        zoneName: "Noord-Brabant",
        ...changes,
    };
}

function customer(changes: Partial<Customer> = {}): Customer {
    return {
        id: 7,
        firstName: "Jan",
        lastName: "Jansen",
        email: "Jan@Example.com ",
        telephone: "06 12345678",
        newsletter: false,
        enabled: true,
        group: null,
        dateAdded: "2026-02-19",
        addresses: [address()],
        defaultAddressId: 1,
        ...changes,
    };
}

describe("toCustomerInput", () => {
    it("converts a customer", () =>
        assert.deepEqual(toCustomerInput(customer()), {
            email: "jan@example.com",
            firstName: "Jan",
            lastName: "Jansen",
            phone: "+31612345678",
            note: "Migrated from OpenCart: customer #7, registered 2026-02-19.",
            tags: [],
        }));

    it("reads the phone in the default address's country, not the first address's", () => {
        const c = customer({
            telephone: "1234567890",
            addresses: [address({ id: 1 }), address({ id: 2, countryCode: "IN" })],
            defaultAddressId: 2,
        });
        assert.equal(toCustomerInput(c).phone, "+911234567890");
    });

    it("leaves out a phone it can't read", () =>
        assert.equal(toCustomerInput(customer({ addresses: [], defaultAddressId: null, telephone: "1234567890" })).phone, null));

    it("tags a group other than the default", () =>
        assert.deepEqual(toCustomerInput(customer({ group: "Wholesale" })).tags, ["Wholesale"]));
});

describe("toAddressInput", () => {
    it("converts an address", () =>
        assert.deepEqual(toAddressInput(address({ company: "  ACME  BV " })), {
            firstName: "Jan",
            lastName: "Jansen",
            company: "ACME BV",
            address1: "Main street 1",
            address2: "",
            city: "Eindhoven",
            zip: "5611AB",
            countryCode: "NL",
            provinceCode: "NB",
        }));

    it("leaves out empty country and province codes", () => {
        const input = toAddressInput(address({ countryCode: "", zoneCode: "" }));
        assert.equal(input.countryCode, undefined);
        assert.equal(input.provinceCode, undefined);
    });
});

describe("sameAddress", () => {
    const wanted = toAddressInput(address());
    // The address as Shopify returns it after saving: null for empty fields,
    // the postcode reformatted, the Dutch province dropped.
    const saved = {
        firstName: "Jan",
        lastName: "Jansen",
        company: null,
        address1: "Main street 1",
        address2: null,
        city: "Eindhoven",
        zip: "5611 AB",
        countryCode: "NL",
        provinceCode: null,
    };

    it("ignores what Shopify changes when saving", () => assert.ok(sameAddress(wanted, saved)));
    it("sees a changed field", () => assert.ok(!sameAddress(wanted, { ...saved, city: "Tilburg" })));
    it("sees a changed postcode", () => assert.ok(!sameAddress(wanted, { ...saved, zip: "5611 AC" })));
    it("sees a changed country", () => assert.ok(!sameAddress(wanted, { ...saved, countryCode: "BE" })));
    it("sees a different province when Shopify has one", () =>
        assert.ok(!sameAddress({ ...wanted, provinceCode: "UP" }, { ...saved, provinceCode: "DL" })));
    it("sees a province removed in OpenCart", () =>
        assert.ok(!sameAddress({ ...wanted, provinceCode: undefined }, { ...saved, provinceCode: "UP" })));
});
