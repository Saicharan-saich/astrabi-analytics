/**
 * Golden files: twelve exports shaped like the ones small businesses really
 * upload (Square, Shopify, Stripe, SumUp, a bank statement, a QuickBooks P&L,
 * a hand-kept takings sheet, a survey, timesheets, inventory, marketing, a
 * wide monthly sheet). For each: what every important column must mean after
 * cleaning, and totals that must match the figures worked out straight from
 * the raw file (scripts/golden-exports/gen.py made the files; the expected
 * totals were added up from the raw CSVs, not from QuickInsight).
 *
 * If cleaning changes and one of these moves, a real export would be read
 * differently — the test says which file and which column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDelimitedText } from '../services/delimitedText';
import { runETLPipeline } from '../services/etlPipeline';
import { describeDatasetShape } from '../services/datasetShape';
import { isPerRowName } from '../utils/numberMeaning';
import { ColumnType } from '../types';

const clean = (file: string) => {
    const parsed = parseDelimitedText(readFileSync(join(process.cwd(), '__tests__', 'golden-exports', file), 'utf8'));
    const result = runETLPipeline(parsed.rows, file);
    const type = (name: string) => result.columns.find(c => c.name === name)?.type;
    const values = (name: string) => result.rows.map(r => r[name]).filter(v => v !== null && v !== undefined && v !== '');
    const sum = (name: string) => Math.round(values(name).reduce((total: number, v: any) => total + Number(v), 0) * 100) / 100;
    const shape = describeDatasetShape({ rows: result.rows, columns: result.columns } as any);
    const steps = (result as any).logs.map((l: any) => l.step) as string[];
    return { result, rows: result.rows, type, values, sum, shape, steps, names: result.columns.map(c => c.name) };
};

describe('golden exports: what each column means and what it adds up to', () => {
    it('Square item sales: time of day is not a duration; discounts are money; names keep "of"', () => {
        const d = clean('square_item_sales.csv');
        expect(d.rows).toHaveLength(400);
        expect(d.type('time')).toBe(ColumnType.DIMENSION);
        expect(d.values('time')[0]).toBe('15:06:00');
        expect(d.type('discounts')).toBe(ColumnType.METRIC);
        expect(d.sum('gross_sales')).toBe(2432.1);
        expect(d.sum('discounts')).toBe(-39.49);
        expect(d.sum('qty')).toBe(605);
        expect(d.values('channel')[0]).toBe('Square Point of Sale');
        expect(d.type('transaction_id')).toBe(ColumnType.ID);
    });

    it('Shopify orders: order details filled down, amounts once per order, no "Unknown"', () => {
        const d = clean('shopify_orders_export.csv');
        expect(d.rows).toHaveLength(251);
        expect(new Set(d.values('name')).size).toBe(150);
        expect(d.sum('total')).toBe(4076.5);
        expect(d.sum('shipping')).toBe(592.5);
        expect(d.sum('lineitem_quantity')).toBe(329);
        expect(d.type('shipping')).toBe(ColumnType.METRIC);
        expect(d.names).not.toContain('shipping_allocated');
        for (const column of ['email', 'financial_status', 'currency', 'billing_city']) {
            expect(d.values(column), column).not.toContain('Unknown');
            expect(d.values(column).length, column).toBe(251);
        }
        expect(d.steps).toContain('Order Details Filled');
    });

    it('Stripe payments: currency codes stay capitals', () => {
        const d = clean('stripe_payments.csv');
        expect(new Set(d.values('currency'))).toEqual(new Set(['GBP']));
        expect(d.sum('amount')).toBe(13740.58);
        expect(d.type('id')).toBe(ColumnType.ID);
    });

    it('SumUp: dotted European dates with a time, decimal commas, semicolons', () => {
        const d = clean('sumup_transactions.csv');
        expect(d.rows).toHaveLength(200);
        expect(d.type('date')).toBe(ColumnType.DATE);
        expect(d.values('date')).toHaveLength(200);
        expect(String(d.values('date')[0])).toMatch(/^2025-05-07T13:35/);
        expect(d.sum('total_amount')).toBe(7547.4);
    });

    it('Bank statement: money in and out add up; the running balance is a snapshot, never a total', () => {
        const d = clean('bank_statement.csv');
        expect(d.sum('paid_out')).toBe(19787.16);
        expect(d.sum('paid_in')).toBe(37299.39);
        expect(isPerRowName('balance')).toBe(true);
        expect(d.values('date')[0]).toBe('2025-01-01');
    });

    it('QuickBooks profit and loss: headings become sections; totals and calculated lines removed', () => {
        const d = clean('quickbooks_profit_and_loss.csv');
        expect(d.names).toEqual(expect.arrayContaining(['section', 'line_item', 'period', 'value']));
        expect(d.names).not.toContain('total');
        expect(d.rows).toHaveLength(20); // 5 lines × 4 months
        const labels = new Set(d.values('line_item'));
        for (const gone of ['Total Income', 'Gross Profit', 'Total Expenses', 'Net Income']) expect(labels.has(gone), gone).toBe(false);
        expect(new Set(d.values('section'))).toEqual(new Set(['Income', 'Cost of Sales', 'Expenses']));
        // The monthly cells of Sales, Other Income, Cost of Goods Sold, Wages and Rent.
        expect(d.sum('value')).toBe(75941.53);
        const income = d.rows.filter(r => r.section === 'Income').reduce((s, r) => s + Number(r.value), 0);
        expect(Math.round(income * 100) / 100).toBe(42533.2); // the file's Total Income
    });

    it('Hand-kept takings: mixed date styles read day-first; the empty Total line goes', () => {
        const d = clean('messy_daily_takings.csv');
        expect(d.rows).toHaveLength(60);
        expect(d.values('date').slice(0, 3)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
        expect(d.sum('takings')).toBe(9838.53);
        expect(new Set(d.values('paid_by'))).toEqual(new Set(['Card', 'Cash']));
    });

    it('Customer survey: the 0–10 score is averaged; comments are left as written', () => {
        const d = clean('customer_survey.csv');
        const score = 'how_likely_are_you_to_recommend_us_0_10';
        expect(d.type(score)).toBe(ColumnType.METRIC);
        expect(isPerRowName(score)).toBe(true);
        expect(Math.round(d.sum(score) / 250 * 1000) / 1000).toBe(5.116);
        expect(d.values('comments')).not.toContain('Unknown');
        expect(d.values('comments')).toHaveLength(250 - 53);
        expect(d.values('comments')).toContain('Queue too long');
        expect(d.shape.label).toBe('Scores and categories');
    });

    it('Timesheets: clock times are times of day; hours worked stay in hours', () => {
        const d = clean('timesheets.csv');
        expect(d.type('clock_in')).toBe(ColumnType.DIMENSION);
        expect(d.type('clock_out')).toBe(ColumnType.DIMENSION);
        expect(d.type('hours_worked')).toBe(ColumnType.METRIC);
        expect(d.sum('hours_worked')).toBe(1005.5);
        expect(isPerRowName('hourly_rate')).toBe(true);
    });

    it('Inventory: stock and reorder level are measured per item', () => {
        const d = clean('inventory.csv');
        expect(d.type('reorder_level')).toBe(ColumnType.METRIC);
        expect(d.type('stock_on_hand')).toBe(ColumnType.METRIC);
        expect(isPerRowName('reorder_level')).toBe(true);
        expect(isPerRowName('stock_on_hand')).toBe(true);
        expect(d.type('sku')).toBe(ColumnType.ID);
    });

    it('Marketing: CTR and CPC are ratios (averaged), clicks and spend add up', () => {
        const d = clean('marketing_campaigns.csv');
        for (const ratio of ['ctr', 'cpc']) expect(isPerRowName(ratio), ratio).toBe(true);
        for (const amount of ['clicks', 'spend', 'impressions', 'conversions']) expect(isPerRowName(amount), amount).toBe(false);
        expect(d.type('ctr')).toBe(ColumnType.METRIC);
    });

    it('Wide monthly sheet: one row per product per month', () => {
        const d = clean('monthly_sales_by_product.csv');
        expect(d.rows).toHaveLength(30);
        expect(d.sum('value')).toBe(15384);
    });
});
