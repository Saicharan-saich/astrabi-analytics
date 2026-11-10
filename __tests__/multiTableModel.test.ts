/**
 * Workbooks with several sheets (and stores with several tables): which
 * columns are keys, how the sheets link, what each table is, the joined view
 * the app works from, what the AI is told, and how the answer check follows
 * joins — including a sum that a join inflates.
 */
import { describe, it, expect } from 'vitest';
import { discoverRelationships, detectCandidateKeys } from '../services/ai-sql/relationshipDiscovery';
import { buildRelationalCatalog, defaultSubjectTable, materializeSubject } from '../services/relationalCatalog';
import { normalizeRelatedTables } from '../services/relationalNormalization';
import { describeData } from '../services/ai-sql/leanPipeline';
import { checkAnswer } from '../services/answerCheck/answerCheck';
import { duckTableName, tablesByDuckName } from '../utils/duckColumnType';

let seed = 5;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];

/** A shop's workbook as Shopify-style exports come: orders, their lines, products, customers. */
function shopWorkbook() {
    seed = 5;
    const products = [['TEE-01', 'Organic Tee', 'Apparel', 22, 8], ['HOOD-01', 'Hoodie', 'Apparel', 48, 20], ['TOTE-01', 'Tote', 'Bags', 15, 4], ['MUG-01', 'Mug', 'Homeware', 16, 6]] as const;
    const customers = Array.from({ length: 30 }, (_, i) => ({ Email: `c${i}@example.com`, City: pick(['London', 'Leeds', 'Bristol']) }));
    const orders: any[] = [];
    const lines: any[] = [];
    for (let o = 0; o < 120; o++) {
        let sub = 0;
        for (let k = 0; k < 1 + (o % 3); k++) {
            const p = pick([...products]);
            sub += p[3];
            lines.push({ Order: `#${1001 + o}`, SKU: p[0], Quantity: 1, Price: p[3].toFixed(2) });
        }
        const day = new Date(Date.UTC(2026, 8, 1) + (o % 60) * 86_400_000).toISOString().slice(0, 10);
        orders.push({ Name: `#${1001 + o}`, Email: o % 10 === 0 ? `guest${o}@example.com` : pick(customers).Email, 'Created at': `${day} 09:30:00`, Shipping: '3.95', Total: (sub + 3.95).toFixed(2) });
    }
    lines[5].SKU = 'GONE-99'; // a product since deleted from the catalogue
    return normalizeRelatedTables([
        { name: 'Orders', rows: orders }, { name: 'Line Items', rows: lines },
        { name: 'Products', rows: products.map(p => ({ SKU: p[0], Title: p[1], Type: p[2], Price: p[3].toFixed(2), 'Cost per item': p[4].toFixed(2) })) },
        { name: 'Customers', rows: customers },
    ], 'shop.xlsx').tables;
}

describe('keys and links in real exports', () => {
    const tables = shopWorkbook();
    const { relationships, rejected } = discoverRelationships(tables);
    const link = (from: string, column: string) => relationships.find(r => r.fromTable === from && r.fromColumn === column);

    it('recognises SKUs, order numbers written #1001 and email addresses as keys', () => {
        const key = (table: string, column: string) => detectCandidateKeys(tables.find(t => t.name === table)!).find(k => k.column === column)?.isKey;
        expect(key('Products', 'sku')).toBe(true);
        expect(key('Orders', 'name')).toBe(true);
        expect(key('Customers', 'email')).toBe(true);
    });

    it('links lines to products and orders, and orders to customers', () => {
        expect(link('Line Items', 'sku')?.toTable).toBe('Products');
        expect(link('Line Items', 'order')).toMatchObject({ toTable: 'Orders', toColumn: 'name', cardinality: 'many-to-one' });
        expect(link('Orders', 'email')).toMatchObject({ toTable: 'Customers', toColumn: 'email' });
    });

    it('keeps a lookup when a few references are missing, and says how many', () => {
        expect(link('Line Items', 'sku')!.coverage).toBeLessThan(1);
        expect(link('Line Items', 'sku')!.evidence.join(' ')).toMatch(/1 Line Items row refer to a sku that is not in Products/);
        expect(rejected.some(r => r.fromColumn === 'sku' && r.fromTable === 'Line Items')).toBe(false);
    });
});

