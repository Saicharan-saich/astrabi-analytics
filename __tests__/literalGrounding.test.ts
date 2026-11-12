/**
 * Run against the real AI (12 Nov 2026, 77 owner questions), three of the five
 * wrong answers had one cause: the AI cannot see the values in the data, so
 * it guessed how the file writes "takeaway", "greeting cards" and "UK", and
 * a guess that matches nothing gave 0%, a blank and 100% with no warning.
 * The queries below are the ones the live AI wrote.
 */
import { describe, it, expect } from 'vitest';
import { groundValues, groundingNote, groundingQuestion, sameValues } from '../services/ai-sql/literalGrounding';
import { weightedAverages } from '../services/ai-sql/numberChecks';
import { ColumnType, type Dataset } from '../types';

const D = ColumnType.DIMENSION, M = ColumnType.METRIC, T = ColumnType.DATE;
const cafe = {
    columns: [{ name: 'date', type: T }, { name: 'item', type: D }, { name: 'dining_option', type: D }, { name: 'qty', type: M }, { name: 'net_sales', type: M }, { name: 'gross_sales', type: M }],
    rows: Array.from({ length: 60 }, (_, i) => ({ date: '2026-10-01', item: ['Latte', 'Oat Milk Latte', 'Croissant'][i % 3], dining_option: i % 3 ? 'To Go' : 'For Here', qty: 1 + (i % 4), net_sales: 3.5 * (1 + (i % 4)), gross_sales: 3.5 * (1 + (i % 4)) })),
} as unknown as Dataset;
const shop = {
    columns: [{ name: 'date', type: T }, { name: 'product', type: D }, { name: 'qty', type: M }],
    rows: Array.from({ length: 40 }, (_, i) => ({ date: '2026-10-05', product: ['Greeting Card', 'Gift Wrap', 'Scented Candle', 'Mug'][i % 4], qty: 2 })),
} as unknown as Dataset;
const orders = {
    columns: [{ name: 'name', type: ColumnType.ID }, { name: 'billing_country', type: D }],
    rows: Array.from({ length: 50 }, (_, i) => ({ name: `#${1000 + i}`, billing_country: ['GB', 'GB', 'US', 'FR', 'DE'][i % 5] })),
} as unknown as Dataset;

