interface TokenResponse {
    access_token: string;
    expires_in: number;
}

interface GraphQLResponse<T> {
    data?: T;
    errors?: { message: string }[];
}

interface ProductsQuery {
    products: {
        edges: { node: { id: string; title: string; handle: string } }[];
    };
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "")
        throw new Error(`Missing environment variable: ${name}`);

    return value;
}

const SHOP = requireEnv("SHOPIFY_SHOP");
const CLIENT_ID = requireEnv("SHOPIFY_CLIENT_ID");
const CLIENT_SECRET = requireEnv("SHOPIFY_CLIENT_SECRET");
const API_VERSION = requireEnv("SHOPIFY_API_VERSION");

// Accept either "my-store" or "my-store.myshopify.com".
const SHOP_DOMAIN = SHOP.endsWith(".myshopify.com")
    ? SHOP
    : `${SHOP}.myshopify.com`;

let token: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;

    const response = await fetch(
        `https://${SHOP_DOMAIN}/admin/oauth/access_token`,
        {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
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

async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
): Promise<T> {
    const response = await fetch(
        `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
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

async function main() {
    const query =
        "{ products(first: 3) { edges { node { id title handle } } } }";
    const data = await graphql<ProductsQuery>(query);
    console.log("Products:", JSON.stringify(data, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
