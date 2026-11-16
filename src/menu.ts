// Builds Shopify's main menu from OpenCart's header menu (top categories and
// their subcategories), each item linking to the category's collection.
// Collections missing for menu categories are created first.
//
// Usage: npm run menu -- [--dry-run]
import type { Connection } from "mysql2/promise";
import { parseArgs } from "node:util";
import { prepareCollections, type ProductCollection } from "./collections.ts";
import { saveStateOnce } from "./mapping.ts";
import { connect, getMenuCategories, getSeoUrlsEnabled, type Category } from "./opencart.ts";
import { buildCategoryRedirects, createRedirects } from "./redirects.ts";
import { getMenu, setMenuItems, type MenuItem } from "./shopify.ts";

const USAGE = "Usage: npm run menu -- [--dry-run]";
const MENU_HANDLE = "main-menu";

async function main() {
    let dryRun: boolean;
    try {
        const args = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
        dryRun = args.values["dry-run"];
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }

    let connection: Connection | undefined;
    try {
        connection = await connect();
        const tree = await getMenuCategories(connection);
        const seoUrls = await getSeoUrlsEnabled(connection);

        const menu = await getMenu(MENU_HANDLE);
        if (!menu) throw new Error(`Shopify has no menu with the handle "${MENU_HANDLE}".`);

        const collections = await prepareCollections(
            tree.flatMap(({ category, children }) => [category, ...children]),
            dryRun,
        );
        const created = await createRedirects(buildCategoryRedirects(collections, seoUrls), dryRun);
        if (created > 0) console.log(`Created ${created} URL redirect(s).`);

        const byCategory = new Map(collections.map((c) => [c.category.id, c]));
        const toItem = (category: Category, items: MenuItem[]): MenuItem => {
            const collection = byCategory.get(category.id) as ProductCollection;
            return { title: collection.title, type: "COLLECTION", resourceId: collection.id, items };
        };
        const items = tree.map(({ category, children }) =>
            toItem(category, children.map((child) => toItem(child, []))),
        );

        if (JSON.stringify(shape(menu.items)) === JSON.stringify(items)) {
            console.log(`${menu.title} is up to date (${describe(items)}).`);
            return;
        }

        const old = menu.items.map((item) => item.title).join(", ") || "nothing";
        if (dryRun) {
            console.log(`${menu.title} would be replaced. Now: ${old}. New:`);
            printTree(items);
            return;
        }

        // The items before the migration, so a rollback can put them back.
        saveStateOnce(`menu:${menu.handle}`, JSON.stringify(menu.items));
        await setMenuItems(menu, items);
        console.log(`${menu.title} replaced. It had: ${old}. Now ${describe(items)}:`);
        printTree(items);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally {
        await connection?.end();
    }
}

// Shopify's items without url and tags, which the items made here don't have.
function shape(items: MenuItem[]): MenuItem[] {
    return items.map(({ title, type, resourceId, items }) => ({ title, type, resourceId, items: shape(items) }));
}

function describe(items: MenuItem[]): string {
    const children = items.reduce((sum, item) => sum + item.items.length, 0);
    return `${items.length} categories, ${children} subcategories`;
}

function printTree(items: MenuItem[]): void {
    for (const item of items) {
        const children = item.items.map((child) => child.title).join(", ");
        console.log(`  ${item.title}${children ? ` → ${children}` : ""}`);
    }
}

await main();
