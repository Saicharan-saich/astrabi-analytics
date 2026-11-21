import { describe, expect, it } from 'vitest';
import { applySteps, columnNameFor, columnsOfStep, describeStep, newStep, stepProblem, STEP_GROUPS } from '../services/cleaningSteps';
import { runETLPipeline } from '../services/etlPipeline';
import { ColumnType, type CleaningStep, type ColumnDefinition } from '../types';

const col = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: 'x' });
const columns = [
    col('order_id', ColumnType.ID), col('order_date', ColumnType.DATE), col('region', ColumnType.DIMENSION),
    col('customer', ColumnType.DIMENSION), col('revenue', ColumnType.METRIC), col('cost', ColumnType.METRIC),
];
const rows = [
    { order_id: 'A1', order_date: '2026-01-05', region: 'North', customer: '  acme  ltd ', revenue: 100, cost: 60 },
    { order_id: 'A2', order_date: '2026-02-14', region: 'Unknown', customer: 'Beta Ltd.', revenue: 250, cost: null },
    { order_id: 'A3', order_date: '2026-02-20', region: 'N. West', customer: 'Gamma', revenue: null, cost: 10 },
    { order_id: 'A3', order_date: '2026-02-20', region: 'N. West', customer: 'Gamma', revenue: null, cost: 10 },
    { order_id: 'A4', order_date: '2026-03-01', region: 'NW', customer: 'TEST ORDER', revenue: 5, cost: 1 },
];
const step = (kind: CleaningStep['kind'], extra: Partial<CleaningStep>): CleaningStep => ({ id: kind, kind, ...extra });
const run = (s: CleaningStep) => applySteps(rows, columns, [s]);

