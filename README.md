# OpenCart to Shopify

Reads products from an OpenCart database and talks to a Shopify store through the Admin GraphQL API, as groundwork for migrating products from OpenCart to Shopify.

For now, `npm start` lists up to 20 products from OpenCart and the first 3 products from Shopify. It doesn't copy anything yet.

## Requirements

- Node.js 22.13 or later (for `--env-file` and the built-in `node:sqlite`)
- Access to an OpenCart MySQL database
- A Shopify app with Admin API access. Its client ID and secret are used to get an access token through the client credentials grant.

## Setup

```sh
npm install
```

Create a `.env` file in the project root. It is gitignored.

```ini
# OpenCart database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=opencart
DB_PREFIX=oc_
LANGUAGE_ID=1

# Shopify app
SHOPIFY_SHOP=my-store
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_API_VERSION=2025-10
```

| Variable | Required | Notes |
| --- | --- | --- |
| `DB_HOST`, `DB_USER`, `DB_NAME` | Yes | |
| `DB_PASSWORD` | Yes | Can be empty |
| `DB_PREFIX` | No | Table prefix, e.g. `oc_`. Defaults to none. |
| `LANGUAGE_ID` | No | OpenCart language for product names. Defaults to `1`. |
| `SHOPIFY_SHOP` | Yes | `my-store` or `my-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Yes | From the Shopify app's settings |
| `SHOPIFY_API_VERSION` | Yes | Admin API version, e.g. `2025-10` |

## Usage

```sh
npm start          # list OpenCart and Shopify products
npm run typecheck  # type-check without running
```

## Project structure

```
src/
  index.ts     Entry point
  env.ts       requireEnv() for reading environment variables
  opencart.ts  Database connection and product query
  shopify.ts   Access token and graphql() helper
```