describe('the joined view and what each table is', () => {
    const tables = shopWorkbook();
    const catalog = buildRelationalCatalog(tables);
    const kind = (table: string) => catalog.subjects.find(s => s.table === table)?.kind;

    it('tells facts from lookups by what they hold, not by column names', () => {
        expect(kind('Line Items')).toBe('fact');
        expect(kind('Orders')).toBe('fact');
        expect(kind('Products')).toBe('dimension'); // a price per item does not make it a fact
        expect(kind('Customers')).toBe('dimension');
    });

    it('opens the finest-grained fact first: the order lines', () => {
        expect(defaultSubjectTable(tables, catalog)).toBe('Line Items');
    });

    it('brings each order\'s date and customer onto its lines, but never its total', () => {
        const view = materializeSubject(tables, catalog, 'Line Items');
        const names = view.columns.map(c => c.name);
        expect(view.rows).toHaveLength(tables.find(t => t.name === 'Line Items')!.rows.length);
        expect(names).toContain('order → Orders.created_at');
        expect(names).toContain('order → Orders / email → Customers.city');
        expect(names).toContain('sku → Products.title');
        expect(names.some(n => /Orders\.(total|shipping)$/.test(n))).toBe(false);
        expect(names).not.toContain('sku → Products.sku'); // the key just matched adds nothing
        expect(view.timeContext?.anchorDateColumn).toBe('order → Orders.created_at');
    });
});

describe('what the AI is told about the other sheets', () => {
    const tables = shopWorkbook();
    const catalog = buildRelationalCatalog(tables);
    const view = materializeSubject(tables, catalog, 'Line Items');
    const dataset: any = { id: 'w', name: 'shop.xlsx', rows: view.rows, columns: view.columns, timeContext: view.timeContext, sourceTables: tables, relationalCatalog: catalog, subjectTable: 'Line Items', sourceSchema: catalog.schema };
    const schema = describeData(dataset).schema;

    it('names every table the way the database does, with what one row is and how they link', () => {
        expect(duckTableName('Line Items')).toBe('line_items');
        expect(duckTableName('Data')).toBe('data_table');
        expect(schema).toMatch(/"orders" \(one row per "name"\)/);
        expect(schema).toMatch(/"products" \(one row per "sku"\)/);
        expect(schema).toMatch(/"line_items"\."order" = "orders"\."name"/);
        expect(schema).toMatch(/"data" is "line_items" with the details it points to already joined in/);
        expect(schema).toMatch(/Never SUM a column after joining it to a table that has several rows for each of its rows/);
    });

    it('does not mistake a looked-up yes/no for the result being tracked', () => {
        expect(schema).not.toMatch(/The result being tracked/);
    });
});

describe('the answer check follows joins', () => {
    const tables = shopWorkbook();
    const catalog = buildRelationalCatalog(tables);
    const view = materializeSubject(tables, catalog, 'Line Items');
    const named = tablesByDuckName({ sourceTables: tables })!;
    const orders = named.orders;
    const customers = named.customers;
    const cityOf = new Map(customers.map(c => [c.email, c.city]));

    it('checks a join between two sheets, and catches a wrong figure', () => {
        const counts = new Map<string, number>();
        for (const o of orders) if (cityOf.has(o.email)) counts.set(cityOf.get(o.email), (counts.get(cityOf.get(o.email)) || 0) + 1);
        const rows = [...counts].map(([city, n]) => ({ city, orders: n }));
        const sql = 'SELECT c."city", COUNT(DISTINCT o."name") AS orders FROM "orders" o JOIN "customers" c ON o."email" = c."email" GROUP BY 1';
        expect(checkAnswer({ sql, rows, data: view.rows, tables: named }).status).toBe('verified');
        expect(checkAnswer({ sql, rows: rows.map((r, i) => (i ? r : { ...r, orders: r.orders + 2 })), data: view.rows, tables: named }).status).toBe('mismatch');
    });

    it('checks a LEFT JOIN that finds what has no match', () => {
        const ordered = new Set(orders.map(o => o.email));
        const never = customers.filter(c => !ordered.has(c.email)).length;
        const sql = 'SELECT COUNT(*) AS customers FROM "customers" c LEFT JOIN "orders" o ON o."email" = c."email" WHERE o."name" IS NULL';
        expect(checkAnswer({ sql, rows: [{ customers: never }], data: view.rows, tables: named }).status).toBe('verified');
    });

    it('warns when a join repeats an order\'s total on each of its lines', () => {
        const totalOf = new Map(orders.map(o => [o.name, o.total]));
        const inflated = named.line_items.reduce((t, l) => t + (totalOf.get(l.order) || 0), 0);
        const check = checkAnswer({ sql: 'SELECT ROUND(SUM(o."total"), 2) AS revenue FROM "line_items" l JOIN "orders" o ON l."order" = o."name"', rows: [{ revenue: Math.round(inflated * 100) / 100 }], data: view.rows, tables: named });
        expect(check.status).toBe('warning');
        expect(check.headline).toMatch(/^Likely too high: total from orders is added up after joining it to line items/);
        // A line's quantity times the product's price is fine: the lines are not repeated.
        const fine = named.line_items.reduce((t, l) => t + l.quantity * (named.products.find(p => p.sku === l.sku)?.price ?? 0), 0);
        expect(checkAnswer({ sql: 'SELECT SUM(l."quantity" * p."price") AS v FROM "line_items" l JOIN "products" p ON l."sku" = p."sku"', rows: [{ v: fine }], data: view.rows, tables: named }).status).toBe('verified');
    });
});
