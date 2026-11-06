# OpenCart to Shopify

Migrates products from an OpenCart 3.0 database to a Shopify store through the Admin GraphQL API.

For now it migrates one product at a time with its basic details and images: title, description, handle, price, SKU, the main image and the additional images. Products are created as drafts. Inventory, variants and categories are not migrated yet.

## Requirements

- Node.js 22.13 or later (for `--env-file` and the built-in `node:sqlite`)
- Access to an OpenCart 3.0 MySQL database
- A Shopify app with these scopes:

  ```
  read_products,write_products,read_files,write_files,read_inventory,write_inventory,read_locations,read_publications,write_publications,read_online_store_navigation,write_online_store_navigation
  ```

  Products and files are used now; the others are for upcoming features (inventory, sales channels, URL redirects). The app's client ID and secret are used to get an access token through the client credentials grant. After adding a scope to the app, the store has to approve the updated permissions before the token includes it.

## Setup

```sh
npm install
```

Copy `.env.example` to `.env` and fill in the values. `.env` is gitignored.

```ini
# OpenCart database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=opencart
DB_PREFIX=oc_
LANGUAGE_ID=1
OPENCART_IMAGE_DIR=C:\xampp\htdocs\opencart\image
OPENCART_IMAGE_URL=http://localhost/opencart/image/

# Shopify app
SHOPIFY_SHOP=my-store
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_API_VERSION=2026-10
```

| Variable | Required | Notes |
| --- | --- | --- |
| `DB_HOST`, `DB_USER`, `DB_NAME` | Yes | |
| `DB_PASSWORD` | Yes | Can be empty |
| `DB_PREFIX` | No | Table prefix, e.g. `oc_`. Defaults to none. |
| `LANGUAGE_ID` | No | OpenCart language for product names, descriptions and SEO keywords. Defaults to `1`. |
| `OPENCART_IMAGE_DIR` | Yes, for `migrate` | OpenCart's `image` folder on this computer |
| `OPENCART_IMAGE_URL` | Yes, for `migrate` | The URL of that folder as used in descriptions, e.g. `http://localhost/opencart/image/` |
| `SHOPIFY_SHOP` | Yes | `my-store` or `my-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Yes | From the Shopify app's settings |
| `SHOPIFY_API_VERSION` | Yes | Admin API version, e.g. `2026-10` |

## Usage

```sh
npm run migrate -- 48 --dry-run  # show what would be sent for OpenCart product 48
npm run migrate -- 48            # create it in Shopify as a draft
npm run migrate -- 48 --update --dry-run  # show what would change in Shopify
npm run migrate -- 48 --update   # update the migrated product from OpenCart
npm start                        # list OpenCart and Shopify products
npm run typecheck                # type-check without running
```

### How `migrate` works

1. Checks `migration.sqlite` and stops if the product was already migrated.
2. Reads the product from OpenCart.
3. Converts it to Shopify's format:
   - **Handle:** the product's SEO keyword (store 0), normalised to lowercase letters, numbers and hyphens. Falls back to the product name, then `product-<id>`. Any change or fallback is logged.
   - **SKU:** the OpenCart SKU, or the model if the SKU is empty.
   - **Price:** unchanged, rounded to 2 decimals.
   - **Description clean-up:** the HTML is tidied to match what Shopify's editor produces: HTML comments and `class` attributes are removed, `<font>` tags are removed (their text is kept, so the theme's font is used), `<b>`/`<i>` become `<strong>`/`<em>`, and line breaks and tabs are collapsed. The visible text doesn't change.
   - **Images inside the description:** each `<img src>` that points to OpenCart (`OPENCART_IMAGE_URL`, the same path without the domain, or a relative `image/…` / `catalog/…` path) is uploaded to Shopify Files and its `src` replaced with the Shopify CDN URL. Each image is uploaded once and remembered in `migration.sqlite`. Missing files and other websites' images keep their original URL. With `--dry-run`, nothing is uploaded.
4. Finds the product's images in `OPENCART_IMAGE_DIR`: the main image first, then the additional images by sort order. Missing files are skipped with a warning.
5. With `--dry-run`, prints the converted product and the images it found, then stops. Shopify is not called and nothing is uploaded or saved.
6. Uploads each image to Shopify (staged upload). A failed upload is skipped with a warning.
7. Creates the product with its images in one `productSet` call.
8. Saves the OpenCart → Shopify ID mapping in `migration.sqlite`, then prints the admin link.
9. Waits up to a minute for Shopify to process the images and prints each one's status (`READY` or `FAILED`).

### Updating a migrated product (`--update`)

OpenCart is the source of truth: the title, description, price and SKU in Shopify are overwritten with OpenCart's values.

1. Fetches the mapped product from Shopify. Stops if it no longer exists, or if it doesn't have exactly one variant (an update would delete the others).
2. Prints each difference as `field: old → new`. If nothing differs, it says the product is up to date and doesn't call Shopify. Whitespace between HTML tags is ignored when comparing descriptions, because Shopify reformats HTML when saving it.
3. With `--dry-run`, stops after printing the differences.
4. Updates the product with `productSet`, keeping the existing variant (same ID).

The handle, status and gallery images are not changed, so product URLs stay the same and a product you have activated in Shopify stays active. Changes to the gallery images in OpenCart are not synced; images inside the description are.

`migration.sqlite` records which products and description images have been migrated, so don't delete it. It is gitignored.

## Project structure

```
src/
  migrate.ts   Migrate one product (npm run migrate)
  index.ts     List products from both stores (npm start)
  env.ts       requireEnv() for reading environment variables
  opencart.ts  Database connection and product queries
  convert.ts   OpenCart product → Shopify productSet input, handle building
  shopify.ts   Access token, graphql() helper and product creation
  description.ts  Images inside descriptions → Shopify Files
  mapping.ts   SQLite mapping of migrated products and files
```
