import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { requireEnv } from "./env.ts";
import type { ProductSetInput } from "./convert.ts";

interface TokenResponse {
    access_token: string;
    expires_in: number;
}

interface GraphQLResponse<T> {
    data?: T;
    errors?: { message: string }[];
}

// Accept either "my-store" or "my-store.myshopify.com".
function shopDomain(): string {
    const shop = requireEnv("SHOPIFY_SHOP");
    return shop.endsWith(".myshopify.com") ? shop : `${shop}.myshopify.com`;
}

let token: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;

    const response = await fetch(
        `https://${shopDomain()}/admin/oauth/access_token`,
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: requireEnv("SHOPIFY_CLIENT_ID"),
                client_secret: requireEnv("SHOPIFY_CLIENT_SECRET"),
            }),
        },
    );

    if (!response.ok)
        throw new Error(
            `Token request failed: ${response.status} ${await response.text()}`,
        );

    const { access_token, expires_in } =
        (await response.json()) as TokenResponse;
    token = access_token;
    tokenExpiresAt = Date.now() + expires_in * 1000;
    return access_token;
}

export async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
): Promise<T> {
    const apiVersion = requireEnv("SHOPIFY_API_VERSION");
    const response = await fetch(
        `https://${shopDomain()}/admin/api/${apiVersion}/graphql.json`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": await getToken(),
            },
            body: JSON.stringify({ query, variables }),
        },
    );

    if (!response.ok) {
        throw new Error(
            `GraphQL request failed: ${response.status} ${await response.text()}`,
        );
    }

    const { data, errors } = (await response.json()) as GraphQLResponse<T>;
    if (errors?.length) {
        throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
    }
    if (data === undefined) throw new Error("GraphQL response had no data");

    return data;
}

interface ProductSetResult {
    productSet: {
        product: {
            id: string;
            handle: string;
            variants: { nodes: { price: string; sku: string | null }[] };
        } | null;
        userErrors: { field: string[] | null; message: string; code: string | null }[];
    };
}

export interface SavedProduct {
    id: string;
    handle: string;
    price: string;
    sku: string | null;
}

const PRODUCT_SET = `
    mutation SaveProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(synchronous: true, input: $input, identifier: $identifier) {
            product {
                id
                handle
                variants(first: 1) {
                    nodes {
                        price
                        sku
                    }
                }
            }
            userErrors {
                field
                message
                code
            }
        }
    }
`;

// Creates a product, or updates the existing one when productId is given.
export async function saveProduct(
    input: ProductSetInput,
    productId?: string,
): Promise<SavedProduct> {
    const { productSet } = await graphql<ProductSetResult>(PRODUCT_SET, {
        input,
        // Left out of the request when undefined, which means "create".
        identifier: productId ? { id: productId } : undefined,
    });

    // Validation problems come back as userErrors, not as a failed request.
    if (productSet.userErrors.length > 0) {
        const messages = productSet.userErrors.map(
            (e) => `${e.field?.join(".") ?? "(no field)"}: ${e.message}`,
        );
        throw new Error(`Shopify rejected the product:\n  ${messages.join("\n  ")}`);
    }

    const product = productSet.product;
    const variant = product?.variants.nodes[0];
    if (!product || !variant)
        throw new Error("Shopify returned no product and no errors.");

    return {
        id: product.id,
        handle: product.handle,
        price: variant.price,
        sku: variant.sku,
    };
}

export interface ShopifyProduct {
    id: string;
    title: string;
    descriptionHtml: string;
    handle: string;
    status: string;
    variants: ShopifyVariant[];
}

export interface ShopifyVariant {
    id: string;
    /** e.g. [{ name: "Size", value: "Small" }], or [{ name: "Title", value: "Default Title" }] */
    selectedOptions: { name: string; value: string }[];
    price: string;
    compareAtPrice: string | null;
    sku: string | null;
    taxable: boolean;
    inventoryPolicy: string;
    inventoryItemId: string;
    tracked: boolean;
    /** Available quantity at the location, or null if the item isn't stocked there. */
    available: number | null;
}

interface ProductQueryResult {
    product: {
        id: string;
        title: string;
        descriptionHtml: string;
        handle: string;
        status: string;
        variants: {
            pageInfo: { hasNextPage: boolean };
            nodes: {
                id: string;
                selectedOptions: { name: string; value: string }[];
                price: string;
                compareAtPrice: string | null;
                sku: string | null;
                taxable: boolean;
                inventoryPolicy: string;
                inventoryItem: {
                    id: string;
                    tracked: boolean;
                    inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
                };
            }[];
        };
    } | null;
}

