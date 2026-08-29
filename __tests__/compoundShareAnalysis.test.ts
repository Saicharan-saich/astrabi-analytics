import { describe, expect, it } from 'vitest';
import { detectAdvancedAnalyticOperations } from '../services/ai-sql/advancedAnalytics';
import { recommendChart } from '../services/ai-sql/chartRecommender';
import { reshapeData } from '../services/ai-sql/dataReshaper';
import { enforceRequestedBreakdownDimension } from '../services/ai-sql/intentPlanner';
import { buildQueryContract } from '../services/ai-sql/queryContract';
import { profileResult } from '../services/ai-sql/resultProfiler';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const question = "Show each category's sales, percentage of total sales, rank, and cumulative sales percentage.";

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 100,
    grain: 'one row per order',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        {
            name: 'order_id', displayLabel: 'Order ID', physicalType: 'string', semanticType: 'identifier', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: ['order'], valueDescriptors: [], distinctCount: 100, hasNulls: false,
        },
        {
            name: 'category', displayLabel: 'Category', physicalType: 'string', semanticType: 'category', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 3, hasNulls: false,
        },
        {
            name: 'amount', displayLabel: 'Sales Amount', physicalType: 'number', semanticType: 'currency', role: 'metric',
            defaultAgg: 'sum', timeGrainSupport: [], synonyms: ['sales'], valueDescriptors: [], distinctCount: 90, hasNulls: false,
        },
    ],
};

function plan(): AnalysisPlan {
    return {
        intent: 'share_of_total',
        dimensions: [{ field: 'order_id' }],
        metrics: [{ field: 'amount', agg: 'sum' }],
        filters: [],
        sort: [{ field: 'amount', dir: 'desc' }],
        limit: 1,
        ambiguous: false,
        resultGrain: 'one row per order_id',
        originalQuestion: question,
    };
}

describe('compound grouped share analysis', () => {
    it('locks explicit possessive grouping to the requested entity and preserves every calculation', () => {
        const draft = plan();
        enforceRequestedBreakdownDimension(draft, question, model);

        expect(draft.dimensions).toEqual([{ field: 'category' }]);
        expect(draft.limit).toBeNull();
        expect(draft.resultGrain).toBe('one row per category');
        expect(detectAdvancedAnalyticOperations(question, draft).map(operation => operation.kind))
            .toEqual(['explicit_rank', 'percent_of_total', 'cumulative_percent']);
        expect(buildQueryContract(question, draft, [], model)).toMatchObject({
            requiresGrouping: true,
            requiredDimension: 'category',
            expectedMeasures: [expect.objectContaining({ field: 'amount', aggregation: 'sum' })],
            analyticOperations: [
                expect.objectContaining({ kind: 'explicit_rank' }),
                expect.objectContaining({ kind: 'percent_of_total' }),
                expect.objectContaining({ kind: 'cumulative_percent' }),
            ],
        });
        const sql = correctSQL(draft, model);
        expect(sql).toMatch(/GROUP BY "category"/i);
        expect(sql).toMatch(/SUM\("amount_sum"\) OVER \(ORDER BY "amount_sum" DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\)/i);
        expect(sql).toMatch(/AS "cumulative_pct"/i);
        expect(sql).not.toMatch(/GROUP BY "order_id"/i);
    });

    it('renders the base measure and percentage calculations together without plotting rank', () => {
        const governedPlan = plan();
        enforceRequestedBreakdownDimension(governedPlan, question, model);
        const rows = [
            { category: 'Furniture', total_sales: 600, percentage_of_total_sales: 60, sales_rank: 1, cumulative_sales_percentage: 60 },
            { category: 'Technology', total_sales: 300, percentage_of_total_sales: 30, sales_rank: 2, cumulative_sales_percentage: 90 },
            { category: 'Office Supplies', total_sales: 100, percentage_of_total_sales: 10, sales_rank: 3, cumulative_sales_percentage: 100 },
        ];
        const profile = profileResult(rows, governedPlan, model);
        const chart = recommendChart(profile, governedPlan, model);
        const reshaped = reshapeData(rows, profile, chart, governedPlan);

        expect(chart).toMatchObject({
            chartType: 'dualAxisCombo',
            xKey: 'category',
            yKey: 'total_sales',
            secondaryYKeys: ['percentage_of_total_sales', 'cumulative_sales_percentage'],
            useDualAxis: true,
            rightAxisFormat: 'percent',
        });
        expect(reshaped.chart.yKey).toBe('total_sales');
        expect(Object.keys(reshaped.data[0])).not.toContain('total_sales_pct');
    });
});
