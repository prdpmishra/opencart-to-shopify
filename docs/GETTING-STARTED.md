# Getting started

A step-by-step guide to moving an OpenCart 3.0 shop to Shopify with this tool: from downloading it to a finished migration. The [README](../README.md) is the reference for what each command does with the data; this guide is the order to do things in.

**Before you start, know what the tool is:**

- **A one-time migration, not a live sync.** It copies OpenCart's products, customers and order history into Shopify. Changes made in OpenCart afterwards only reach Shopify when you run the commands again with `--update`, and nothing is ever copied back to OpenCart. The plan is: migrate, check, bring over the last changes, switch the domain to Shopify. Shopify takes no orders until the migration is finished.
- **For OpenCart 3.0** (tested with 3.0.2.0 to 3.0.5.0), its default store, one language and its default currency. Extensions that change OpenCart's tables or add their own order totals may need code changes.
- **A command-line tool.** You need to be comfortable running commands in a terminal and editing a settings file. No programming is needed for a normal migration.

It only **reads** the OpenCart database and image folder; it never changes OpenCart.

## 1. What you need

- **Node.js 22.13 or later.** Check with `node --version`; download it from [nodejs.org](https://nodejs.org/) if needed.
- **Git**, to download the tool (or download the ZIP from GitHub instead).
- **Access to the OpenCart MySQL database**: host, user name, password and database name. They're in OpenCart's `config.php` (`DB_HOSTNAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PREFIX`). A user with read-only access is enough, and safer.
- **OpenCart's `image` folder on the same computer** as the tool, for product, category and description images. On a hosted shop, download it first (e.g. by FTP). Images that aren't found are skipped with a warning; the products are still created.
- **A Shopify account** with access to the [Dev Dashboard](https://dev.shopify.com/dashboard), where you create a development store to test on and the app the tool connects through (step 3).

## 2. Download and install

```sh
git clone https://github.com/prdpmishra/opencart-to-shopify.git
cd opencart-to-shopify
npm install
npm test
```

`npm test` runs the unit tests, which need no database or Shopify. All of them should pass.

## 3. Create a development store and the Shopify app

The tool talks to Shopify through an app that you create yourself. It gets its access token with Shopify's *client credentials grant*, which **only works when the app and the store belong to the same Shopify organization**. So create both from the same Dev Dashboard.

1. **Create a development store** to test on: in the [Dev Dashboard](https://dev.shopify.com/dashboard), open **Dev stores** and create one. A dev store created from the Shopify admin instead isn't part of your organization, and the tool can't connect to it.
2. **Create the app:** open **Apps → Create app** and give it a name, e.g. "OpenCart migration".
3. **Create a version with the access scopes:** on the app's **Versions** page, create a version. Leave the App URL at its default (the tool isn't embedded in the admin), and paste these scopes:

   ```
   read_products,write_products,read_files,write_files,read_inventory,write_inventory,read_locations,read_publications,write_publications,read_online_store_navigation,write_online_store_navigation,read_discounts,write_discounts,read_customers,write_customers,read_orders,write_orders
   ```

   Then select **Release**.
4. **Request protected customer data access**, needed to migrate customers and orders. Without it, Shopify answers "This app is not approved to access the Customer object". In the Partner Dashboard, open the app, go to **API access requests → Protected customer data access → Request access**, select **Protected customer data** and the **Name, Email, Phone and Address** fields, each with a reason (e.g. "migrating our own customers from our previous shop"), and save. For development stores no review is needed.
5. **Install the app on the store:** open the app and select **Install app**, choose the development store, and select **Install**.
6. **Copy the credentials:** in the app's **Settings**, copy the **Client ID** and **Client secret**. Treat the secret like a password.

If you later add a scope, release a new version and then approve the new access on the app's page in the store's Shopify admin (**Review access → Update**); the token only includes approved scopes.

*Optional:* to be able to [roll back](../README.md#rollback-npm-run-rollback) orders more than about 55 days after migrating them, request the `read_all_orders` scope before migrating (see [Requirements](../README.md#requirements)).

## 4. Prepare the Shopify store

Set these in the Shopify admin **before** migrating, because the migration uses them:

- **Store currency** (in Settings, with the store details): the same as OpenCart's default currency. Orders are refused otherwise.
- **Taxes** (Settings → Taxes and duties): the tax rates of your country. And decide on **"All prices include tax"**: OpenCart stores prices without tax, so if this is on, set `PRICE_TAX_RATE` (step 5) to the rate to add, e.g. `20`.
- **Location** (Settings → Locations): the location that gets OpenCart's stock. Its ID is the number at the end of the page's URL when you open it, e.g. `.../settings/locations/123456789`.
- **Notifications:** turn off Shopify Flow, Shopify Email and app automations for new orders, and the staff "new order" notifications (Settings → Notifications → Staff notifications), so no one is emailed about historical orders. The tool itself never sends order emails to customers.

## 5. Fill in the settings

Copy `.env.example` to `.env` (it's never committed to Git) and fill it in:

```ini
# OpenCart database (from OpenCart's config.php)
DB_HOST=localhost
DB_USER=opencart_readonly
DB_PASSWORD=secret
DB_NAME=opencart
DB_PREFIX=oc_
LANGUAGE_ID=1
OPENCART_IMAGE_DIR=C:\path\to\opencart\image
OPENCART_IMAGE_URL=https://myshop.com/image/
OPENCART_STORE_URL=https://myshop.com/
OPENCART_TIMEZONE=Europe/Berlin
OPENCART_ORDER_STATUS_MAP=

# Shopify app (step 3) and store (step 4)
SHOPIFY_SHOP=my-dev-store
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_API_VERSION=2026-10
SHOPIFY_LOCATION_ID=gid://shopify/Location/123456789
PRICE_TAX_RATE=
```

Where to find the values that aren't obvious:

| Setting | How to find it |
| --- | --- |
| `DB_PREFIX` | `DB_PREFIX` in OpenCart's `config.php`, usually `oc_`. Leave empty if the tables have no prefix (`product`, not `oc_product`). |
| `LANGUAGE_ID` | The language to migrate names and descriptions in: `SELECT language_id, name FROM oc_language;` |
| `OPENCART_IMAGE_DIR` | The `image` folder on this computer (the one that contains `catalog/`). |
| `OPENCART_IMAGE_URL` | That folder's address as used in product descriptions, e.g. `https://myshop.com/image/`. Open a product description's HTML in OpenCart's admin to see it. |
| `OPENCART_STORE_URL` | `HTTP_SERVER` in OpenCart's `config.php`. Used to build redirects from the old URLs, so for the real migration it must be the **live** shop's address. |
| `OPENCART_TIMEZONE` | `date.timezone` in the OpenCart server's `php.ini` (ask your host if unsure), e.g. `Europe/London`. |
| `OPENCART_ORDER_STATUS_MAP` | Only if the shop added its own order statuses. List them with `SELECT order_status_id, name FROM oc_order_status WHERE language_id = 1;` The defaults are 1 Pending, 2 Processing, 3 Shipped, 5 Complete, 7 Canceled, 8 Denied, 9 Canceled Reversal, 10 Failed, 11 Refunded, 12 Reversed, 13 Chargeback, 14 Expired, 15 Processed, 16 Voided. Map each extra one to the default it means, e.g. `20:5,22:1` (20 like Complete, 22 like Pending). Orders with an unmapped own status are skipped with a warning. |
| `SHOPIFY_SHOP` | The store's `xxx.myshopify.com` name, with or without `.myshopify.com`. |
| `SHOPIFY_LOCATION_ID` | `gid://shopify/Location/` followed by the number from step 4. |
| `PRICE_TAX_RATE` | Only when "All prices include tax" is on: the rate in %, e.g. `20`. |

The README's [settings table](../README.md#setup) explains each one in more detail.

## 6. Check the connection

```sh
npm start
```

This lists a few products from OpenCart and from Shopify. If both lists appear, the settings work. If not, see [Troubleshooting](#troubleshooting).

## 7. Dry runs: check everything without changing anything

Every command accepts `--dry-run`: it reads OpenCart, converts the data and prints what it would send, without calling Shopify to change anything.

```sh
npm run migrate -- --all --dry-run
npm run menu -- --dry-run
npm run customers -- --all --dry-run
npm run orders -- --all --dry-run
```

Save the output to a file to read it in peace, e.g. `npm run migrate -- --all --dry-run > dry-run.log 2>&1`. Then read the **warnings** (data that is left out or changed, e.g. a missing image or a special price for another customer group) and the **summary** at the end, which lists every item that would fail with its reason. Fix the data in OpenCart or accept the warning before going on.

## 8. Test migration on the development store

Run the commands in this order, because each one builds on the ones before it:

```sh
npm run migrate -- --all         # products, with their collections, images, stock and redirects
npm run menu                     # the main menu from OpenCart's category menu
npm run related                  # related products
npm run customers -- --all       # customers with their addresses
npm run orders -- --all          # order history
```

How long it takes: a few seconds per product, more with many images and redirects, so a few thousand products take hours. Development stores allow about 5 new orders a minute, so 1,000 orders take about 3½ hours or more.

**Stopping and resuming.** You can stop a run with Ctrl+C and start the same command again later: what's already migrated is recorded in `migration.sqlite` and skipped. A product that was being created at the moment you stopped may be missing its URL redirects or quantity discounts, and a plain rerun skips it as already migrated. Update that one product (the last `── Product <id>` line before you stopped) to fill them in: `npm run migrate -- <id> --update`.

**Check the result** in the Shopify admin: compare a sample of products (prices, variants, stock, images), collections, customers and orders (totals, tax, status) with OpenCart.

**Then roll the test back:**

```sh
npm run rollback          # shows what would be deleted and changes nothing
npm run rollback -- --yes # deletes everything the migration created
```

Only what the migration created is removed; demo data and anything you added by hand stay. If something was wrong, change the settings or the data, and test again from step 7.

**Testing with real data.** Real shop data finds problems that demo data doesn't, but a development store is no place for real customers' details. [`scripts/anonymise.sql`](../scripts/anonymise.sql) replaces names, emails, addresses and phone numbers in a **copy** of the database; see [Testing with a copy of real data](../README.md#testing-with-a-copy-of-real-data).

## 9. Migrate the real store

When the test migration is right, follow [Migrating the real store](../README.md#migrating-the-real-store) in the README. In short:

1. Back up OpenCart's database and `image` folder.
2. Set up the real Shopify store as in step 4. The app must be installed on it and, as in step 3, the app and the store must be in the **same organization**: create the app in the Dev Dashboard of the organization that owns the live store.
3. Point `.env` at the live data and the real store, with `OPENCART_STORE_URL` set to the live address, and start with a **new, empty** `migration.sqlite` (move the test one away).
4. Dry-run everything again, then migrate in the order of step 8 and check the result.
5. Just before switching the domain: stop taking orders in OpenCart, run `npm run migrate -- --all --update` and `npm run customers -- --all --update` to bring over the last changes, and `npm run orders -- --all` for the last orders.
6. Point the domain to Shopify. The redirects send the old OpenCart URLs to the new pages.
7. Keep `migration.sqlite` and a backup of it: every later `--update` and the rollback work from it.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `Missing environment variable: …` | That setting is empty or missing in `.env`. Check the name and that you're running the command from the project folder. |
| `Token request failed: 400 … shop_not_permitted` | The app and the store aren't in the same Shopify organization, or `SHOPIFY_SHOP` is misspelled. Check in the Dev Dashboard that the store is listed under **Dev stores** of the organization that owns the app (step 3). |
| `Token request failed: 4xx` (other) | Wrong client ID or secret, or the app isn't installed on the store. |
| `Access denied` / `ER_ACCESS_DENIED_ERROR`, `ECONNREFUSED` | The database settings are wrong, or MySQL isn't running or doesn't accept connections from this computer. |
| `Access denied for …` or a missing-scope error from Shopify | A scope is missing: add it in a new app version, release it and approve it in the store (step 3). |
| `This app is not approved to access the Customer object` | Protected customer data access is missing (step 3, point 4). |
| `Missing environment variable: PRICE_TAX_RATE` | Shopify's "All prices include tax" is on: set `PRICE_TAX_RATE`, or turn that setting off. |
| `OpenCart's default currency is …, but the Shopify shop's currency is …` | Make the Shopify store's currency the same as OpenCart's (step 4). |
| `Warning: image not found, skipping: …` | The file isn't in `OPENCART_IMAGE_DIR`. Check the folder; the product is created without that image. |
| `Table '….product' doesn't exist` | `DB_PREFIX` is wrong. |
| An order fails with "isn't supported" | The order uses something the tool can't record correctly (e.g. reward points, two taxes, a free-shipping coupon). It isn't migrated, and the run carries on with the next order; the README's [Orders](../README.md#orders-npm-run-orders) section lists the cases. |

Shopify limits how fast an app may work; when it says to slow down, the tool waits and retries by itself.

## What isn't migrated

Shopify has no built-in place for some OpenCart data, so the tool leaves it out: product reviews, coupons as discount codes, gift voucher codes and balances, customer passwords (customers sign in with a one-time code sent by email), reward points and store credit, prices for customer groups other than the default, information pages, returns, affiliates, and customer inputs on products (text, date and file options). Product dimensions aren't migrated either: Shopify sets parcel sizes as shipping packages. See [Not migrated](../README.md#not-migrated) for details.