describe('a value the AI guessed is checked against the column it filters', () => {
    it('"greeting cards" is corrected to Greeting Card, as the file writes it', () => {
        const live = `SELECT SUM("qty") AS total_qty FROM "data" WHERE "product" ILIKE '%greeting cards%' AND EXTRACT(MONTH FROM CAST("date" AS DATE)) = 10`;
        const g = groundValues(live, shop);
        expect(g.sql).toBe(`SELECT SUM("qty") AS total_qty FROM "data" WHERE "product" ILIKE '%Greeting Card%' AND EXTRACT(MONTH FROM CAST("date" AS DATE)) = 10`);
        expect(g.unknown).toEqual([]);
        expect(groundingNote(g.corrected)).toBe('"greeting cards" was read as Greeting Card, as your product column writes it.');
    });

    it('"UK" is corrected to GB, the way this file writes the country', () => {
        const live = `SELECT ROUND(100.0 * COUNT_IF(LOWER(billing_country) <> LOWER('UK') AND billing_country IS NOT NULL) / NULLIF(COUNT(*), 0), 1) AS outside_uk_order_share_pct FROM order_countries`;
        const g = groundValues(live, orders);
        expect(g.sql).toContain(`LOWER(billing_country) <> LOWER('GB')`);
        expect(g.corrected).toEqual([{ column: 'billing_country', asked: 'UK', used: 'GB' }]);
    });

    it('"takeaway" is read as To Go; the same word with two possible values is put to the person', () => {
        const live = `SELECT SUM(CASE WHEN "dining_option" ILIKE '%takeaway%' THEN "net_sales" ELSE 0 END) AS takeaway_net_sales FROM "data"`;
        const g = groundValues(live, cafe);
        expect(g.sql).toContain(`"dining_option" ILIKE '%To Go%'`);
        const two = { ...cafe, rows: cafe.rows.map((r: any, i: number) => ({ ...r, dining_option: ['To Go', 'Pickup', 'For Here'][i % 3] })) } as Dataset;
        const asked = groundValues(live, two);
        expect(asked.sql).toBe(live);
        expect(asked.unknown[0].choices.sort()).toEqual(['Pickup', 'To Go']);
        const q = groundingQuestion('What percentage of our sales are takeaway?', asked.unknown[0]);
        expect(q.question).toBe('Nothing in your dining option column is called "takeaway". Which did you mean?');
        expect(q.options.map(o => o.question)).toContain('What percentage of our sales are takeaway (where dining option is "To Go")');
    });

    it('a word that matches nothing in a short list is put to the person with the real values', () => {
        const g = groundValues(`SELECT COUNT(*) AS n FROM "data" WHERE LOWER("dining_option") = LOWER('drive through')`, cafe);
        expect(g.unknown).toEqual([{ column: 'dining_option', asked: 'drive through', choices: ['To Go', 'For Here'] }]);
    });

    it('leaves alone values that are there, numbers, dates, IDs, and long lists with nothing alike', () => {
        const fine = `SELECT SUM("qty") FROM "data" WHERE "item" ILIKE '%latte%' AND "dining_option" = 'To Go' AND CAST("date" AS DATE) >= DATE '2026-10-01'`;
        expect(groundValues(fine, cafe)).toEqual({ sql: fine, corrected: [], unknown: [] });
        const ids = `SELECT COUNT(*) FROM "data" WHERE "name" = '#9999'`;
        expect(groundValues(ids, orders).sql).toBe(ids);
        const many = { columns: [{ name: 'customer', type: D }], rows: Array.from({ length: 200 }, (_, i) => ({ customer: `Customer ${i}` })) } as unknown as Dataset;
        const stranger = `SELECT COUNT(*) FROM "data" WHERE "customer" = 'Zebra Holdings'`;
        expect(groundValues(stranger, many)).toEqual({ sql: stranger, corrected: [], unknown: [] });
    });

    it('matches plurals, case, punctuation, countries and slips of the keyboard, and nothing else', () => {
        expect(sameValues('greeting cards', ['Greeting Card', 'Mug'])).toEqual(['Greeting Card']);
        expect(sameValues('united kingdom', ['GB', 'US'])).toEqual(['GB']);
        expect(sameValues('Marketting', ['Marketing', 'Finance'])).toEqual(['Marketing']);
        expect(sameValues('take-out', ['To Go', 'For Here'])).toEqual(['To Go']);
        expect(sameValues('latte', ['Latte', 'Oat Milk Latte'])).toEqual(['Latte']);
        expect(sameValues('wholesale', ['To Go', 'For Here'])).toEqual([]);
    });
});

describe('an average price is total sales over total quantity', () => {
    it('rewrites the query the live AI wrote, and says so', () => {
        const live = `SELECT ROUND(AVG("gross_sales" / NULLIF("qty", 0)), 2) AS average_price, COUNT(*) AS group_size FROM "data" WHERE "item" ILIKE '%latte%' AND "qty" <> 0`;
        const { sql, note } = weightedAverages(live, cafe.columns);
        expect(sql).toBe(`SELECT ROUND(SUM("gross_sales") / NULLIF(SUM("qty"), 0), 2) AS average_price, COUNT(*) AS group_size FROM "data" WHERE "item" ILIKE '%latte%' AND "qty" <> 0`);
        expect(note).toMatch(/total gross sales divided by total qty/);
        const plain = 'SELECT AVG("net_sales") AS a FROM "data"';
        expect(weightedAverages(plain, cafe.columns)).toEqual({ sql: plain, note: null });
    });
});
