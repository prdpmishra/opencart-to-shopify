import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { requireEnv } from "./env.ts";
import type { AddressInput, CustomerInput, ProductSetInput } from "./convert.ts";

interface TokenResponse {
    access_token: string;
    expires_in: number;
}

interface GraphQLResponse<T> {
    data?: T;
    errors?: { message: string; extensions?: { code?: string } }[];
    extensions?: {
        cost?: {
            requestedQueryCost: number;
            throttleStatus: { currentlyAvailable: number; restoreRate: number };
        };
    };
}

// How often a throttled request is retried before giving up.
const MAX_RETRIES = 5;

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

    for (let attempt = 0; ; attempt++) {
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

        // 429: too many requests at the HTTP level. Wait a moment and try again.
        if (response.status === 429 && attempt < MAX_RETRIES) {
            await waitSeconds(2, "too many requests");
            continue;
        }
        if (!response.ok) {
            throw new Error(
                `GraphQL request failed: ${response.status} ${await response.text()}`,
            );
        }

        const { data, errors, extensions } = (await response.json()) as GraphQLResponse<T>;

        // Shopify allows a certain query cost per second. When it's used up, it refuses
        // with THROTTLED and says how fast the allowance comes back, so wait for that.
        if (errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < MAX_RETRIES) {
            const cost = extensions?.cost;
            const seconds = cost
                ? (cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) /
                  cost.throttleStatus.restoreRate
                : 2;
            await waitSeconds(Math.max(1, Math.ceil(seconds)), "Shopify rate limit");
            continue;
        }

        if (errors?.length) {
            throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
        }
        if (data === undefined) throw new Error("GraphQL response had no data");

        return data;
    }
}

