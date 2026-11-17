# Design decisions

Why the tool works the way it does: the problem behind each decision, what was chosen, and what it costs. The [README](../README.md) describes the behaviour; this page explains the reasoning.

## 1. A mapping table makes every run safe to repeat

**Problem.** A migration of thousands of items will be interrupted: a network error, a Shopify rate limit, someone pressing Ctrl+C, a bug found halfway. Starting again from zero would mean deleting everything first, and blindly running again would create duplicates.

**Decision.** Every item the tool creates is recorded in a local SQLite file, `migration.sqlite`: one row per OpenCart ID and type (`product`, `category`, `customer`, `address`, `order`, …) with the Shopify ID it became, and a primary key on (type, OpenCart ID). Before creating anything, the tool looks it up there: a recorded product is skipped, or updated with `--update`. Each row is written immediately after Shopify confirms the creation, not at the end of the run, so a run stopped at product 300 resumes at product 301. Shopify itself is never searched to decide "does this exist?" (handles and titles change; IDs don't).

**Why SQLite.** It ships with Node (`node:sqlite`), needs no server, and one file is easy to back up and keep with the store it belongs to. The same file later tells `--update` which Shopify product to update and tells the rollback what to delete.

**Trade-offs.** The file belongs to one Shopify store: pointing it at another store would make the tool think everything already exists, so the README says to keep one per store. There is a small window between Shopify creating a product and the row being written: if the process dies exactly then, a re-run creates a duplicate. And the steps after the row (URL redirects, quantity discounts) are skipped by a plain re-run, so an interrupted product needs `--update` once. Both are documented rather than hidden.

## 2. Stock per variant is the lowest quantity OpenCart tracks for it

**Problem.** OpenCart and Shopify model stock differently. OpenCart keeps one quantity for the product and one per option *value* ("Size: Large: 5", "Colour: Red: 3"), but not per *combination*. Shopify keeps one quantity per variant, and a variant is a combination (Large / Red).

**Decision.** Every combination of select/radio option values becomes a Shopify variant, and its stock is the **lowest** of the quantities OpenCart tracks for it: the product's own quantity and each chosen value's (a quantity with "Subtract stock" off doesn't count, as OpenCart doesn't reduce it). Large / Red with product 10, Large 5, Red 3 gets 3.

**Why.** In OpenCart a sale of Large / Red reduces the product, Large *and* Red, so none of them can go below zero: the most that can be sold of that combination is the lowest of them. Taking the minimum means Shopify never sells something OpenCart couldn't have.

**Trade-off.** The quantities across variants add up to more than the real stock (Large / Red and Large / Blue both count the same 5 Large). That's unavoidable without per-combination data, and the safe direction: no variant oversells, though the shop owner should check variant stock after the migration.

## 3. Orders are created as history, and the run stops at the first notification

**Problem.** Creating an order in Shopify normally behaves like a new sale: it can email the customer, notify staff, reduce stock and trigger automations. Migrating 1,000 historical orders must not email 1,000 customers about orders from years ago, or reduce stock that OpenCart already reduced.

**Decision.** Orders are created with `sendReceipt` and `sendFulfillmentReceipt` explicitly `false` and inventory behaviour `BYPASS` (the products' stock was migrated after OpenCart took the sold items off). Because notifications set up in the store itself (Shopify Flow, Shopify Email, apps, staff alerts) are outside the API's control, the tool also reads each new order's timeline straight after creating it, and if Shopify logged any email, SMS or notification, it **stops the whole run** so no second customer is affected. The README tells users to turn those automations off before migrating.

**Why both.** The flags prevent what the API controls; the timeline check is a safety net for what it doesn't. Stopping, instead of logging and carrying on, follows from the cost: one wrong email is an embarrassment, a thousand is a crisis.

**Trade-offs.** Orders are create-only (Shopify orders can hardly be edited afterwards), so there is no `--update`. Shopify numbers them itself (#1001, …), as an OpenCart number could clash with Shopify's own; the original number is in the order note.

## 4. Rounding differences go on the tax, within five cents

**Problem.** OpenCart stores amounts to four decimals and rounds only the order total, which is what the customer actually paid. Shopify works in cents and adds up parts that are each already rounded. The two can differ by a cent or two, which would leave a migrated order showing "1 cent outstanding" or "1 cent to refund".

**Decision.** The tool rebuilds the total the way Shopify will add it up, compares it with what was paid, and puts the difference on the tax (the last taxed line, or else the shipping tax), so the Shopify total equals what the customer paid to the cent. Only differences up to 0.05 are treated as rounding: anything bigger means the order wasn't understood (a total type the tool doesn't know, a tax that can't be split), and the order **fails with an error** instead of being silently "corrected". Verified against OpenCart for all 1,052 orders of a real (anonymised) shop.

**Why the tax.** The total paid is the fact that must not change. The tax is already the least exact part, as OpenCart doesn't store tax per line or on shipping and it has to be reconstructed, and a one-cent shift there doesn't change anything a customer or accountant would see as the price.

**Trade-off.** The order's tax can be a cent off OpenCart's rounded tax. A guard on the size of the correction keeps a real bug from hiding as "rounding".

## 5. The rollback deletes only what the migration recorded creating

**Problem.** A test migration needs a clean way back, and so does a real one that goes wrong. But the store may already contain things the migration didn't create: demo data, products added by hand, and customers who existed before and were *linked* rather than created (same email address).

**Decision.** The rollback works only from `migration.sqlite`, never from searching Shopify. Each row records whether the item was created by the migration or already existed and was linked (`linked`). Created items are deleted, in dependency order (orders, customers, discounts, redirects, products, collections, metafield definitions, files); linked ones are kept, and only the addresses the migration added to them are removed. What Shopify did as a side effect is recorded too (customers it created for guest orders, the main menu before it was replaced) so it can be undone. Without `--yes` the rollback only prints its plan.

**Safety rules.** Each row is removed as soon as its item is deleted, so a rollback that stops halfway can be run again. Items already deleted by hand are just forgotten. It refuses to run when it can't be done completely: when the mapping file comes from a version that didn't record what was linked, or when the orders are older than Shopify lets the app see (60 days without the `read_all_orders` scope), because then deleted-looking orders would stay in the store.

**Trade-off.** Changes the migration made to linked customers (name, phone, tags) can't be undone, as their previous values weren't stored; the rollback lists them. Rolling back is meant for before go-live.

## Known limitation: quantity discounts

OpenCart's quantity discounts ("10 or more for 88.00 each") become one Shopify automatic discount per tier. That reproduces OpenCart's behaviour with standard Shopify features, but Shopify allows only a limited number of active automatic discounts per store (25, according to its help centre), so a catalogue with many tiered products reaches the limit quickly. The better design is a [Shopify Function](https://shopify.dev/docs/apps/build/functions) (a discount function): one discount that reads each product's tiers from a metafield and applies the right one in the cart. It needs an app with an extension deployed to the store, which is why it isn't part of this command-line tool yet.
