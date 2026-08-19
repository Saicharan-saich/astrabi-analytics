import { describe, expect, it } from 'vitest';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import { buildCanonicalQueryIntent, reconcilePlanWithCanonicalIntent } from '../services/ai-sql/canonicalIntent';
import { reconcileQuerySpecWithCanonicalIntent, type DynamicQuerySpec } from '../services/ai-sql/directSqlEngine';

const field = (name: string, role: 'metric' | 'dimension', physicalType: 'number' | 'string' = 'string') => ({
    name,
    displayLabel: name.replace(/_/g, ' '),
    physicalType,
    semanticType: role === 'metric' ? 'quantity' as const : 'category' as const,
    role,
    defaultAgg: role === 'metric' ? 'sum' as const : 'none' as const,
    timeGrainSupport: [],
    synonyms: [],
    valueDescriptors: [],
    distinctCount: role === 'metric' ? 8 : 4,
    hasNulls: false,
});

const model: SemanticModel = {
    datasetName: 'data',
    rowCount: 12,
    grain: 'one row per record',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        field('Name', 'dimension'),
        field('Country', 'dimension'),
        field('Age', 'metric', 'number'),
        field('PetType', 'dimension'),
        field('pet_age', 'dimension', 'number'),
        field('Weight', 'metric', 'number'),
        field('Ticket_Count', 'metric', 'number'),
        field('Citizenship', 'dimension'),
        field('Net_Worth_Millions', 'metric', 'number'),
    ],
};

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'single_metric',
        dimensions: [],
        metrics: [{ field: 'Age', agg: 'sum' }],
        filters: [],
        sort: [],
        limit: null,
        ambiguous: false,
        resultGrain: 'one row',
        originalQuestion: '',
        ...overrides,
    };
}

describe('canonical query intent', () => {
    it('turns a wrongly aggregated ordered listing back into an unbounded projection', () => {
        const question = 'Show name, country, age for all singers ordered by age from oldest to youngest.';
        const draft = plan({
            intent: 'ranking',
            dimensions: [{ field: 'Country' }],
            metrics: [{ field: 'Age', agg: 'sum' }],
            sort: [{ field: 'Age', dir: 'asc' }],
            limit: 1,
        });
        const contract = buildQueryContract(question, draft, [], model);
        const canonical = buildCanonicalQueryIntent(contract);
        const result = reconcilePlanWithCanonicalIntent(draft, canonical).plan;

        expect(canonical.answerKind).toBe('detail_projection');
        expect(result).toMatchObject({
            intent: 'projection',
            metrics: [],
            limit: null,
            sort: [{ field: 'Age', dir: 'desc' }],
        });
        expect(result.projectionFields).toEqual(expect.arrayContaining(['Name', 'Country', 'Age']));
    });

    it('replaces an incorrect grouping grain and aggregation with explicit user intent', () => {
        const question = 'What is the average weight for each type of pet?';
        const draft = plan({
            intent: 'breakdown',
            dimensions: [{ field: 'pet_age' }],
            metrics: [{ field: 'Weight', agg: 'sum' }],
        });
        const contract = buildQueryContract(question, draft, [], model);
        const result = reconcilePlanWithCanonicalIntent(draft, buildCanonicalQueryIntent(contract)).plan;

        expect(result.dimensions).toEqual([{ field: 'PetType' }]);
        expect(result.metrics).toEqual([{ field: 'Weight', agg: 'avg' }]);
        expect(result.limit).toBeNull();
    });

    it('preserves all explicitly requested measures in the contract', () => {
        const question = 'What are the average and maximum ticket count?';
        const contract = buildQueryContract(question, plan({
            metrics: [{ field: 'Ticket_Count', agg: 'avg' }],
        }), [], model);

        expect(contract.expectedAggregations).toEqual(['avg', 'max']);
        expect(validateSQLAgainstContract('SELECT AVG(Ticket_Count) FROM data', contract)
            .map(issue => issue.code)).toContain('missing_aggregation');
        expect(validateSQLAgainstContract(
            'SELECT AVG(Ticket_Count), MAX(Ticket_Count) FROM data',
            contract,
        )).toEqual([]);
    });

    it('normalizes the model specification before SQL drafting', () => {
        const question = 'Show different citizenships and the maximum net worth of singers of each citizenship.';
        const draftPlan = plan({
            intent: 'breakdown',
            dimensions: [{ field: 'Citizenship' }],
            metrics: [{ field: 'Net_Worth_Millions', agg: 'max' }],
        });
        const canonical = buildCanonicalQueryIntent(buildQueryContract(question, draftPlan, [], model));
        const badSpec: DynamicQuerySpec = {
            goal: 'return one singer',
            operations: {
                measures: [{ field: 'Age', aggregation: 'sum' }],
                groupBy: [{ field: 'Name' }],
                orderBy: [{ expression: 'SUM(Age)', direction: 'desc' }],
                limit: 1,
            },
            expectedResult: { grain: 'one row', columns: ['Name', 'total_age'] },
            assumptions: [],
            clarification: 'Which singer?',
        };
        const spec = reconcileQuerySpecWithCanonicalIntent(badSpec, canonical);

        expect(spec.operations.groupBy).toEqual([{ field: 'Citizenship' }]);
        expect(spec.operations.measures).toEqual([{ field: 'Net_Worth_Millions', aggregation: 'max' }]);
        expect(spec.operations.limit).toBeUndefined();
        expect(spec.expectedResult.grain).toBe('one row per Citizenship');
        expect(spec.clarification).toBeUndefined();
    });
});