async function waitSeconds(seconds: number, reason: string): Promise<void> {
    console.log(`Waiting ${seconds}s (${reason})...`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

interface ProductSetResult {
    productSet: {
        product: {
            id: string;
            handle: string;
        } | null;
        userErrors: { field: string[] | null; message: string; code: string | null }[];
    };
}

export interface SavedProduct {
    id: string;
    handle: string;
}

const PRODUCT_SET = `
    mutation SaveProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(synchronous: true, input: $input, identifier: $identifier) {
            product {
                id
                handle
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

    if (!productSet.product) throw new Error("Shopify returned no product and no errors.");
    return productSet.product;
}

export interface ShopifyProduct {
    id: string;
    title: string;
    descriptionHtml: string;
    handle: string;
    status: string;
    seo: { title: string | null; description: string | null };
    vendor: string;
    tags: string[];
    /** Whether the product is published to the Online Store sales channel. */
    onlineStore: boolean;
    variants: ShopifyVariant[];
    collections: { id: string; title: string }[];
    /** The product's metafields in the "custom" namespace. */
    metafields: { key: string; value: string; definitionId: string | null }[];
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
    requiresShipping: boolean;
    weight: { value: number; unit: string } | null;
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
        seo: { title: string | null; description: string | null };
        vendor: string;
        tags: string[];
        onlineStore: boolean;
        collections: { pageInfo: { hasNextPage: boolean }; nodes: { id: string; title: string }[] };
        metafields: {
            pageInfo: { hasNextPage: boolean };
            nodes: { key: string; value: string; definition: { id: string } | null }[];
        };
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
                    requiresShipping: boolean;
                    measurement: { weight: { value: number; unit: string } | null };
                    inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
                };
            }[];
        };
    } | null;
}

const PRODUCT_QUERY = `
    query GetProduct($id: ID!, $locationId: ID!, $publicationId: ID!) {
        product(id: $id) {
            id
            title
            descriptionHtml
            handle
            status
            seo {
                title
                description
            }
            vendor
            tags
            onlineStore: publishedOnPublication(publicationId: $publicationId)
            collections(first: 250) {
                pageInfo {
                    hasNextPage
                }
                nodes {
                    id
                    title
                }
            }
            metafields(namespace: "custom", first: 250) {
                pageInfo {
                    hasNextPage
                }
                nodes {
                    key
                    value
                    definition {
                        id
                    }
                }
            }
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
                        requiresShipping
                        measurement {
                            weight {
                                value
                                unit
                            }
                        }
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
        publicationId: await getOnlineStorePublicationId(),
    });
    if (!product) return null;

    // 250 is the most one request returns. Comparing a partial list would make
    // the update delete the variants we didn't see, so stop instead.
    if (product.variants.pageInfo.hasNextPage)
        throw new Error(`Shopify product ${productId} has more than 250 variants, which isn't supported.`);
    if (product.collections.pageInfo.hasNextPage)
        throw new Error(`Shopify product ${productId} is in more than 250 collections, which isn't supported.`);
    if (product.metafields.pageInfo.hasNextPage)
        throw new Error(`Shopify product ${productId} has more than 250 custom metafields, which isn't supported.`);

    return {
        ...product,
        collections: product.collections.nodes,
        metafields: product.metafields.nodes.map((m) => ({
            key: m.key,
            value: m.value,
            definitionId: m.definition?.id ?? null,
        })),
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
            requiresShipping: v.inventoryItem.requiresShipping,
            weight: v.inventoryItem.measurement.weight,
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
// until all expected images are there and each is READY or FAILED, or the time
// limit is reached. Images can appear on the product a moment after productSet.
export async function waitForImages(
    productId: string,
    expectedCount: number,
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

        const done =
            media.length >= expectedCount &&
            media.every((m) => m.status === "READY" || m.status === "FAILED");
        if (done || Date.now() > deadline) return media;

        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

export interface CollectionInput {
    title: string;
    descriptionHtml: string;
    handle?: string;
    image?: { src: string; altText: string };
}

const COLLECTION_CREATE = `
    mutation CreateCollection($collection: CollectionCreateInput!) {
        collectionCreate(collection: $collection) {
            collection {
                id
                handle
            }
            userErrors {
                field
                message
            }
        }
    }
`;

const COLLECTION_UPDATE = `
    mutation UpdateCollection($collection: CollectionUpdateInput!) {
        collectionUpdate(collection: $collection) {
            collection {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`;

const COLLECTION_QUERY = `
    query GetCollection($id: ID!, $publicationId: ID!) {
        collection(id: $id) {
            id
            title
            handle
            descriptionHtml
            onlineStore: publishedOnPublication(publicationId: $publicationId)
        }
    }
`;

// Each sales channel is an app; the Online Store app's handle is "online_store".
const PUBLICATIONS_QUERY = `
    query Publications {
        publications(first: 50) {
            nodes {
                id
                catalog {
                    ... on AppCatalog {
                        apps(first: 1) {
                            nodes {
                                handle
                            }
                        }
                    }
                }
            }
        }
    }
`;

const PUBLISHABLE_PUBLISH = `
    mutation Publish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
            userErrors {
                field
                message
            }
        }
    }
`;

function throwUserErrors(what: string, userErrors: { message: string }[]): void {
    if (userErrors.length > 0)
        throw new Error(`${what}: ${userErrors.map((e) => e.message).join("; ")}`);
}

export async function createCollection(
    input: CollectionInput,
): Promise<{ id: string; handle: string }> {
    const { collectionCreate } = await graphql<{
        collectionCreate: { collection: { id: string; handle: string } | null } & UserErrorsResult;
    }>(COLLECTION_CREATE, { collection: input });
    throwUserErrors("Shopify rejected the collection", collectionCreate.userErrors);
    if (!collectionCreate.collection) throw new Error("Shopify returned no collection.");
    return collectionCreate.collection;
}

export async function updateCollection(
    id: string,
    input: { title: string; descriptionHtml: string },
): Promise<void> {
    const { collectionUpdate } = await graphql<{ collectionUpdate: UserErrorsResult }>(
        COLLECTION_UPDATE,
        { collection: { id, ...input } },
    );
    throwUserErrors("Shopify rejected the collection update", collectionUpdate.userErrors);
}

export interface ShopifyCollection {
    id: string;
    title: string;
    handle: string;
    descriptionHtml: string;
    /** Whether the collection is published to the Online Store sales channel. */
    onlineStore: boolean;
}

// Returns null if the collection doesn't exist (e.g. it was deleted in Shopify).
export async function getCollection(id: string): Promise<ShopifyCollection | null> {
    const { collection } = await graphql<{ collection: ShopifyCollection | null }>(
        COLLECTION_QUERY,
        { id, publicationId: await getOnlineStorePublicationId() },
    );
    return collection;
}

let onlineStoreId: string | undefined;

// The ID of the Online Store sales channel's publication (looked up once).
export async function getOnlineStorePublicationId(): Promise<string> {
    if (!onlineStoreId) {
        const { publications } = await graphql<{
            publications: {
                nodes: { id: string; catalog: { apps?: { nodes: { handle: string }[] } } | null }[];
            };
        }>(PUBLICATIONS_QUERY);
        onlineStoreId = publications.nodes.find(
            (p) => p.catalog?.apps?.nodes[0]?.handle === "online_store",
        )?.id;
        if (!onlineStoreId) throw new Error("Shopify has no Online Store sales channel.");
    }
    return onlineStoreId;
}

// Makes a product or collection visible on the Online Store sales channel.
export async function publishToOnlineStore(id: string): Promise<void> {
    const publicationId = await getOnlineStorePublicationId();
    const { publishablePublish } = await graphql<{ publishablePublish: UserErrorsResult }>(
        PUBLISHABLE_PUBLISH,
        { id, input: [{ publicationId }] },
    );
    throwUserErrors("Could not publish to the Online Store", publishablePublish.userErrors);
}

// Hides a product or collection from the Online Store sales channel.
export async function unpublishFromOnlineStore(id: string): Promise<void> {
    const publicationId = await getOnlineStorePublicationId();
    const { publishableUnpublish } = await graphql<{ publishableUnpublish: UserErrorsResult }>(
        `mutation Unpublish($id: ID!, $input: [PublicationInput!]!) {
            publishableUnpublish(id: $id, input: $input) {
                userErrors { field message }
            }
        }`,
        { id, input: [{ publicationId }] },
    );
    throwUserErrors("Could not unpublish from the Online Store", publishableUnpublish.userErrors);
}

export interface MetafieldDefinition {
    id: string;
    namespace: string;
    key: string;
    name: string;
    type: { name: string };
}

const METAFIELD_DEFINITION_FIELDS = `id namespace key name type { name }`;

// Returns null if the definition doesn't exist (e.g. it was deleted in Shopify).
export async function getMetafieldDefinition(id: string): Promise<MetafieldDefinition | null> {
    const { node } = await graphql<{ node: MetafieldDefinition | null }>(
        `query GetMetafieldDefinition($id: ID!) {
            node(id: $id) { ... on MetafieldDefinition { ${METAFIELD_DEFINITION_FIELDS} } }
        }`,
        { id },
    );
    return node;
}

// The product metafield definition with this namespace and key, or null.
export async function findProductMetafieldDefinition(
    namespace: string,
    key: string,
): Promise<MetafieldDefinition | null> {
    const { metafieldDefinition } = await graphql<{ metafieldDefinition: MetafieldDefinition | null }>(
        `query FindMetafieldDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
            metafieldDefinition(identifier: $identifier) { ${METAFIELD_DEFINITION_FIELDS} }
        }`,
        { identifier: { ownerType: "PRODUCT", namespace, key } },
    );
    return metafieldDefinition;
}

// A product metafield definition as Shopify admin creates one under Settings →
// Custom data: pinned (shown on the product page) and readable by the theme.
export async function createProductMetafieldDefinition(input: {
    namespace: string;
    key: string;
    name: string;
    description: string;
    type: string;
}): Promise<string> {
    const { metafieldDefinitionCreate } = await graphql<{
        metafieldDefinitionCreate: { createdDefinition: { id: string } | null } & UserErrorsResult;
    }>(
        `mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
                createdDefinition { id }
                userErrors { field message }
            }
        }`,
        {
            definition: {
                ...input,
                ownerType: "PRODUCT",
                pin: true,
                access: { storefront: "PUBLIC_READ" },
            },
        },
    );
    throwUserErrors("Shopify rejected the metafield definition", metafieldDefinitionCreate.userErrors);
    if (!metafieldDefinitionCreate.createdDefinition) throw new Error("Shopify returned no metafield definition.");
    return metafieldDefinitionCreate.createdDefinition.id;
}

// Creates or updates these metafields on the product; others are left as they are.
export async function setProductMetafields(
    productId: string,
    metafields: { namespace: string; key: string; type: string; value: string }[],
): Promise<void> {
    // metafieldsSet takes at most 25 at a time.
    for (let i = 0; i < metafields.length; i += 25) {
        const { metafieldsSet } = await graphql<{ metafieldsSet: UserErrorsResult }>(
            `mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                    userErrors { field message }
                }
            }`,
            { metafields: metafields.slice(i, i + 25).map((m) => ({ ...m, ownerId: productId })) },
        );
        throwUserErrors("Shopify rejected the metafields", metafieldsSet.userErrors);
    }
}

export async function deleteProductMetafields(
    productId: string,
    metafields: { namespace: string; key: string }[],
): Promise<void> {
    const { metafieldsDelete } = await graphql<{ metafieldsDelete: UserErrorsResult }>(
        `mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
                userErrors { field message }
            }
        }`,
        { metafields: metafields.map((m) => ({ ...m, ownerId: productId })) },
    );
    throwUserErrors("Could not delete the metafields", metafieldsDelete.userErrors);
}

const URL_REDIRECT_CREATE = `
    mutation UrlRedirectCreate($urlRedirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $urlRedirect) {
            urlRedirect {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`;

// Creates a URL redirect from an old path to a new one. Returns null if the path
// already has a redirect (Shopify allows one per path).
export async function createUrlRedirect(path: string, target: string): Promise<string | null> {
    const { urlRedirectCreate } = await graphql<{
        urlRedirectCreate: { urlRedirect: { id: string } | null } & UserErrorsResult;
    }>(URL_REDIRECT_CREATE, { urlRedirect: { path, target } });

    if (urlRedirectCreate.userErrors.some((e) => e.message.includes("already been taken"))) return null;
    throwUserErrors("Shopify rejected the redirect", urlRedirectCreate.userErrors);
    if (!urlRedirectCreate.urlRedirect) throw new Error("Shopify returned no redirect.");
    return urlRedirectCreate.urlRedirect.id;
}

export interface MenuItem {
    title: string;
    type: string;
    /** The linked collection, product, page…; null for plain links. */
    resourceId: string | null;
    items: MenuItem[];
}

export interface ShopifyMenu {
    id: string;
    handle: string;
    title: string;
    items: MenuItem[];
}

// Menus can be nested 3 levels deep.
const MENUS_QUERY = `
    query Menus {
        menus(first: 250) {
            nodes {
                id
                handle
                title
                items {
                    title
                    type
                    resourceId
                    items {
                        title
                        type
                        resourceId
                        items {
                            title
                            type
                            resourceId
                        }
                    }
                }
            }
        }
    }
`;

const MENU_UPDATE = `
    mutation MenuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
            menu {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`;

// The menu with this handle (e.g. "main-menu"), or null. The menus query can't
// filter by handle, so all menus are fetched; a shop has only a few.
export async function getMenu(handle: string): Promise<ShopifyMenu | null> {
    const { menus } = await graphql<{ menus: { nodes: ShopifyMenu[] } }>(MENUS_QUERY);
    const menu = menus.nodes.find((m) => m.handle === handle);
    if (!menu) return null;
    // The deepest level isn't queried with its own items; make the shape the same everywhere.
    const fill = (items: MenuItem[]): MenuItem[] =>
        items.map((item) => ({ ...item, items: fill(item.items ?? []) }));
    return { ...menu, items: fill(menu.items) };
}

// Replaces all items of a menu. Title and handle stay as they are.
export async function setMenuItems(menu: ShopifyMenu, items: MenuItem[]): Promise<void> {
    const { menuUpdate } = await graphql<{ menuUpdate: UserErrorsResult }>(MENU_UPDATE, {
        id: menu.id,
        title: menu.title,
        handle: menu.handle,
        items,
    });
    throwUserErrors("Shopify rejected the menu", menuUpdate.userErrors);
}

// The shop's name, Shopify's default vendor (looked up once).
let shopName: string | undefined;
export async function getShopName(): Promise<string> {
    if (!shopName) {
        const { shop } = await graphql<{ shop: { name: string } }>("{ shop { name } }");
        shopName = shop.name;
    }
    return shopName;
}

// The shop's currency, e.g. "GBP" (looked up once).
let currencyCode: string | undefined;
export async function getShopCurrency(): Promise<string> {
    if (!currencyCode) {
        const { shop } = await graphql<{ shop: { currencyCode: string } }>("{ shop { currencyCode } }");
        currencyCode = shop.currencyCode;
    }
    return currencyCode;
}

// An automatic "amount off each item" discount on one product, once the cart
// holds at least minimumQuantity of it (all its variants count).
export interface AutomaticDiscount {
    title: string;
    /** Fixed amount off each item, e.g. "12.00". */
    amount: string;
    minimumQuantity: number;
    /** ISO date-time. */
    startsAt: string;
    /** ISO date-time, or null for no end. */
    endsAt: string | null;
}

const DISCOUNT_CREATE = `
    mutation DiscountCreate($discount: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicCreate(automaticBasicDiscount: $discount) {
            automaticDiscountNode {
                id
            }
            userErrors {
                field
                code
                message
            }
        }
    }
`;

const DISCOUNT_UPDATE = `
    mutation DiscountUpdate($id: ID!, $discount: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $discount) {
            automaticDiscountNode {
                id
            }
            userErrors {
                field
                code
                message
            }
        }
    }
`;

const DISCOUNT_DELETE = `
    mutation DiscountDelete($id: ID!) {
        discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors {
                field
                code
                message
            }
        }
    }
`;

const DISCOUNT_QUERY = `
    query Discount($id: ID!) {
        discountNode(id: $id) {
            id
            discount {
                ... on DiscountAutomaticBasic {
                    title
                    startsAt
                    endsAt
                    minimumRequirement {
                        ... on DiscountMinimumQuantity {
                            greaterThanOrEqualToQuantity
                        }
                    }
                    customerGets {
                        value {
                            ... on DiscountAmount {
                                amount {
                                    amount
                                }
                            }
                        }
                    }
                }
            }
        }
    }
`;

// The DiscountAutomaticBasicInput for a discount on productId.
function discountInput(productId: string, discount: AutomaticDiscount) {
    return {
        title: discount.title,
        startsAt: discount.startsAt,
        endsAt: discount.endsAt,
        minimumRequirement: {
            quantity: { greaterThanOrEqualToQuantity: String(discount.minimumQuantity) },
        },
        customerGets: {
            value: { discountAmount: { amount: discount.amount, appliesOnEachItem: true } },
            items: { products: { productsToAdd: [productId] } },
        },
        // Only the biggest tier reached applies; order discounts (e.g. codes) and
        // shipping discounts can still apply on top, as coupons do in OpenCart.
        combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true },
    };
}

export async function createAutomaticDiscount(productId: string, discount: AutomaticDiscount): Promise<string> {
    const { discountAutomaticBasicCreate: result } = await graphql<{
        discountAutomaticBasicCreate: { automaticDiscountNode: { id: string } | null } & UserErrorsResult;
    }>(DISCOUNT_CREATE, { discount: discountInput(productId, discount) });
    throwUserErrors("Shopify rejected the discount", result.userErrors);
    if (!result.automaticDiscountNode) throw new Error("Shopify returned no discount.");
    return result.automaticDiscountNode.id;
}

export async function updateAutomaticDiscount(
    id: string,
    productId: string,
    discount: AutomaticDiscount,
): Promise<void> {
    const { discountAutomaticBasicUpdate: result } = await graphql<{
        discountAutomaticBasicUpdate: UserErrorsResult;
    }>(DISCOUNT_UPDATE, { id, discount: discountInput(productId, discount) });
    throwUserErrors("Shopify rejected the discount update", result.userErrors);
}

export async function deleteAutomaticDiscount(id: string): Promise<void> {
    const { discountAutomaticDelete: result } = await graphql<{ discountAutomaticDelete: UserErrorsResult }>(
        DISCOUNT_DELETE,
        { id },
    );
    throwUserErrors("Could not delete the discount", result.userErrors);
}

// The discount as AutomaticDiscount, or null if it no longer exists.
export async function getAutomaticDiscount(id: string): Promise<AutomaticDiscount | null> {
    const { discountNode } = await graphql<{
        discountNode: {
            discount: {
                title: string;
                startsAt: string;
                endsAt: string | null;
                minimumRequirement: { greaterThanOrEqualToQuantity?: string } | null;
                customerGets: { value: { amount?: { amount: string } } };
            };
        } | null;
    }>(DISCOUNT_QUERY, { id });
    if (!discountNode) return null;

    const d = discountNode.discount;
    return {
        title: d.title,
        amount: Number(d.customerGets.value.amount?.amount ?? 0).toFixed(2),
        minimumQuantity: Number(d.minimumRequirement?.greaterThanOrEqualToQuantity ?? 0),
        startsAt: d.startsAt,
        endsAt: d.endsAt,
    };
}

// Finds a Shopify customer by email (Shopify ignores upper/lower case).
export async function findCustomerIdByEmail(email: string): Promise<string | null> {
    const data = await graphql<{ customerByIdentifier: { id: string } | null }>(
        `query ($email: String!) { customerByIdentifier(identifier: { emailAddress: $email }) { id } }`,
        { email },
    );
    return data.customerByIdentifier?.id ?? null;
}

// "gid://shopify/Customer/123" → the customer's page in Shopify admin.
export function adminCustomerUrl(customerId: string): string {
    const store = requireEnv("SHOPIFY_SHOP").replace(/\.myshopify\.com$/, "");
    return `https://admin.shopify.com/store/${store}/customers/${customerId.split("/").pop()}`;
}

// Creates a customer, or updates the one that already has this email.
export async function setCustomer(input: CustomerInput): Promise<string> {
    const { customerSet } = await graphql<{
        customerSet: { customer: { id: string } | null } & UserErrorsResult;
    }>(
        `mutation ($input: CustomerSetInput!, $email: String!) {
            customerSet(identifier: { email: $email }, input: $input) {
                customer { id }
                userErrors { field message }
            }
        }`,
        { input, email: input.email },
    );
    throwUserErrors("Shopify rejected the customer", customerSet.userErrors);
    if (!customerSet.customer) throw new Error("Shopify returned no customer.");
    return customerSet.customer.id;
}

export async function createCustomerAddress(
    customerId: string,
    address: AddressInput,
    setAsDefault: boolean,
): Promise<string> {
    const { customerAddressCreate } = await graphql<{
        customerAddressCreate: { address: { id: string } | null } & UserErrorsResult;
    }>(
        `mutation ($customerId: ID!, $address: MailingAddressInput!, $setAsDefault: Boolean) {
            customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: $setAsDefault) {
                address { id }
                userErrors { field message }
            }
        }`,
        { customerId, address, setAsDefault },
    );
    throwUserErrors("Shopify rejected the address", customerAddressCreate.userErrors);
    if (!customerAddressCreate.address) throw new Error("Shopify returned no address.");
    return customerAddressCreate.address.id;
}

// Records that the customer agreed to marketing emails (OpenCart's newsletter box).
// "Single opt-in": they ticked a box, without confirming by email.
export async function subscribeToEmailMarketing(customerId: string, since: string): Promise<void> {
    const { customerEmailMarketingConsentUpdate } = await graphql<{
        customerEmailMarketingConsentUpdate: UserErrorsResult;
    }>(
        `mutation ($input: CustomerEmailMarketingConsentUpdateInput!) {
            customerEmailMarketingConsentUpdate(input: $input) { userErrors { field message } }
        }`,
        {
            input: {
                customerId,
                emailMarketingConsent: {
                    marketingState: "SUBSCRIBED",
                    marketingOptInLevel: "SINGLE_OPT_IN",
                    consentUpdatedAt: since,
                },
            },
        },
    );
    throwUserErrors("Shopify rejected the marketing consent", customerEmailMarketingConsentUpdate.userErrors);
}
