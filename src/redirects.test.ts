import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductCollection } from "./collections.ts";
import type { Category, FullProduct } from "./opencart.ts";
import { buildRedirects } from "./redirects.ts";

process.env.OPENCART_STORE_URL = "http://localhost/opencart/";

const product = {
    id: 41,
    seoKeyword: "imac",
    manufacturer: "Apple",
    manufacturerId: 8,
    manufacturerSeoKeyword: "apple",
} as FullProduct;

const mac = {
    id: 27,
    pathIds: [20, 27],
    pathKeywords: ["desktops", "mac"],
} as Category;

const collections: ProductCollection[] = [{ id: "gid://shopify/Collection/1", title: "Mac", handle: "mac", category: mac }];

describe("buildRedirects", () => {
    it("redirects index.php URLs when SEO URLs are off", () =>
        assert.deepEqual(buildRedirects(product, "imac", collections, false), [
            { path: "/opencart/index.php?route=product/product&product_id=41", target: "/products/imac" },
            { path: "/opencart/index.php?route=product/product&path=20_27&product_id=41", target: "/products/imac" },
            { path: "/opencart/index.php?route=product/category&path=20_27", target: "/collections/mac" },
            {
                path: "/opencart/index.php?route=product/manufacturer/info&manufacturer_id=8",
                target: "/collections/vendors?q=Apple",
            },
        ]));

    it("adds the SEO forms when SEO URLs are on", () => {
        const paths = buildRedirects(product, "imac", collections, true).map((r) => r.path);
        for (const path of ["/opencart/imac", "/opencart/desktops/mac/imac", "/opencart/desktops/mac", "/opencart/apple"])
            assert.ok(paths.includes(path), path);
    });

    it("skips SEO forms when a category in the path has no keyword", () => {
        const noKeywords = [{ ...collections[0]!, category: { ...mac, pathKeywords: null } }];
        const paths = buildRedirects(product, "imac", noKeywords, true).map((r) => r.path);
        assert.ok(!paths.includes("/opencart/desktops/mac/imac"));
    });

    it("lists each path once", () => {
        const twice = [...collections, ...collections];
        const paths = buildRedirects(product, "imac", twice, false).map((r) => r.path);
        assert.equal(new Set(paths).size, paths.length);
    });
});