const PRODUCT_QUERY = `
    query GetProduct($id: ID!, $locationId: ID!) {
        product(id: $id) {
            id
            title
            descriptionHtml
            handle
            status
            variants(first: 250) {
                pageInfo {
                    hasNextPage
                }
                nodes {
                    id
                    selectedOptions {
                        name
                        value
                    }
                    price
                    compareAtPrice
                    sku
                    taxable
                    inventoryPolicy
                    inventoryItem {
                        id
                        tracked
                        inventoryLevel(locationId: $locationId) {
                            quantities(names: ["available"]) {
                                name
                                quantity
                            }
                        }
                    }
                }
            }
        }
    }
`;

// Returns null if the product doesn't exist (e.g. it was deleted in Shopify).
export async function getShopifyProduct(
    productId: string,
    locationId: string,
): Promise<ShopifyProduct | null> {
    const { product } = await graphql<ProductQueryResult>(PRODUCT_QUERY, {
        id: productId,
        locationId,
    });
    if (!product) return null;

    // 250 is the most one request returns. Comparing a partial list would make
    // the update delete the variants we didn't see, so stop instead.
    if (product.variants.pageInfo.hasNextPage)
        throw new Error(`Shopify product ${productId} has more than 250 variants, which isn't supported.`);

    return {
        ...product,
        variants: product.variants.nodes.map((v) => ({
            id: v.id,
            selectedOptions: v.selectedOptions,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            sku: v.sku,
            taxable: v.taxable,
            inventoryPolicy: v.inventoryPolicy,
            inventoryItemId: v.inventoryItem.id,
            tracked: v.inventoryItem.tracked,
            available: v.inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? null,
        })),
    };
}

const INVENTORY_SET_QUANTITIES = `
    mutation SetQuantity($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup {
                changes {
                    name
                    delta
                    quantityAfterChange
                }
            }
            userErrors {
                code
                field
                message
            }
        }
    }
`;

const INVENTORY_ACTIVATE = `
    mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $available: Int, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $idempotencyKey) {
            inventoryLevel {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`;

interface UserErrorsResult {
    userErrors: { field: string[] | null; message: string }[];
}

// Sets the available quantity of an item at a location.
// currentQuantity is what we read from Shopify (null = not stocked there yet).
// If someone changed it in the meantime, Shopify refuses instead of overwriting.
export async function setAvailableQuantity(
    inventoryItemId: string,
    locationId: string,
    quantity: number,
    currentQuantity: number | null,
): Promise<void> {
    if (currentQuantity === null) {
        // Not stocked at this location yet: start stocking it there with this quantity.
        const { inventoryActivate } = await graphql<{ inventoryActivate: UserErrorsResult }>(
            INVENTORY_ACTIVATE,
            { inventoryItemId, locationId, available: quantity, idempotencyKey: randomUUID() },
        );
        if (inventoryActivate.userErrors.length > 0)
            throw new Error(inventoryActivate.userErrors.map((e) => e.message).join("; "));
        return;
    }

    const { inventorySetQuantities } = await graphql<{ inventorySetQuantities: UserErrorsResult }>(
        INVENTORY_SET_QUANTITIES,
        {
            input: {
                name: "available",
                reason: "correction",
                quantities: [
                    { inventoryItemId, locationId, quantity, changeFromQuantity: currentQuantity },
                ],
            },
            idempotencyKey: randomUUID(),
        },
    );
    if (inventorySetQuantities.userErrors.length > 0)
        throw new Error(
            `Could not set the quantity: ${inventorySetQuantities.userErrors.map((e) => e.message).join("; ")}`,
        );
}

// Shopify's store setting "All prices include tax".
export async function getShopTaxesIncluded(): Promise<boolean> {
    const { shop } = await graphql<{ shop: { taxesIncluded: boolean } }>(
        "{ shop { taxesIncluded } }",
    );
    return shop.taxesIncluded;
}

// "gid://shopify/Product/123" → the product's page in Shopify admin.
export function adminProductUrl(productId: string): string {
    const store = requireEnv("SHOPIFY_SHOP").replace(/\.myshopify\.com$/, "");
    const numericId = productId.split("/").pop();
    return `https://admin.shopify.com/store/${store}/products/${numericId}`;
}

const MIME_TYPES: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

interface StagedUploadResult {
    stagedUploadsCreate: {
        stagedTargets: {
            url: string;
            resourceUrl: string;
            parameters: { name: string; value: string }[];
        }[];
        userErrors: { field: string[] | null; message: string }[];
    };
}

