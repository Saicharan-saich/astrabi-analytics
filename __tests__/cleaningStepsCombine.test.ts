import { describe, expect, it } from 'vitest';
import { applySteps, columnsOfStep, describeStep, findStepTable, newStep, sourceOf, stepProblem, STEP_GROUPS, type StepTable } from '../services/cleaningSteps';
import { runETLPipeline } from '../services/etlPipeline';
import { tablesForSteps } from '../utils/stepTables';
import { ColumnType, type CleaningStep, type ColumnDefinition, type Dataset } from '../types';

const col = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: 'x' });
const step = (kind: CleaningStep['kind'], extra: Partial<CleaningStep>): CleaningStep => ({ id: kind, kind, ...extra });

// A long table: one row per store and month.
const longCols = [col('store', ColumnType.DIMENSION), col('month', ColumnType.DIMENSION), col('sales', ColumnType.METRIC)];
const longRows = [
    { store: 'Leeds', month: 'Jan', sales: 100 }, { store: 'Leeds', month: 'Feb', sales: 120 },
    { store: 'Leeds', month: 'Feb', sales: 5 }, { store: 'York', month: 'Jan', sales: 80 },
    { store: 'York', month: 'Mar', sales: '1,000' }, { store: 'Hull', month: null, sales: 7 },
];

describe('turn rows into columns (pivot)', () => {
    it('makes one column per value, one row per remaining combination, and keeps the grand total', () => {
        const out = applySteps(longRows, longCols, [step('pivot', { column: 'month', valueColumn: 'sales', how: 'sum' })]);
        expect(out.columns.map(c => [c.name, c.type])).toEqual([
            ['store', ColumnType.DIMENSION], ['jan', ColumnType.METRIC], ['feb', ColumnType.METRIC], ['mar', ColumnType.METRIC], ['blank', ColumnType.METRIC],
        ]);
        expect(out.rows).toEqual([
            { store: 'Leeds', jan: 100, feb: 125, mar: null, blank: null },
            { store: 'York', jan: 80, feb: null, mar: 1000, blank: null },
            { store: 'Hull', jan: null, feb: null, mar: null, blank: 7 },
        ]);
        const total = (rows: Record<string, any>[], keys: string[]) => rows.reduce((s, r) => s + keys.reduce((t, k) => t + (r[k] || 0), 0), 0);
        expect(total(out.rows, ['jan', 'feb', 'mar', 'blank'])).toBe(1312);
        expect(out.results[0].text).toBe("6 rows turned into 3 rows with 4 new columns ('jan', 'feb', 'mar', 'blank')");
        expect(describeStep(step('pivot', { column: 'month', valueColumn: 'sales', how: 'sum' }))).toBe("Turn the values of 'month' into columns, filled with the total of 'sales'");
    });

    it('can count rows or take the first value, and refuses too many columns', () => {
        const counted = applySteps(longRows, longCols, [step('pivot', { column: 'month', valueColumn: 'sales', how: 'count' })]);
        expect(counted.rows[0]).toEqual({ store: 'Leeds', jan: 1, feb: 2, mar: null, blank: null });
        expect(columnsOfStep(step('pivot', { column: 'month', how: 'count', valueColumn: 'sales' }))).toEqual(['sales', 'month']);
        const first = applySteps(longRows, longCols, [step('pivot', { column: 'store', valueColumn: 'month', how: 'first' })]);
        expect(first.columns.find(c => c.name === 'leeds')?.type).toBe(ColumnType.DIMENSION);
        const many = Array.from({ length: 120 }, (_, i) => ({ store: 'A', month: `m${i}`, sales: 1 }));
        const refused = applySteps(many, longCols, [step('pivot', { column: 'month', valueColumn: 'sales', how: 'sum' })]);
        expect(refused.rows).toBe(many);
        expect(refused.results[0].status).toBe('skipped');
        expect(refused.results[0].text).toMatch(/'month' has more than 100 different values/);
        expect(stepProblem(step('pivot', { column: 'sales', valueColumn: 'sales', how: 'sum' }))).toBe('Pick two different columns');
    });
});

// Orders this month, plus two other files in the workspace.
const orderCols = [col('order_id', ColumnType.ID), col('store_code', ColumnType.DIMENSION), col('revenue', ColumnType.METRIC)];
const orders = [
    { order_id: 'A1', store_code: 'LDS', revenue: 100 }, { order_id: 'A2', store_code: 'yrk ', revenue: 50 },
    { order_id: 'A3', store_code: 'XXX', revenue: 10 },
];
const stores: StepTable = {
    name: 'Store list.xlsx',
    columns: [col('code', ColumnType.DIMENSION), col('store_name', ColumnType.DIMENSION), col('region', ColumnType.DIMENSION)],
    rows: [
        { code: 'LDS', store_name: 'Leeds', region: 'North' }, { code: 'YRK', store_name: 'York', region: 'North' },
        { code: 'LDS', store_name: 'Leeds (old)', region: 'North' },
    ],
};
const lastMonth: StepTable = {
    name: 'orders_october.csv',
    columns: [col('Order ID', ColumnType.ID), col('store_code', ColumnType.DIMENSION), col('revenue', ColumnType.METRIC), col('channel', ColumnType.DIMENSION)],
    rows: [{ 'Order ID': 'Z9', store_code: 'LDS', revenue: '1,200.50', channel: 'web' }],
};

