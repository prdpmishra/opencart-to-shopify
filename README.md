# OpenCart to Shopify

Migrates products and customers from an OpenCart 3.0 database to a Shopify store through the Admin GraphQL API.

For now it migrates one product at a time with its basic details, images, variants and stock: title, description, handle, price, SKU, the main image, the additional images, select/radio options as variants, quantities, categories as collections, attributes as metafields, status, SEO, vendor, tags, weight, and URL redirects from the old OpenCart URLs. Enabled products become active and are published to the Online Store; disabled ones become drafts. Customers are migrated with their addresses, phone number and newsletter consent (see [Customers](#customers-npm-run-customers)).

## Requirements

- Node.js 22.13 or later (for `--env-file` and the built-in `node:sqlite`)
- Access to an OpenCart 3.0 MySQL database
- A Shopify app with these scopes:

  ```
  read_products,write_products,read_files,write_files,read_inventory,write_inventory,read_locations,read_publications,write_publications,read_online_store_navigation,write_online_store_navigation,read_discounts,write_discounts,read_customers,write_customers
  ```

  All of them are used: products, files, inventory, locations, publications (sales channels), online store navigation (URL redirects and the main menu), discounts and customers. The app's client ID and secret are used to get an access token through the client credentials grant. After adding a scope to the app, the store has to approve the updated permissions before the token includes it.

  Customers also need **protected customer data access**: without it, Shopify answers "This app is not approved to access the Customer object", even with the customer scopes. In the Partner Dashboard, open the app, go to **API access requests → Protected customer data access → Request access**, select **Protected customer data** and then the **Name, Email, Phone and Address** fields, each with a reason, and save. For an app installed only on development stores, that's all: no review or data protection details are needed. (The Dev Dashboard has no page for this.)

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
OPENCART_STORE_URL=http://localhost/opencart/

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
| `OPENCART_STORE_URL` | Yes, for `migrate` | OpenCart's store URL (`HTTP_SERVER` in its `config.php`). Only its path is used for redirects: set it to the live shop's URL before the real migration. |
| `OPENCART_IMAGE_URL` | Yes, for `migrate` | The URL of that folder as used in descriptions, e.g. `http://localhost/opencart/image/` |
| `SHOPIFY_SHOP` | Yes | `my-store` or `my-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Yes | From the Shopify app's settings |
| `SHOPIFY_API_VERSION` | Yes | Admin API version, e.g. `2026-10` |
| `SHOPIFY_LOCATION_ID` | Yes, for `migrate` | The Shopify location that gets OpenCart's stock |
| `PRICE_TAX_RATE` | Only if Shopify's "All prices include tax" is on | Tax rate in % added to OpenCart's prices, e.g. `20` |

## Usage

```sh
npm run migrate -- 48 --dry-run  # show what would be sent for OpenCart product 48
npm run migrate -- 48            # create it in Shopify
npm run migrate -- 48 --update --dry-run  # show what would change in Shopify
npm run migrate -- 48 --update   # update the migrated product from OpenCart
npm run migrate -- --all --dry-run  # check every product without changing anything
npm run migrate -- --all         # create every product not migrated yet
npm run migrate -- --all --update  # also update the ones already migrated
npm run menu -- --dry-run        # show the main menu that would be built from OpenCart's
npm run menu                     # replace Shopify's main menu with OpenCart's category menu
npm run customers -- 1 --dry-run # show what would be sent for OpenCart customer 1
npm run customers -- --all       # create every customer not migrated yet
npm run customers -- --all --update  # also update the ones already migrated
npm start                        # list OpenCart and Shopify products
npm run typecheck                # type-check without running
npm test                         # unit tests (no database or Shopify needed)
```

### Migrating all products (`--all`)

`--all` goes through every OpenCart product in ID order. Products that aren't migrated yet are created; already-migrated ones are skipped, or updated with `--update`. If one product fails, the error is logged and the run continues. At the end a summary shows how many products were created, updated, up to date, skipped or failed, with each failure's error, and the exit code is 1 if any failed. A run can safely be repeated: the mapping in `migration.sqlite` prevents duplicates.

Shopify limits how much API work an app can do per second. When a request is refused as throttled (or with HTTP 429), the script waits as long as Shopify says is needed and retries, up to 5 times.

### How `migrate` works

1. Checks `migration.sqlite` and stops if the product was already migrated.
2. Reads the product from OpenCart.
3. Converts it to Shopify's format:
   - **Handle:** the product's SEO keyword (store 0), normalised to lowercase letters, numbers and hyphens. Falls back to the product name, then `product-<id>`. Any change or fallback is logged.
   - **SKU:** the OpenCart SKU, or the model if the SKU is empty. Variants get the SKU plus their option values, e.g. `Product 8-small`.
   - **Price:** unchanged, rounded to 2 decimals. A variant's price is the product price plus (or minus) its option values' price modifiers.
   - **Special price:** the special that OpenCart applies right now for the default customer group (start date empty or past, end date empty or future; lowest priority, then lowest price) becomes the sale price, and the normal price becomes the compare-at price, which themes show crossed out. Without a special, the compare-at price is cleared. Shopify can't schedule price changes, so a special with an end date gives a warning to run `--update` after it ends, and a future special is applied by an `--update` after it starts. Specials for other customer groups are not migrated; each one gives a warning.
   - **Quantity discounts:** see [Quantity discounts](#quantity-discounts) below.
   - **Tax:** a product is taxable ("Charge tax on this product") when its OpenCart tax class has at least one tax rule. OpenCart stores prices excluding tax, so they're sent unchanged when Shopify's "All prices include tax" setting is off. When it's on, `PRICE_TAX_RATE` is added (e.g. 100.00 at 20% → 120.00), so customers pay the same total; without `PRICE_TAX_RATE` the run stops. Tax rates themselves aren't product data in Shopify: set them up in Shopify's tax settings. Fixed tax amounts (e.g. an eco tax) have no Shopify equivalent and give a warning.
   - **Status:** enabled products whose "Date Available" has passed become `ACTIVE` and are published to the Online Store (Shopify doesn't publish active products by itself). Disabled products, products not assigned to OpenCart's default store, and products available from a future date become `DRAFT`; run `--update` after that date.
   - **SEO, vendor, tags:** the meta title and meta description become Shopify's SEO title and description (tabs and extra spaces removed; empty ones fall back to the product title and description). The manufacturer becomes the vendor; without one, Shopify uses the shop's name, its default (also when the manufacturer is removed in OpenCart later). OpenCart's comma-separated tags become Shopify tags (duplicates that differ only in upper/lower case are merged, as Shopify does). Meta keywords have no Shopify equivalent and are skipped.
   - **Weight and shipping:** a variant's weight is the product weight plus its option values' weights, in the product's unit (kg, g, lb or oz; another unit gives a warning). OpenCart's "Requires Shipping" becomes "This is a physical product". Length, width and height have no Shopify product field (parcel sizes are shipping packages) and give a warning.
   - **Categories:** each of the product's OpenCart categories becomes a manual Shopify collection, created the first time a product in it is migrated (empty categories only get one through `npm run menu`, below). Title, description (cleaned, images moved to Shopify Files) and image come from the category, and the handle from its SEO keyword, like products. Collections of enabled categories are published to the Online Store, also on later runs if one isn't published yet; a category disabled later is unpublished again. Shopify collections can't be nested, so the category tree isn't kept. Each collection is remembered in `migration.sqlite`.
   - **Attributes:** OpenCart's attributes (the "Specification" tab, e.g. "No. of Cores: 4") become product metafields in the `custom` namespace, the merchant's own, as Shopify admin creates them. Each attribute gets a metafield definition the first time a product with it is migrated: the key comes from the attribute name (`No. of Cores` → `custom.no_of_cores`), the name stays as it is, and the OpenCart attribute group goes into the definition's description, since Shopify has no groups. Definitions are single-line text (OpenCart's values are free text such as `100mhz`), pinned so they show on the product page in admin, and readable by the theme. Each definition is remembered in `migration.sqlite` and keeps its key if the attribute is renamed later. A definition with the same key that already exists in Shopify is used if it has the same type; two attributes that would get the same key stop the run. Empty values are skipped. Themes don't show metafields by themselves: add them in the theme editor ("dynamic source") or use them as filters with the Search & Discovery app.
   - **Variants:** select and radio options (up to 3, Shopify's limit) become Shopify options, and every combination of their values becomes a variant. Products without them get Shopify's single `Default Title` variant. Other option types (checkbox, text, textarea, date, time, date & time, file) are customer inputs with no standard Shopify equivalent: they are skipped with a warning, which also says when the option was required.
   - **Stock:** OpenCart's "Subtract Stock" becomes Shopify's "Track quantity". For tracked products, the quantity becomes the available quantity at `SHOPIFY_LOCATION_ID`. OpenCart tracks stock per product and per option value, not per combination, so a variant gets the lowest quantity that OpenCart tracks for it (the product's and each chosen value's). OpenCart's "allow checkout when out of stock" store setting becomes "Continue selling when out of stock". OpenCart's stock status text ("2-3 Days", "Pre-Order") and minimum order quantity have no Shopify equivalent and are not migrated.
   - **Description clean-up:** the HTML is tidied to match what Shopify's editor produces: HTML comments and `class` attributes are removed, `<font>` tags are removed (their text is kept, so the theme's font is used), `<b>`/`<i>` become `<strong>`/`<em>`, and line breaks and tabs are collapsed. The visible text doesn't change.
   - **Images inside the description:** each `<img src>` that points to OpenCart (`OPENCART_IMAGE_URL` over http or https, the same path without the domain, or a relative `image/…` / `catalog/…` path) is uploaded to Shopify Files and its `src` replaced with the Shopify CDN URL. Each image is uploaded once and remembered in `migration.sqlite`. Missing files and other websites' images keep their original URL, and paths that lead outside `OPENCART_IMAGE_DIR` (`../`) are skipped with a warning. With `--dry-run`, nothing is uploaded.
4. Finds the product's images in `OPENCART_IMAGE_DIR`: the main image first, then the additional images by sort order. Missing files are skipped with a warning.
5. With `--dry-run`, prints the converted product and the images it found, then stops. Shopify is not called and nothing is uploaded or saved.
6. Uploads each image to Shopify (staged upload). A failed upload is skipped with a warning.
7. Creates the product with its images, collections and metafields in one `productSet` call, then publishes it to the Online Store if it's active.
8. Saves the OpenCart → Shopify ID mapping in `migration.sqlite`, then prints the admin link.
9. Waits up to a minute for Shopify to process the images and prints each one's status (`READY` or `FAILED`).

### Updating a migrated product (`--update`)

OpenCart is the source of truth: the title, description, status, SEO, vendor, tags, attribute metafields, variants, prices, SKUs, weights and stock in Shopify are overwritten with OpenCart's values. An active product that isn't on the Online Store yet is published.

> **Note:** this includes the available quantity. That's right while OpenCart is the live shop, but once Shopify takes orders, `--update` would overwrite stock that Shopify has reduced.

1. Fetches the mapped product from Shopify, with all its variants. Stops if it no longer exists.
2. Matches each variant to the Shopify variant with the same option values. Matched variants keep their Shopify ID. New combinations are created, and Shopify variants that no longer exist in OpenCart are deleted.
3. Prints each difference, e.g. `variant "Medium": price 99.00 → 110.00`. If nothing differs, it says the product is up to date and doesn't call Shopify. Whitespace between HTML tags is ignored when comparing descriptions, because Shopify reformats HTML when saving it.
4. With `--dry-run`, stops after printing the differences.
5. Updates the product, its variants and its collections with `productSet`. Only collections created from OpenCart categories are added or removed; collections a product was added to by hand in Shopify (e.g. the home page) are kept. The title and description of existing collections are updated from their categories too.
6. Sets new and changed attribute metafields with `metafieldsSet`, and deletes the values of attributes the product no longer has in OpenCart with `metafieldsDelete`. Only metafields of migrated attributes are deleted; metafields added in Shopify are kept.
7. Sets the available quantity of each changed existing variant with `inventorySetQuantities`, passing the quantity it just read as `changeFromQuantity`. If the stock changed in Shopify in the meantime (e.g. a sale), Shopify refuses instead of overwriting it. If the item isn't stocked at the location yet, it is activated there.

The handle and gallery images are not changed, so product URLs stay the same. Status does follow OpenCart: a product disabled in OpenCart becomes a draft in Shopify. Changes to the gallery images in OpenCart are not synced; images inside the description are.

### Quantity discounts

OpenCart's quantity discounts ("buy 10 or more for 88.00 each") become Shopify **automatic discounts**, one per tier, synced after each product is created or updated. They're kept the same way as in OpenCart's cart:

- **Amount:** a fixed amount off each item, the normal price minus the tier price (plus `PRICE_TAX_RATE` when Shopify's prices include tax). In OpenCart, option price modifiers are added on top of the tier price, so every variant gets the same amount off. A tier that isn't lower than the normal price gives a warning.
- **Minimum quantity:** all variants of the product in the cart count towards it, as in OpenCart.
- **Tiers:** the discounts don't combine with each other, so Shopify applies only the biggest tier reached. They do combine with order and shipping discounts (e.g. discount codes), as coupons do in OpenCart.
- **Dates:** OpenCart's start and end dates become the discount's start and end, so Shopify schedules them itself. Tiers that have already ended aren't migrated.
- **Title** (shown at checkout): e.g. `Buy 10+, save $12.00 each`, in the shop's currency.

Only tiers for OpenCart's default customer group are migrated; others give a warning, as does a second tier with the same quantity (OpenCart's choice, lowest priority and then price, is used).

**An active special price turns the tiers off.** OpenCart's cart then charges the special price whatever the quantity, while in Shopify a tier would come off the special price. So while a special is active, the tiers aren't migrated (existing ones are deleted) with a warning to run `--update` after the special ends.

On `--update`, OpenCart is the source of truth: changed tiers are updated, tiers removed in OpenCart are deleted from Shopify, and a discount deleted in Shopify is created again. Each discount is remembered in `migration.sqlite` by product and quantity, because OpenCart gives tier rows new IDs each time a product is saved. Shopify allows only a limited number of active automatic discounts per store (25, according to its help centre).

### URL redirects

After a product is created or updated, its old OpenCart URLs get Shopify URL redirects to the new pages, so existing links and search results keep working once the domain points to Shopify:

| Old OpenCart URL | New Shopify URL |
| --- | --- |
| `index.php?route=product/product&product_id=48` | `/products/<handle>` |
| `index.php?route=product/product&path=20_27&product_id=41` (from a category page) | `/products/<handle>` |
| `index.php?route=product/category&path=20_27` | `/collections/<handle>` |
| `index.php?route=product/manufacturer/info&manufacturer_id=8` | `/collections/vendors?q=Apple` (Shopify's built-in vendor page) |

When OpenCart's "Use SEO URLs" setting is on, the SEO forms are added too (`/imac`, `/desktops/mac`, `/desktops/mac/imac`, `/apple`), built the way OpenCart builds them. All paths start with the path of `OPENCART_STORE_URL`. Shopify matches query parameters in any order. Each redirect is created once and remembered in `migration.sqlite`; a path that already has a redirect made outside the migration is left alone with a warning. Redirects only take effect while the old path doesn't exist in Shopify, and can't be tried while the storefront is password-protected.

### Main menu (`npm run menu`)

Replaces the items of Shopify's main menu (handle `main-menu`) with OpenCart's header menu, so run it after the products are migrated. The categories are picked the way OpenCart's menu picks them: enabled top-level categories with "Show in top menu" on, each with its enabled subcategories as a dropdown, all in the default store, sorted by sort order and then name. Each item links to the category's collection.

Categories in the menu that have no collection yet (because no migrated product is in them) get one first, created and published like any other, with redirects from their old category URLs. OpenCart's dropdown column count has no Shopify equivalent.

The menu is compared with Shopify's first: if it's the same, nothing is changed, so the command can be rerun. Otherwise the whole menu is replaced, including items added in Shopify, and the old top-level items are logged. Shopify's footer and other menus aren't touched.

### Customers (`npm run customers`)

`npm run customers -- <id>|--all [--update] [--dry-run]` works like `migrate`: `--all` goes through every customer, continues after a failure and prints a summary; `--dry-run` only prints.

- **Name and email:** the email is lowercased (Shopify ignores case in emails). If Shopify already has a customer with the same email, that customer is updated and linked instead of creating a duplicate, and the run says "linked".
- **Phone:** converted to E.164 (`+911234567890`), the format Shopify requires, with [libphonenumber-js](https://www.npmjs.com/package/libphonenumber-js). A number without `+` is read as a number of the default address's country, so the same digits can be valid in one country and not in another. An invalid number is left out with a warning. Shopify allows each phone number on one customer only, like an email.
- **Addresses:** all of them, the OpenCart default staying the default. The country becomes its ISO code. OpenCart's zone code is sent as the province code: for countries without provinces in Shopify (e.g. the Netherlands) Shopify drops it, and a code Shopify doesn't accept (OpenCart's Delhi is `DE`, Shopify's `DL`) is left out with a warning, so the province can be set by hand. Shopify may reformat postcodes (`8225BZ` → `8225 BZ`).
- **Newsletter:** a subscriber becomes "subscribed" to email marketing (single opt-in, dated at registration, as OpenCart doesn't record when the box was ticked). Others stay "not subscribed".
- **Customer group:** a group other than OpenCart's default becomes a tag.
- **Note:** `Migrated from OpenCart: customer #1, registered 2026-02-19.` Shopify's "customer since" date can't be set.
- **Not migrated:** passwords (Shopify can't import password hashes; customers sign in with a one-time code sent by email, so migrated customers show "No account" until they first do), reward points, transactions, wishlists and custom fields. Disabled customers are skipped with a warning.

Each customer and address is remembered in `migration.sqlite`, saved straight after it's created. With `--update`, OpenCart is the source of truth: the email, name, phone, note and tags (tags added in Shopify are removed), the addresses, the default address and the email marketing state are brought in line, and only the differences are printed and sent. Addresses added in Shopify are kept; migrated addresses removed in OpenCart are deleted, and one deleted in Shopify is added again. Unsubscribing in OpenCart unsubscribes in Shopify. A disabled customer is left as it is in Shopify.

`migration.sqlite` records which products, categories, attributes, description images, redirects, discounts, customers and addresses have been migrated, so don't delete it. It always lives in the project folder, whichever folder the script is run from, and is gitignored.

## Project structure

```
src/
  migrate.ts   Migrate one product (npm run migrate)
  menu.ts      OpenCart category menu → Shopify main menu (npm run menu)
  customers.ts Migrate customers with their addresses (npm run customers)
  index.ts     List products from both stores (npm start)
  env.ts       requireEnv() for reading environment variables
  opencart.ts  Database connection, product and customer queries
  convert.ts   OpenCart product/customer → Shopify input, handle building
  shopify.ts   Access token, graphql() helper and product creation
  collections.ts  OpenCart categories → Shopify collections
  attributes.ts   OpenCart attributes → Shopify metafield definitions
  discounts.ts OpenCart quantity discounts → Shopify automatic discounts
  description.ts  Images inside descriptions → Shopify Files
  mapping.ts   SQLite mapping of migrated products, categories, attributes, customers, addresses, files, redirects and discounts
  redirects.ts Old OpenCart URLs → Shopify URL redirects
```