const STAGED_UPLOADS_CREATE = `
    mutation StageUpload($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets {
                url
                resourceUrl
                parameters {
                    name
                    value
                }
            }
            userErrors {
                field
                message
            }
        }
    }
`;

// Uploads a local image to Shopify's storage. The returned URL is used as a
// file's originalSource: in productSet for product images ("PRODUCT_IMAGE"),
// or in fileCreate for Shopify Files ("IMAGE").
export async function uploadImage(
    filePath: string,
    resource: "PRODUCT_IMAGE" | "IMAGE" = "PRODUCT_IMAGE",
): Promise<string> {
    const filename = basename(filePath);
    const mimeType = MIME_TYPES[extname(filename).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type: ${filename}`);

    const data = await readFile(filePath);

    // Step 1: ask Shopify where to upload the file.
    const { stagedUploadsCreate: result } = await graphql<StagedUploadResult>(
        STAGED_UPLOADS_CREATE,
        {
            input: [
                {
                    filename,
                    mimeType,
                    httpMethod: "POST",
                    resource,
                    fileSize: String(data.length),
                },
            ],
        },
    );
    if (result.userErrors.length > 0)
        throw new Error(result.userErrors.map((e) => e.message).join("; "));

    const target = result.stagedTargets[0];
    if (!target) throw new Error("Shopify returned no upload target.");

    // Step 2: send the file there, together with the parameters Shopify gave us.
    const form = new FormData();
    for (const { name, value } of target.parameters) form.append(name, value);
    form.append("file", new Blob([data], { type: mimeType }), filename);

    const response = await fetch(target.url, { method: "POST", body: form });
    if (!response.ok)
        throw new Error(
            `Upload failed: ${response.status} ${await response.text()}`,
        );

    return target.resourceUrl;
}

interface FileCreateResult {
    fileCreate: {
        files: { id: string }[];
        userErrors: { field: string[] | null; message: string }[];
    };
}

const FILE_CREATE = `
    mutation CreateFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
            files {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`;

interface FileStatusResult {
    node: {
        fileStatus?: string;
        image?: { url: string } | null;
        fileErrors?: { message: string }[];
    } | null;
}

const FILE_STATUS = `
    query FileStatus($id: ID!) {
        node(id: $id) {
            ... on MediaImage {
                fileStatus
                image {
                    url
                }
                fileErrors {
                    message
                }
            }
        }
    }
`;

// Adds an uploaded image to Shopify Files and waits until it is processed.
// Returns the file's ID and its CDN URL.
export async function createImageFile(
    resourceUrl: string,
    timeoutMs = 60_000,
): Promise<{ id: string; url: string }> {
    const { fileCreate } = await graphql<FileCreateResult>(FILE_CREATE, {
        files: [{ originalSource: resourceUrl, contentType: "IMAGE" }],
    });
    if (fileCreate.userErrors.length > 0)
        throw new Error(fileCreate.userErrors.map((e) => e.message).join("; "));

    const id = fileCreate.files[0]?.id;
    if (!id) throw new Error("Shopify returned no file.");

    // The CDN URL only exists once Shopify has processed the image.
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const { node } = await graphql<FileStatusResult>(FILE_STATUS, { id });

        if (node?.fileStatus === "READY" && node.image)
            return { id, url: node.image.url };
        if (node?.fileStatus === "FAILED")
            throw new Error(
                `Shopify could not process the file: ${node.fileErrors?.map((e) => e.message).join("; ")}`,
            );
        if (Date.now() > deadline)
            throw new Error(`File ${id} was not ready after ${timeoutMs / 1000} seconds.`);

        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

export interface MediaResult {
    status: string;
    errors: string[];
}

interface ProductMediaResult {
    product: {
        media: {
            nodes: { status: string; mediaErrors: { message: string }[] }[];
        };
    } | null;
}

const PRODUCT_MEDIA = `
    query ProductMedia($id: ID!) {
        product(id: $id) {
            media(first: 50) {
                nodes {
                    status
                    mediaErrors {
                        message
                    }
                }
            }
        }
    }
`;

// Shopify processes images after productSet returns. Check every 2 seconds
// until each image is READY or FAILED, or the time limit is reached.
export async function waitForImages(
    productId: string,
    timeoutMs = 60_000,
): Promise<MediaResult[]> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
        const { product } = await graphql<ProductMediaResult>(PRODUCT_MEDIA, {
            id: productId,
        });
        const media = (product?.media.nodes ?? []).map((node) => ({
            status: node.status,
            errors: node.mediaErrors.map((e) => e.message),
        }));

        const done = media.every(
            (m) => m.status === "READY" || m.status === "FAILED",
        );
        if (done || Date.now() > deadline) return media;

        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}
