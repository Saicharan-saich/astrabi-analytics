import { describe, expect, it } from 'vitest';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import { buildCanonicalQueryIntent } from '../services/ai-sql/canonicalIntent';
import { chooseBestSQLCandidate, reconcileQuerySpecWithCanonicalIntent } from '../services/ai-sql/directSqlEngine';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 100,
    grain: 'one row per transaction',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        {
            name: 'order_date', displayLabel: 'Order date', physicalType: 'date', semanticType: 'date', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: ['day', 'week', 'month', 'quarter', 'year'], synonyms: ['date'],
            valueDescriptors: [], distinctCount: 12, hasNulls: false,
        },
        {
            name: 'region', displayLabel: 'Region', physicalType: 'string', semanticType: 'category', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 4, hasNulls: false,
        },
        {
            name: 'product_name', displayLabel: 'Product name', physicalType: 'string', semanticType: 'category', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: ['product'], valueDescriptors: [], distinctCount: 20, hasNulls: false,
        },
        {
            name: 'sales', displayLabel: 'Sales', physicalType: 'number', semanticType: 'currency', role: 'metric',
            defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 90, hasNulls: false,
        },
    ],
};

function trendPlan(question: string, overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'trend',
        dimensions: [{ field: 'order_date', timeGrain: 'month' }],
        metrics: [{ field: 'sales', agg: 'sum' }],
        filters: [],
        sort: [{ field: 'order_date', dir: 'asc' }],
        limit: null,
        ambiguous: false,
        resultGrain: 'one row per month',
        originalQuestion: question,
        ...overrides,
    };
}

describe('advanced analytical operations are first-class query contracts', () => {
    it('preserves a running total through contract, canonical intent and model specification', () => {
        const question = 'Show monthly sales with a running total.';
        const plan = trendPlan(question);
        const contract = buildQueryContract(question, plan, [], model);
        const canonical = buildCanonicalQueryIntent(contract);
        const spec = reconcileQuerySpecWithCanonicalIntent({
            goal: 'monthly sales',
            operations: { measures: [{ field: 'sales', aggregation: 'sum' }] },
            expectedResult: { grain: 'monthly', columns: ['order_date', 'sales'] },
            assumptions: [],
        }, canonical);

        expect(contract.analyticOperations).toEqual([
            expect.objectContaining({ kind: 'running_total', outputAlias: 'running_total', required: true }),
        ]);
        expect(canonical.analyticOperations).toEqual(contract.analyticOperations);
        expect(spec.operations.tableCalculations).toEqual([
            expect.objectContaining({ type: 'running_total', outputAlias: 'running_total', required: true }),
        ]);
    });

    it('rejects a basic grouped query and selects the faithful window candidate', () => {
        const question = 'Show monthly sales with a running total.';
        const contract = buildQueryContract(question, trendPlan(question), [], model);
        const simple = `SELECT STRFTIME('%Y-%m', CAST(order_date AS TIMESTAMP)) AS order_date_month, SUM(sales) AS sales_sum
FROM data
GROUP BY STRFTIME('%Y-%m', CAST(order_date AS TIMESTAMP))`;
        const advanced = `WITH base AS (
  SELECT STRFTIME('%Y-%m', CAST(order_date AS TIMESTAMP)) AS order_date_month, SUM(sales) AS sales_sum
  FROM data
  GROUP BY STRFTIME('%Y-%m', CAST(order_date AS TIMESTAMP))
)
SELECT order_date_month, sales_sum,
       SUM(sales_sum) OVER (ORDER BY order_date_month ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM base`;

        expect(validateSQLAgainstContract(simple, contract).map(issue => issue.code))
            .toContain('missing_advanced_analytic_operation');
        expect(validateSQLAgainstContract(advanced, contract).map(issue => issue.code))
            .not.toContain('missing_advanced_analytic_operation');
        expect(chooseBestSQLCandidate(simple, advanced, contract)).toMatchObject({ source: 'review', sql: advanced });
    });

    it('compiles moving averages and period growth into reproducible DuckDB window SQL', () => {
        const movingQuestion = 'Show the 3-month moving average of monthly sales.';
        const movingSQL = correctSQL(trendPlan(movingQuestion), model);
        expect(movingSQL).toMatch(/WITH base AS/i);
        expect(movingSQL).toMatch(/AVG\([^)]*\) OVER \([^)]*ROWS BETWEEN 2 PRECEDING AND CURRENT ROW\)/i);
        expect(movingSQL).toMatch(/AS "moving_avg"/i);

        const growthQuestion = 'Show month-over-month sales growth.';
        const growthSQL = correctSQL(trendPlan(growthQuestion, {
            intent: 'trend_comparison',
            comparison: { type: 'previous_period', mode: 'trend', grain: 'month' },
        }), model);
        expect(growthSQL).toMatch(/LAG\([^)]*, 1\) OVER/i);
        expect(growthSQL).toMatch(/AS "previous_value"/i);
        expect(growthSQL).toMatch(/AS "growth_pct"/i);
    });

    it('keeps ordinary top-N simple and requires SQL growth for scalar period comparisons', () => {
        const ranking = trendPlan('Which 10 products generated the most sales?', {
            intent: 'ranking',
            dimensions: [{ field: 'product_name' }],
            sort: [{ field: 'sales', dir: 'desc' }],
            limit: 10,
        });
        expect(buildQueryContract(ranking.originalQuestion, ranking, [], model).analyticOperations).toEqual([]);

        const comparison = trendPlan('Compare this month and last month sales.', {
            intent: 'total_comparison',
            dimensions: [],
            comparison: { type: 'previous_period', mode: 'total', grain: 'month' },
        });
        expect(buildQueryContract(comparison.originalQuestion, comparison, [], model).analyticOperations)
            .toEqual([expect.objectContaining({ kind: 'period_growth', outputAlias: 'growth_pct' })]);
    });
});
