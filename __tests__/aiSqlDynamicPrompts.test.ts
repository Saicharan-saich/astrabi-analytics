import { describe, expect, it } from 'vitest';
import {
    buildPlannerSystemPrompt,
    buildSQLSystemPrompt,
    shouldRunIndependentSQLReview,
    type DynamicQuerySpec,
} from '../services/ai-sql/directSqlEngine';

const simpleSpec: DynamicQuerySpec = {
    goal: 'Total sales',
    operations: { measures: [{ field: 'sales', aggregation: 'sum' }] },
    expectedResult: { grain: 'one row', columns: ['total_sales'] },
    assumptions: [],
};

describe('AI SQL dynamic prompt budget', () => {
    it('uses compact prompts and no second-model review for straightforward fallback work', () => {
        const planner = buildPlannerSystemPrompt('What is total sales?');
        const writer = buildSQLSystemPrompt('What is total sales?', simpleSpec);
        expect(planner.length).toBeLessThan(1_500);
        expect(writer.length).toBeLessThan(1_500);
        expect(shouldRunIndependentSQLReview('What is total sales?', simpleSpec)).toBe(false);
    });

    it('loads complete safeguards and a reviewer only for risky analytical shapes', () => {
        const advanced: DynamicQuerySpec = {
            ...simpleSpec,
            operations: {
                joins: [{
                    leftTable: 'orders', rightTable: 'customers',
                    condition: 'orders.customer_id = customers.customer_id',
                }],
            },
        };
        expect(buildSQLSystemPrompt('Compare customers across orders', advanced).length).toBeGreaterThan(1_500);
        expect(shouldRunIndependentSQLReview('Compare customers across orders', advanced)).toBe(true);
    });

    it('keeps the complete reviewed route for benchmark comparability', () => {
        expect(buildPlannerSystemPrompt('What is total sales?', 'benchmark').length).toBeGreaterThan(1_500);
        expect(shouldRunIndependentSQLReview('What is total sales?', simpleSpec, 'benchmark')).toBe(true);
    });
});
