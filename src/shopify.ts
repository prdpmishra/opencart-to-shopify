import { requireEnv } from "./env.ts";

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
