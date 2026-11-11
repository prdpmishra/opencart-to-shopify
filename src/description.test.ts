import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { toImagePath, toShopifyFileUrl } from "./description.ts";

const IMAGE_URL = "http://localhost/opencart/image/";

describe("toImagePath", () => {
    const cases: [string, string | null][] = [
        ["http://localhost/opencart/image/catalog/a.jpg", "catalog/a.jpg"],
        ["https://localhost/opencart/image/catalog/a.jpg", "catalog/a.jpg"], // other scheme
        ["http://localhost/opencart/image/catalog/a.jpg?v=2", "catalog/a.jpg"], // query isn't the file name
        ["http://localhost/opencart/image/catalog/my%20photo.jpg", "catalog/my photo.jpg"],
        ["/opencart/image/catalog/a.jpg", "catalog/a.jpg"],
        ["image/catalog/a.jpg", "catalog/a.jpg"],
        ["catalog/a.jpg", "catalog/a.jpg"],
        ["http://example.com/opencart/image/catalog/a.jpg", null], // another website
        ["http://localhost/other/a.jpg", null],
        ["data:image/png;base64,AAAA", null],
    ];
    for (const [src, expected] of cases) it(src, () => assert.equal(toImagePath(src, IMAGE_URL), expected));

    it("works without a trailing slash", () =>
        assert.equal(toImagePath("http://localhost/opencart/image/a.jpg", "http://localhost/opencart/image"), "a.jpg"));
});

describe("toShopifyFileUrl", () => {
    it("refuses paths outside OpenCart's image folder", async (t) => {
        // A file that exists, next to (not inside) the image folder.
        const root = mkdtempSync(join(tmpdir(), "oc-"));
        mkdirSync(join(root, "image"));
        writeFileSync(join(root, "secret.jpg"), "");
        process.env.OPENCART_IMAGE_DIR = join(root, "image");

        const warn = t.mock.method(console, "warn", () => {});
        const log = t.mock.method(console, "log", () => {});
        assert.equal(await toShopifyFileUrl("../secret.jpg", "Test image", true), null);
        assert.match(String(warn.mock.calls[0]?.arguments[0]), /outside OpenCart's image folder/);
        assert.equal(log.mock.callCount(), 0); // not "would be uploaded"
    });
});
