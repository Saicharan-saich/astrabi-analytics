import { describe, expect, it } from 'vitest';
import { SIGNED_OUTCOME_SEMANTICS } from '../services/ai-sql/directSqlEngine';
import { buildNoDataExplanation, sqlUsesTemporalPredicate } from '../services/ai-sql/noDataExplanation';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 100,
    grain: 'one row per order',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        { name: 'city', displayLabel: 'City', physicalType: 'string', semanticType: 'geography', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 20, hasNulls: false },
        { name: 'profit', displayLabel: 'Profit', physicalType: 'number', semanticType: 'currency', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 80, hasNulls: false },
        { name: 'order_date', displayLabel: 'Order Date', physicalType: 'date', semanticType: 'date', role: 'dimension', defaultAgg: 'none', timeGrainSupport: ['day', 'month', 'year'], synonyms: [], valueDescriptors: [], distinctCount: 90, hasNulls: false },
    ],
    timeContext: { minDate: '2014-01-03', maxDate: '2018-01-05', anchorDate: '2018-01-05', primaryDateColumn: 'order_date' },
};

const plan: AnalysisPlan = {
    intent: 'breakdown', dimensions: [{ field: 'city' }], metrics: [{ field: 'profit', agg: 'sum' }],
    filters: [], sort: [], limit: null, ambiguous: false,
    resultGrain: 'one row per city', originalQuestion: 'Which cities had no profit?',
};

describe('business outcome and empty-result semantics', () => {
    it('defines non-profitable signed outcomes as non-positive, reserving equality for explicit zero', () => {
        expect(SIGNED_OUTCOME_SEMANTICS).toContain('<= 0');
        expect(SIGNED_OUTCOME_SEMANTICS).toContain('= 0');
        expect(SIGNED_OUTCOME_SEMANTICS).toMatch(/no profit/i);
        expect(SIGNED_OUTCOME_SEMANTICS).toMatch(/exactly zero/i);
    });

    it('does not mention dataset dates for a non-temporal exact-zero aggregate', () => {
        const sql = 'SELECT city FROM data GROUP BY city HAVING SUM(profit) = 0 ORDER BY city';
        expect(sqlUsesTemporalPredicate(sql, model)).toBe(false);
        const message = buildNoDataExplanation({ sql, plan, semanticModel: model, privacyMode: 'strict' });
        expect(message).toMatch(/exactly equal to zero/i);
        expect(message).not.toContain('2014-01-03');
        expect(message).not.toMatch(/date range/i);
    });

    it('includes local date coverage only for an actual temporal predicate', () => {
        const sql = `SELECT city FROM data WHERE CAST(order_date AS DATE) >= DATE '2020-01-01' GROUP BY city`;
        expect(sqlUsesTemporalPredicate(sql, model)).toBe(true);
        const message = buildNoDataExplanation({ sql, plan, semanticModel: model, privacyMode: 'strict' });
        expect(message).toContain('2014-01-03');
        expect(message).toContain('2018-01-05');
        expect(message).toMatch(/date range/i);
    });
});
