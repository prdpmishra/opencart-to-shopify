import type { ProductCollection } from "./collections.ts";
import { requireEnv } from "./env.ts";
import { findRedirectMapping, saveRedirectMapping } from "./mapping.ts";
import type { FullProduct } from "./opencart.ts";
import { createUrlRedirect } from "./shopify.ts";

export interface Redirect {
    /** The old OpenCart path, e.g. "/index.php?route=product/product&product_id=48". */
    path: string;
    /** The new Shopify path, e.g. "/products/ipod-classic". */
    target: string;
}

// The path OpenCart is installed at, from OPENCART_STORE_URL:
// "http://localhost:8080/opencart/3050/" → "/opencart/3050/", "https://shop.com" → "/".
function storePath(): string {
    const url = requireEnv("OPENCART_STORE_URL");
    if (!URL.canParse(url))
        throw new Error(`OPENCART_STORE_URL must be a full URL, e.g. https://myshop.com/ (got "${url}")`);
    const path = new URL(url).pathname;
    return path.endsWith("/") ? path : `${path}/`;
}

// The old URLs of a product, its categories and its manufacturer page, built the
// way OpenCart 3 builds links, each pointing at its new Shopify page.
// index.php links always work in OpenCart; SEO links (/desktops/mac) only when
// its "Use SEO URLs" setting is on.
export function buildRedirects(
    product: FullProduct,
    productHandle: string,
    collections: ProductCollection[],
    seoUrls: boolean,
): Redirect[] {
    const base = storePath();
    const redirects: Redirect[] = [];
    const add = (path: string, target: string) => redirects.push({ path: base + path, target });

    const productTarget = `/products/${productHandle}`;
    add(`index.php?route=product/product&product_id=${product.id}`, productTarget);
    if (seoUrls && product.seoKeyword) add(product.seoKeyword, productTarget);

    for (const { category, handle } of collections) {
        const collectionTarget = `/collections/${handle}`;
        const path = category.pathIds.join("_");

        // A product opened from a category page carries the category path.
        add(`index.php?route=product/product&path=${path}&product_id=${product.id}`, productTarget);
        add(`index.php?route=product/category&path=${path}`, collectionTarget);

        // OpenCart only builds an SEO link when every category in the path has a keyword.
        if (seoUrls && category.pathKeywords) {
            const categoryPath = category.pathKeywords.join("/");
            add(categoryPath, collectionTarget);
            if (product.seoKeyword) add(`${categoryPath}/${product.seoKeyword}`, productTarget);
        }
    }

    // Shopify has a built-in page per vendor; the manufacturer became the vendor.
    if (product.manufacturerId && product.manufacturer) {
        const vendorTarget = `/collections/vendors?q=${encodeURIComponent(product.manufacturer)}`;
        add(`index.php?route=product/manufacturer/info&manufacturer_id=${product.manufacturerId}`, vendorTarget);
        if (seoUrls && product.manufacturerSeoKeyword) add(product.manufacturerSeoKeyword, vendorTarget);
    }

    // The same category or manufacturer page can come up for several products.
    return redirects.filter((r, i) => redirects.findIndex((o) => o.path === r.path) === i);
}

// Creates the redirects Shopify doesn't have yet. Each one is remembered in
// redirect_mapping, so it's only created once. Returns how many were created.
export async function createRedirects(redirects: Redirect[], dryRun: boolean): Promise<number> {
    let created = 0;

    for (const { path, target } of redirects) {
        const known = findRedirectMapping(path);
        if (known) {
            if (known.target !== target)
                console.warn(
                    `Warning: redirect ${path} points to ${known.target}, but should now point to ${target}. ` +
                        "Change it in Shopify (Online Store › Navigation › URL redirects).",
                );
            continue;
        }

        if (dryRun) {
            console.log(`Redirect would be created: ${path} → ${target}`);
            continue;
        }

        const id = await createUrlRedirect(path, target);
        if (!id) {
            console.warn(`Warning: ${path} already has a redirect in Shopify that the migration didn't create. Left as it is.`);
            continue;
        }
        saveRedirectMapping(path, id, target);
        created++;
    }

    return created;
}
