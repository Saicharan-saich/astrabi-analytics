/**
 * Global filters used to blank charts and emit invalid SQL.
 *
 * A cleared control or cross-filter can pass undefined, which stringifies into
 * the query as the literal 'undefined' — producing
 * `WHERE "month" IN ('undefined')`, matching nothing.
 */
import { describe, it, expect } from 'vitest';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { getDates } from '../services/dateHelpers';

const base = (extra: any) => ({
    metric: 'line_total', dimension: 'category', aggregation: 'SUM',
    timeGrain: 'Raw Date', analysisType: 'Standard', ...extra,
});
const plan = (cfg: any) => buildQueryPlan(cfg as any, 'order_date', getDates('2025-12-30'), 'data');
const rowFilters = (cfg: any) => plan(cfg).filters.row;

describe('filter values that are not real selections', () => {
    it('drops undefined and null instead of emitting IN (\'undefined\')', () => {
        const f = rowFilters(base({ filters: { month: [undefined, null] } }));
        expect(f.find((r: any) => r.column === 'month')).toBeUndefined();
    });

    it('drops the literal strings "undefined" and "null"', () => {
        const f = rowFilters(base({ filters: { month: ['undefined', 'null', ''] } }));
        expect(f.find((r: any) => r.column === 'month')).toBeUndefined();
    });

    it('keeps the real values when a list is partly broken', () => {
        const f = rowFilters(base({ filters: { category: ['Furniture', undefined, 'Office'] } }));
        const cat = f.find((r: any) => r.column === 'category')!;
        expect(cat.value).toEqual(['Furniture', 'Office']);
    });

    it('applies the same guard to exclusions', () => {
        const f = rowFilters(base({ excludeFilters: { category: [undefined] } }));
        expect(f.find((r: any) => r.column === 'category')).toBeUndefined();
    });

    it('leaves a genuine selection untouched', () => {
        const f = rowFilters(base({ filters: { category: ['Accessories', 'Electronics'] } }));
        expect(f.find((r: any) => r.column === 'category')!.value).toEqual(['Accessories', 'Electronics']);
    });
});
