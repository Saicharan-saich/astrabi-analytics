/** Targets and budgets: the right budget column, and how each bar stands against it. */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { budgetColumnFor, secondaryKeyFor, standAgainst, targetFor } from '../utils/targets';
import { AnalysisType, TimeGrain } from '../types';

const rows = Array.from({ length: 6 }, (_, m) => Array.from({ length: 10 }, (_, i) => ({
    'Order Date': `2026-0${m + 1}-${String(i + 1).padStart(2, '0')}`, Region: ['North', 'South'][i % 2],
    Revenue: 100 + m * 10, 'Revenue Budget': 120, Cost: 50, 'Cost Plan': 55,
}))).flat();
const etl = runETLPipeline(rows, 'Plan.csv');
const ds: any = { id: 'p', name: 'Plan.csv', rows: etl.rows, columns: etl.columns, timeContext: etl.timeContext };
const run = (config: any) => runAnalysis(ds, { questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time', filters: {}, asOfDate: '2026-06-30', ...config } as any);

describe('targets and budgets', () => {
    it('finds the budget that goes with the measure', () => {
        expect(budgetColumnFor(ds, 'revenue')).toBe('revenue_budget');
        expect(budgetColumnFor(ds, 'cost')).toBe('cost_plan');
        expect(budgetColumnFor(ds, 'revenue_budget')).toBeNull();
        expect(budgetColumnFor({ columns: [{ name: 'revenue', type: 'METRIC' }] } as any, 'revenue')).toBeNull();
    });
    it('says how each month stands against a typed target', async () => {
        const result = await run({ metric: 'revenue', aggregation: 'SUM', dimension: 'month', sort: 'oldest' });
        // Monthly revenue: 1000, 1100 … 1500 against a target of 1250.
        const s = standAgainst(result, 1250)!;
        expect(s).toMatchObject({ ahead: 3, behind: 3, total: 6 });
        expect(s.worst).toMatchObject({ key: '2026-01', gap: -250 });
        expect(s.worst!.pct).toBeCloseTo(-0.2, 6);
    });
    it('and against the budget column, row by row', async () => {
        const result = await run({ metric: 'revenue', aggregation: 'SUM', dimension: 'month', sort: 'oldest', secondaryMetrics: ['revenue_budget'], axisMode: 'auto', secondaryMetricVisuals: { revenue_budget: 'line' }, secondaryMetricAggregations: {} });
        const key = secondaryKeyFor(result, 'revenue_budget')!;
        expect(key).toBeTruthy();
        const s = standAgainst(result, key)!;
        // Budget 1200 a month: revenue meets it in March (1200) and beats it after.
        expect(s).toMatchObject({ ahead: 4, behind: 2, total: 6 });
    });
    it('a target belongs to one measure', () => {
        const t = { value: 10, label: 'Target', metric: 'revenue' };
        expect(targetFor(t, { metric: 'revenue' })).toBe(t);
        expect(targetFor(t, { metric: 'cost' })).toBeNull();
    });
});