describe('combine with another file', () => {
    it('brings columns across by a matching column without ever doubling a row', () => {
        const s = step('combine', { mode: 'match', source: sourceOf(stores), column: 'store_code', rightColumn: 'code', columns: ['store_name', 'region'] });
        const out = applySteps(orders, orderCols, [s], { tables: [stores] });
        expect(out.rows).toEqual([
            { order_id: 'A1', store_code: 'LDS', revenue: 100, store_name: 'Leeds', region: 'North' },
            { order_id: 'A2', store_code: 'yrk ', revenue: 50, store_name: 'York', region: 'North' },
            { order_id: 'A3', store_code: 'XXX', revenue: 10, store_name: null, region: null },
        ]);
        expect(out.rows.reduce((t, r) => t + r.revenue, 0)).toBe(160);
        expect(out.results[0].text).toBe("2 columns brought from 'Store list'; 2 of 3 rows found a match, 1 did not (left blank). 'Store list' repeats 1 key; the first row for each is used, so no rows are doubled");
        expect(describeStep(s)).toBe("Bring 'store name', 'region' from 'Store list', matching 'store code' to 'code'");
        expect(columnsOfStep(s)).toEqual(['store_code']);
    });

    it('adds another file\'s rows underneath, lining columns up by name', () => {
        const s = step('combine', { mode: 'append', source: sourceOf(lastMonth), name: 'Source' });
        const out = applySteps(orders, orderCols, [s], { tables: [lastMonth], fileName: 'orders_november.csv' });
        expect(out.columns.map(c => c.name)).toEqual(['order_id', 'store_code', 'revenue', 'channel', 'source']);
        expect(out.rows.at(-1)).toEqual({ order_id: 'Z9', store_code: 'LDS', revenue: 1200.5, channel: 'web', source: 'orders_october' });
        expect(out.rows[0]).toMatchObject({ channel: null, source: 'orders_november' });
        expect(out.results[0].text).toBe("1 row added from 'orders_october'; 4 rows now. 1 column only in 'orders_october' ('channel'), blank for this file's rows");
    });

    it('skips, and says so, when the other file is not loaded or lacks its key', () => {
        const s = step('combine', { mode: 'match', source: sourceOf(stores), column: 'store_code', rightColumn: 'code' });
        const gone = applySteps(orders, orderCols, [s], { tables: [] });
        expect(gone.rows).toBe(orders);
        expect(gone.results[0].text).toBe("Skipped: the file 'Store list' is not loaded. Upload it too, then clean again");
        expect(gone.logs[0]).toMatchObject({ step: 'Your Step', status: 'info' });
        const noKey = applySteps(orders, orderCols, [{ ...s, rightColumn: 'shop' }], { tables: [stores] });
        expect(noKey.results[0].text).toBe("Skipped: the file 'Store list' has no column 'shop'");
    });

    it('finds next month\'s copy of the other file by its columns, and records only names', () => {
        const renamed = { ...stores, name: 'stores_v2.csv', columns: [...stores.columns, col('manager', ColumnType.DIMENSION)] };
        expect(findStepTable(sourceOf(stores), [lastMonth, renamed])?.name).toBe('stores_v2.csv');
        expect(findStepTable(sourceOf(stores), [lastMonth])).toBeNull();
        expect(findStepTable({ name: 'store LIST.csv', headers: [] }, [stores])?.name).toBe('Store list.xlsx');
        expect(JSON.stringify(sourceOf(stores))).not.toContain('Leeds');
        expect(stepProblem(newStep('combine', orderCols))).toBe('Pick the other file');
        expect(STEP_GROUPS.flatMap(g => g.kinds.map(k => k.kind))).toEqual(expect.arrayContaining(['pivot', 'combine']));
    });

    it('sends only the files the steps name, never the one being cleaned', () => {
        const ds = (id: string, t: StepTable) => ({ id, name: t.name, rows: t.rows, columns: t.columns }) as unknown as Dataset;
        const all = [ds('1', stores), ds('2', lastMonth), ds('3', { ...stores, name: 'orders_november.csv' })];
        const s = step('combine', { mode: 'match', source: sourceOf(stores), column: 'store_code', rightColumn: 'code' });
        expect(tablesForSteps([s], all, '3')?.map(t => t.name)).toEqual(['Store list.xlsx']);
        expect(tablesForSteps([{ ...s, off: true }], all)).toBeUndefined();
        expect(tablesForSteps([], all)).toBeUndefined();
    });

    it('runs inside the whole cleaning when the other file is passed in', () => {
        const raw = [
            { 'Order ID': 'A1', 'Store Code': 'LDS', Revenue: '100' }, { 'Order ID': 'A2', 'Store Code': 'YRK', Revenue: '50' },
            { 'Order ID': 'A3', 'Store Code': 'LDS', Revenue: '25' },
        ];
        const s = step('combine', { mode: 'match', source: sourceOf(stores), column: 'store_code', rightColumn: 'code', columns: ['region'] });
        const result = runETLPipeline(raw, 'orders.csv', undefined, { manualSteps: [s], stepTables: [stores] });
        expect(result.rows.map(r => r.region)).toEqual(['North', 'North', 'North']);
        expect(result.columns.find(c => c.name === 'region')?.type).toBe(ColumnType.DIMENSION);
        expect(result.logs.find(l => l.step === 'Your Step')?.status).toBe('applied');
    });
});
