/**
 * Sources QuickInsight cannot connect to directly yet, and how to bring their
 * data in as a file instead — in the words the store's own screens use. Shown
 * instead of a "connection" that would load sample rows as if they were the
 * user's own.
 */
export interface SourceGuide {
    id: string;
    name: string;
    /** "Bring in your Shopify orders" */
    title: string;
    /** Why this is a file and not a live link, said plainly. */
    lead: string;
    steps: string[];
    /** What QuickInsight does with that export, so the owner knows it is understood. */
    weRead: string;
    /** A limit of the export worth knowing before you rely on it. */
    caveat?: string;
}

export const SOURCE_GUIDES: Record<string, SourceGuide> = {
    shopify: {
        id: 'shopify',
        name: 'Shopify',
        title: 'Bring in your Shopify orders',
        lead: "A direct Shopify connection isn't available yet. Exporting your orders takes a minute, and the file is read in your browser, so it never leaves this computer.",
        steps: [
            'In your Shopify admin, open Orders and click Export.',
            'Choose All orders (or Orders by date for a period), pick CSV, then click Export orders. Up to 50 orders download straight away; more are emailed to you.',
            'Upload that file here.',
        ],
        weRead: "We read Shopify's export as it comes: the lines of an order stay together, totals, shipping and taxes count once per order, and discount codes, refunds and returning customers are recognised.",
    },
    woocommerce: {
        id: 'woocommerce',
        name: 'WooCommerce',
        title: 'Bring in your WooCommerce orders',
        lead: "A direct WooCommerce connection isn't available yet. You can export your orders from WordPress in a minute, and the file is read in your browser, so it never leaves this computer.",
        steps: [
            'In WordPress, open Analytics, then Orders, and choose the date range you want.',
            'Click Download to save the orders as a CSV file. A large report may be emailed to you instead.',
            'Upload that file here.',
        ],
        weRead: 'We read the export as it comes: order numbers, dates, customers, products, coupons and net sales.',
        caveat: 'WooCommerce Analytics only includes completed and refunded orders, so orders still processing are left out of its export.',
    },
    mysql: {
        id: 'mysql',
        name: 'MySQL',
        title: 'Bring in data from MySQL',
        lead: "A direct MySQL connection isn't available yet (SQL Server and PostgreSQL are). Export the tables you need instead. The file is read in your browser, so it never leaves this computer.",
        steps: [
            'In MySQL Workbench, right-click a table and choose Table Data Export Wizard, then save it as CSV.',
            'For several tables (orders, order lines, products), paste each one into its own sheet of one Excel workbook.',
            'Upload the CSV or the workbook here.',
        ],
        weRead: 'A workbook with several sheets is read like a database: we find how the sheets link (an order line to its order and product) and never count a row twice.',
    },
};

/** True when this source has a working direct connection. */
export const connectsDirectly = (id: string) => !SOURCE_GUIDES[id];