describe('cleaning steps', () => {
    it('removes or keeps rows by a condition, treating "Unknown" categories as blank', () => {
        const blank = run(step('filter_rows', { column: 'region', op: 'blank', action: 'remove' }));
        expect(blank.rows.map(r => r.order_id)).toEqual(['A1', 'A3', 'A3', 'A4']);
        expect(blank.results[0].text).toBe('1 row removed');
        expect(run(step('filter_rows', { column: 'customer', op: 'contains', value: 'test', action: 'remove' })).rows).toHaveLength(4);
        expect(run(step('filter_rows', { column: 'revenue', op: 'greater', value: '50', action: 'keep' })).rows.map(r => r.order_id)).toEqual(['A1', 'A2']);
        expect(run(step('filter_rows', { column: 'order_date', op: 'between', value: '2026-02-01', value2: '2026-02-28', action: 'keep' })).rows).toHaveLength(3);
        expect(run(step('filter_rows', { column: 'region', op: 'one_of', value: 'nw, n. west', action: 'remove' })).rows).toHaveLength(2);
        expect(describeStep(step('filter_rows', { column: 'region', op: 'blank', action: 'remove' }))).toBe("Remove rows where 'region' is blank");
    });

    it('removes repeated rows and keeps the chosen copy', () => {
        const out = run(step('remove_duplicates', { columns: [], keepCopy: 'first' }));
        expect(out.rows).toHaveLength(4);
        expect(out.results[0].text).toBe('1 repeated row removed');
        expect(run(step('remove_duplicates', { columns: ['region'], keepCopy: 'last' })).rows.map(r => r.order_id)).toEqual(['A1', 'A2', 'A3', 'A4']);
    });

    it('removes, keeps and renames columns, with tidy unique names', () => {
        expect(run(step('remove_columns', { columns: ['cost'] })).columns.map(c => c.name)).not.toContain('cost');
        expect(Object.keys(run(step('keep_columns', { columns: ['region', 'revenue'] })).rows[0])).toEqual(['region', 'revenue']);
        const renamed = run(step('rename_column', { column: 'customer', to: 'Client Name' }));
        expect(renamed.rows[0].client_name).toBe('  acme  ltd ');
        expect(renamed.columns.find(c => c.name === 'client_name')?.type).toBe(ColumnType.DIMENSION);
        expect(columnNameFor('Revenue', columns)).toBe('revenue_2');
    });

    it('changes what a column is, reporting values it cannot read', () => {
        const out = run(step('change_type', { column: 'customer', to: ColumnType.METRIC }));
        expect(out.columns.find(c => c.name === 'customer')?.type).toBe(ColumnType.METRIC);
        expect(out.results[0].text).toMatch(/5 values could not be read and became blank/);
    });

    it('fills blanks in every way offered', () => {
        expect(run(step('fill_blanks', { column: 'cost', fill: 'zero' })).rows.map(r => r.cost)).toEqual([60, 0, 10, 10, 1]);
        expect(run(step('fill_blanks', { column: 'revenue', fill: 'down' })).rows.map(r => r.revenue)).toEqual([100, 250, 250, 250, 5]);
        expect(run(step('fill_blanks', { column: 'revenue', fill: 'median' })).rows.map(r => r.revenue)).toEqual([100, 250, 100, 100, 5]);
        expect(run(step('fill_blanks', { column: 'region', fill: 'value', value: 'Online' })).rows[1].region).toBe('Online');
        expect(run(step('fill_blanks', { column: 'region', fill: 'most_common' })).rows[1].region).toBe('N. West');
    });

    it('finds and replaces, groups values and tidies text', () => {
        expect(run(step('find_replace', { column: 'customer', find: 'ltd.', replace: 'Ltd' })).rows[1].customer).toBe('Beta Ltd');
        const grouped = run(step('group_values', { column: 'region', groups: [{ from: ['N. West', 'NW'], to: 'North West' }] }));
        expect(grouped.rows.map(r => r.region)).toEqual(['North', 'Unknown', 'North West', 'North West', 'North West']);
        expect(grouped.results[0].text).toBe('3 cells grouped');
        expect(run(step('tidy_text', { columns: ['customer'], textCase: 'title' })).rows[0].customer).toBe('Acme Ltd');
        expect(run(step('round_numbers', { column: 'revenue', decimals: 0 })).results[0].text).toBe('Already rounded');
    });

    it('splits and joins columns', () => {
        const split = applySteps([{ name: 'Smith, John' }, { name: 'Lee' }], [col('name', ColumnType.DIMENSION)], [step('split_column', { column: 'name', separator: ',', names: ['Last', 'First'] })]);
        expect(split.rows).toEqual([{ last: 'Smith', first: 'John' }, { last: 'Lee', first: null }]);
        const joined = run(step('join_columns', { columns: ['region', 'customer'], separator: ' / ', name: 'Region Customer' }));
        expect(joined.rows[1].region_customer).toBe('Beta Ltd.');
        expect(joined.rows[0].region_customer).toBe('North /   acme  ltd ');
    });

    it('calculates columns and takes parts of dates', () => {
        const profit = run(step('calculated_column', { column: 'revenue', operator: '-', rightColumn: 'cost', name: 'Profit' }));
        expect(profit.rows.map(r => r.profit)).toEqual([40, null, null, null, 4]);
        expect(profit.columns.at(-1)).toMatchObject({ name: 'profit', type: ColumnType.METRIC });
        expect(profit.results[0].text).toMatch(/3 rows left blank/);
        expect(run(step('calculated_column', { column: 'cost', operator: 'pct_of', rightColumn: 'revenue', name: 'cost share' })).rows[0].cost_share).toBe(60);
        const month = run(step('date_part', { column: 'order_date', part: 'month_name', name: 'Month' }));
        expect(month.rows.map(r => r.month)).toEqual(['January', 'February', 'February', 'February', 'March']);
        expect(run(step('date_part', { column: 'order_date', part: 'quarter', name: 'q' })).rows[0].q).toBe('2026 Q1');
        expect(run(step('date_part', { column: 'order_date', part: 'weekday', name: 'w' })).rows[0].w).toBe('Monday');
        expect(run(step('date_part', { column: 'order_date', part: 'week', name: 'wk' })).rows[0].wk).toBe('2026-W02');
    });

    it('reshapes: columns into rows, and group and total', () => {
        const wide = [{ shop: 'A', jan: 1, feb: 2 }, { shop: 'B', jan: 3, feb: 4 }];
        const long = applySteps(wide, [col('shop', ColumnType.DIMENSION), col('jan', ColumnType.METRIC), col('feb', ColumnType.METRIC)], [step('unpivot', { columns: ['jan', 'feb'], to: 'Month', name: 'Sales' })]);
        expect(long.rows).toEqual([{ shop: 'A', month: 'jan', sales: 1 }, { shop: 'A', month: 'feb', sales: 2 }, { shop: 'B', month: 'jan', sales: 3 }, { shop: 'B', month: 'feb', sales: 4 }]);
        expect(long.columns.map(c => `${c.name}:${c.type}`)).toEqual(['shop:DIMENSION', 'month:DIMENSION', 'sales:METRIC']);
        const totals = run(step('group_by', { groupBy: ['region'], totals: [{ column: 'revenue', how: 'sum', name: 'Revenue' }, { column: 'order_id', how: 'count', name: 'Orders' }] }));
        expect(totals.rows).toEqual([
            { region: 'North', revenue: 100, orders: 1 }, { region: 'Unknown', revenue: 250, orders: 1 },
            { region: 'N. West', revenue: 0, orders: 2 }, { region: 'NW', revenue: 5, orders: 1 },
        ]);
    });

    it('runs steps in order, skips switched-off steps, and skips with a reason when a column is missing', () => {
        const steps: CleaningStep[] = [
            step('rename_column', { id: 'a', column: 'customer', to: 'client' }),
            step('fill_blanks', { id: 'b', column: 'customer', fill: 'value', value: 'x' }),
            step('remove_columns', { id: 'c', columns: ['cost'], off: true }),
            step('filter_rows', { id: 'd', column: 'client', op: 'contains', value: 'test', action: 'remove', note: 'Test orders from the client\'s QA team' }),
        ];
        const out = applySteps(rows, columns, steps);
        expect(out.results.map(r => r.status)).toEqual(['ran', 'skipped', 'off', 'ran']);
        expect(out.results[1].text).toBe("Skipped: this file has no column 'customer'");
        expect(out.columns.map(c => c.name)).toContain('cost');
        expect(out.rows).toHaveLength(4);
        expect(out.logs.map(l => l.status)).toEqual(['applied', 'info', 'applied']);
        expect(out.logs[2].reason).toBe("Test orders from the client's QA team");
        expect(out.logs[2].details).toBe(`Step 4, "Remove rows where 'client' contains 'test'": 1 row removed.`);
    });

    it('offers every kind, each with defaults and a clear "what is missing"', () => {
        const kinds = STEP_GROUPS.flatMap(g => g.kinds.map(k => k.kind));
        expect(kinds).toHaveLength(19);
        for (const kind of kinds) {
            const fresh = newStep(kind, columns);
            expect(typeof describeStep(fresh)).toBe('string');
            expect(typeof stepProblem(fresh)).toBe('string');
        }
        expect(stepProblem(newStep('rename_column', columns))).toBe('Type the new name');
        expect(stepProblem({ ...newStep('rename_column', columns), to: 'x' })).toBe('');
        expect(columnsOfStep(step('calculated_column', { column: 'a', rightColumn: 'b' }))).toEqual(['a', 'b']);
    });

    it('runs inside every clean, after the automatic cleaning, and keeps the table before the steps for previews', () => {
        const raw = [
            { 'Order ID': 'A1', Region: 'North', Revenue: '100', Cost: '60' },
            { 'Order ID': 'A2', Region: '', Revenue: '250', Cost: '' },
            { 'Order ID': 'A3', Region: 'South', Revenue: '75', Cost: '20' },
        ];
        const result = runETLPipeline(raw, 'x.csv', undefined, { manualSteps: [
            step('calculated_column', { id: 'p', column: 'revenue', operator: '-', rightColumn: 'cost', name: 'Profit' }),
            step('filter_rows', { id: 'f', column: 'region', op: 'blank', action: 'remove' }),
        ] });
        expect(result.rows.map(r => r.profit)).toEqual([40, 55]);
        expect(result.columns.find(c => c.name === 'profit')?.type).toBe(ColumnType.METRIC);
        expect(result.stepBase?.rows).toHaveLength(3);
        expect(result.stepBase?.columns.map(c => c.name)).not.toContain('profit');
        expect(result.logs.filter(l => l.step === 'Your Step')).toHaveLength(2);
        expect(runETLPipeline(raw, 'x.csv').stepBase).toBeUndefined();
    });
});
