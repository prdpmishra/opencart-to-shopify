# OpenCart to Shopify

Migrates products from an OpenCart 3.0 database to a Shopify store through the Admin GraphQL API.

For now it migrates one product at a time with its basic details, images, variants and stock: title, description, handle, price, SKU, the main image, the additional images, select/radio options as variants, quantities, and categories as collections. Products are created as drafts.

## Requirements

- Node.js 22.13 or later (for `--env-file` and the built-in `node:sqlite`)
- Access to an OpenCart 3.0 MySQL database
- A Shopify app with these scopes:

  ```
  read_products,write_products,read_files,write_files,read_inventory,write_inventory,read_locations,read_publications,write_publications,read_online_store_navigation,write_online_store_navigation
  ```

  Products, files, inventory, locations and publications are used now; the navigation scopes are for upcoming features (menus, URL redirects). The app's client ID and secret are used to get an access token through the client credentials grant. After adding a scope to the app, the store has to approve the updated permissions before the token includes it.

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
SHOPIFY_LOCATION_ID=gid://shopify/Location/123456789
PRICE_TAX_RATE=
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
| `SHOPIFY_LOCATION_ID` | Yes, for `migrate` | The Shopify location that gets OpenCart's stock |
| `PRICE_TAX_RATE` | Only if Shopify's "All prices include tax" is on | Tax rate in % added to OpenCart's prices, e.g. `20` |

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
   - **SKU:** the OpenCart SKU, or the model if the SKU is empty. Variants get the SKU plus their option values, e.g. `Product 8-small`.
   - **Price:** unchanged, rounded to 2 decimals. A variant's price is the product price plus (or minus) its option values' price modifiers.
   - **Special price:** the special that OpenCart applies right now for the default customer group (start date empty or past, end date empty or future; lowest priority, then lowest price) becomes the sale price, and the normal price becomes the compare-at price, which themes show crossed out. Without a special, the compare-at price is cleared. Shopify can't schedule price changes, so a special with an end date gives a warning to run `--update` after it ends, and a future special is applied by an `--update` after it starts. Specials for other customer groups and quantity discounts (`product_discount`) are not migrated; each one gives a warning.
   - **Tax:** a product is taxable ("Charge tax on this product") when its OpenCart tax class has at least one tax rule. OpenCart stores prices excluding tax, so they're sent unchanged when Shopify's "All prices include tax" setting is off. When it's on, `PRICE_TAX_RATE` is added (e.g. 100.00 at 20% → 120.00), so customers pay the same total; without `PRICE_TAX_RATE` the run stops. Tax rates themselves aren't product data in Shopify: set them up in Shopify's tax settings. Fixed tax amounts (e.g. an eco tax) have no Shopify equivalent and give a warning.
   - **Categories:** each of the product's OpenCart categories becomes a manual Shopify collection, created the first time a product in it is migrated (empty categories are never created). Title, description (cleaned, images moved to Shopify Files) and image come from the category, and the handle from its SEO keyword, like products. Collections of enabled categories are published to the Online Store. Shopify collections can't be nested, so the category tree isn't kept. Each collection is remembered in `migration.sqlite`.
   - **Variants:** select and radio options (up to 3, Shopify's limit) become Shopify options, and every combination of their values becomes a variant. Products without them get Shopify's single `Default Title` variant. Other option types (checkbox, text, textarea, date, time, date & time, file) are customer inputs with no standard Shopify equivalent: they are skipped with a warning, which also says when the option was required.
   - **Stock:** OpenCart's "Subtract Stock" becomes Shopify's "Track quantity". For tracked products, the quantity becomes the available quantity at `SHOPIFY_LOCATION_ID`. OpenCart tracks stock per product and per option value, not per combination, so a variant gets the lowest quantity that OpenCart tracks for it (the product's and each chosen value's). OpenCart's "allow checkout when out of stock" store setting becomes "Continue selling when out of stock". OpenCart's stock status text ("2-3 Days", "Pre-Order") and minimum order quantity have no Shopify equivalent and are not migrated.
   - **Description clean-up:** the HTML is tidied to match what Shopify's editor produces: HTML comments and `class` attributes are removed, `<font>` tags are removed (their text is kept, so the theme's font is used), `<b>`/`<i>` become `<strong>`/`<em>`, and line breaks and tabs are collapsed. The visible text doesn't change.
   - **Images inside the description:** each `<img src>` that points to OpenCart (`OPENCART_IMAGE_URL`, the same path without the domain, or a relative `image/…` / `catalog/…` path) is uploaded to Shopify Files and its `src` replaced with the Shopify CDN URL. Each image is uploaded once and remembered in `migration.sqlite`. Missing files and other websites' images keep their original URL. With `--dry-run`, nothing is uploaded.
4. Finds the product's images in `OPENCART_IMAGE_DIR`: the main image first, then the additional images by sort order. Missing files are skipped with a warning.
5. With `--dry-run`, prints the converted product and the images it found, then stops. Shopify is not called and nothing is uploaded or saved.
6. Uploads each image to Shopify (staged upload). A failed upload is skipped with a warning.
7. Creates the product with its images and collections in one `productSet` call.
8. Saves the OpenCart → Shopify ID mapping in `migration.sqlite`, then prints the admin link.
9. Waits up to a minute for Shopify to process the images and prints each one's status (`READY` or `FAILED`).

### Updating a migrated product (`--update`)

OpenCart is the source of truth: the title, description, variants, prices, SKUs and stock in Shopify are overwritten with OpenCart's values.

> **Note:** this includes the available quantity. That's right while OpenCart is the live shop, but once Shopify takes orders, `--update` would overwrite stock that Shopify has reduced.

1. Fetches the mapped product from Shopify, with all its variants. Stops if it no longer exists.
2. Matches each variant to the Shopify variant with the same option values. Matched variants keep their Shopify ID. New combinations are created, and Shopify variants that no longer exist in OpenCart are deleted.
3. Prints each difference, e.g. `variant "Medium": price 99.00 → 110.00`. If nothing differs, it says the product is up to date and doesn't call Shopify. Whitespace between HTML tags is ignored when comparing descriptions, because Shopify reformats HTML when saving it.
4. With `--dry-run`, stops after printing the differences.
5. Updates the product, its variants and its collections with `productSet`. Only collections created from OpenCart categories are added or removed; collections a product was added to by hand in Shopify (e.g. the home page) are kept. The title and description of existing collections are updated from their categories too.
6. Sets the available quantity of each changed existing variant with `inventorySetQuantities`, passing the quantity it just read as `changeFromQuantity`. If the stock changed in Shopify in the meantime (e.g. a sale), Shopify refuses instead of overwriting it. If the item isn't stocked at the location yet, it is activated there.

The handle, status and gallery images are not changed, so product URLs stay the same and a product you have activated in Shopify stays active. Changes to the gallery images in OpenCart are not synced; images inside the description are.

`migration.sqlite` records which products, categories and description images have been migrated, so don't delete it. It is gitignored.

## Project structure

```
src/
  migrate.ts   Migrate one product (npm run migrate)
  index.ts     List products from both stores (npm start)
  env.ts       requireEnv() for reading environment variables
  opencart.ts  Database connection and product queries
  convert.ts   OpenCart product → Shopify productSet input, handle building
  shopify.ts   Access token, graphql() helper and product creation
  collections.ts  OpenCart categories → Shopify collections
  description.ts  Images inside descriptions → Shopify Files
  mapping.ts   SQLite mapping of migrated products and files
```
