import { describe, expect, it } from 'vitest';
import { buildCanonicalQueryIntent } from '../services/ai-sql/canonicalIntent';
import {
    normalizeSimpleSQLToContract,
    reconcileQuerySpecWithCanonicalIntent,
} from '../services/ai-sql/directSqlEngine';
import {
    buildQueryContract,
    validateSQLAgainstContract,
} from '../services/ai-sql/queryContract';
import type { AnalysisPlan, SemanticField, SemanticModel } from '../services/ai-sql/types';

function field(
    name: string,
    role: SemanticField['role'],
    semanticType: SemanticField['semanticType'] = role === 'metric' ? 'number' : 'category',
    synonyms: string[] = [],
): SemanticField {
    return {
        name,
        displayLabel: name.replace(/_/g, ' '),
        physicalType: role === 'metric' ? 'number' : 'string',
        semanticType,
        role,
        defaultAgg: role === 'metric' ? 'sum' : 'none',
        timeGrainSupport: [],
        synonyms,
        valueDescriptors: [],
        distinctCount: role === 'metric' ? 20 : 5,
        hasNulls: false,
    };
}

function model(fields: SemanticField[]): SemanticModel {
    return {
        datasetName: 'data',
        rowCount: 100,
        grain: 'one row per record',
        fields,
        compositeMetrics: [],
        derivedMetrics: [],
    };
}

function plan(question: string, overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'projection',
        dimensions: [],
        metrics: [],
        filters: [],
        sort: [],
        limit: null,
        ambiguous: false,
        resultGrain: 'one row per record',
        originalQuestion: question,
        ...overrides,
    };
}

describe('semantic answer-contract hardening', () => {
    it('rejects and normalizes GROUP BY fields finer than the requested grain', () => {
        const question = 'Show total quantity by customer segment';
        const semanticModel = model([
            field('customer_segment', 'dimension', 'category', ['segment']),
            field('customer_name', 'dimension', 'category', ['customer']),
            field('category', 'dimension'),
            field('quantity', 'metric', 'integer', ['units']),
        ]);
        const contract = buildQueryContract(question, plan(question, {
            intent: 'breakdown',
            dimensions: [{ field: 'customer_segment' }, { field: 'category' }, { field: 'customer_name' }],
            metrics: [{ field: 'quantity', agg: 'sum' }],
        }), [], semanticModel);
        const overGrouped = 'SELECT customer_segment, category, customer_name, SUM(quantity) total_quantity FROM data GROUP BY customer_segment, category, customer_name';

        expect(contract.allowedGroupingFields).toEqual(['customer_segment']);
        expect(validateSQLAgainstContract(overGrouped, contract).map(issue => issue.code))
            .toContain('unexpected_grouping_field');
        expect(normalizeSimpleSQLToContract(overGrouped, contract))
            .toBe('SELECT customer_segment, SUM(quantity) total_quantity FROM data GROUP BY customer_segment');
        expect(validateSQLAgainstContract(
            'SELECT customer_segment, SUM(quantity) total_quantity FROM data GROUP BY customer_segment',
            contract,
        )).toEqual([]);
    });

    it('uses an aggregate only as a predicate when the question requests entity labels', () => {
        const question = 'Which industries have average satisfaction score at least 70?';
        const semanticModel = model([
            field('industry', 'dimension'),
            field('satisfaction_score', 'metric', 'number', ['score']),
        ]);
        const contract = buildQueryContract(question, plan(question, {
            intent: 'breakdown',
            dimensions: [{ field: 'industry' }],
            metrics: [{ field: 'satisfaction_score', agg: 'avg' }],
            filters: [{ field: 'satisfaction_score', op: '>=', value: 70, isHaving: true }],
        }), [], semanticModel);

        expect(contract.strictOutputProjection).toBe(true);
        expect(validateSQLAgainstContract(
            'SELECT industry FROM data GROUP BY industry HAVING AVG(satisfaction_score) >= 70',
            contract,
        )).toEqual([]);
        expect(validateSQLAgainstContract(
            'SELECT industry, AVG(satisfaction_score) average_score FROM data GROUP BY industry HAVING AVG(satisfaction_score) >= 70',
            contract,
        ).map(issue => issue.code)).toContain('missing_requested_output');
    });

    it('deduplicates list-style attribute answers without changing raw-row requests', () => {
        const semanticModel = model([
            field('event_name', 'dimension', 'category', ['event']),
            field('status', 'dimension'),
        ]);
        const question = 'List the names of closed events';
        const contract = buildQueryContract(question, plan(question, {
            dimensions: [{ field: 'event_name' }],
            projectionFields: ['event_name'],
        }), [], semanticModel);

        expect(contract.requiresDistinctProjection).toBe(true);
        expect(normalizeSimpleSQLToContract("SELECT event_name FROM data WHERE status = 'Closed'", contract))
            .toBe("SELECT DISTINCT event_name FROM data WHERE status = 'Closed'");

        const rawQuestion = 'Show every raw record';
        const rawContract = buildQueryContract(rawQuestion, plan(rawQuestion, {
            dimensions: [{ field: 'event_name' }],
            projectionFields: ['event_name'],
        }), [], semanticModel);
        expect(rawContract.requiresDistinctProjection).toBe(false);
    });

    it('keeps a full ranking unbounded while preserving the requested ordering', () => {
        const question = 'Rank industries by record count, largest first';
        const semanticModel = model([field('industry', 'dimension')]);
        const contract = buildQueryContract(question, plan(question, {
            intent: 'ranking',
            dimensions: [{ field: 'industry' }],
            metrics: [{ field: '*', agg: 'count' }],
        }), [], semanticModel);

        expect(contract.rankingLimit).toBeUndefined();
        expect(contract.prohibitsImplicitLimit).toBe(true);
        expect(validateSQLAgainstContract(
            'SELECT industry, COUNT(*) record_count FROM data GROUP BY industry ORDER BY record_count DESC LIMIT 1',
            contract,
        ).map(issue => issue.code)).toContain('unexpected_limit');
    });

    it('carries separate numerator and denominator semantics into percentage planning', () => {
        const question = 'What percentage of accounts are active?';
        const semanticModel = model([field('account_name', 'dimension'), field('status', 'dimension')]);
        const analysisPlan = plan(question, {
            intent: 'conditional_percentage',
            metrics: [{ field: '*', agg: 'count' }],
            resultGrain: 'one scalar result row',
        });
        const canonical = buildCanonicalQueryIntent(buildQueryContract(question, analysisPlan, [], semanticModel));
        const spec = reconcileQuerySpecWithCanonicalIntent({
            goal: question,
            operations: {},
            expectedResult: { grain: 'one row', columns: [] },
            assumptions: [],
        }, canonical);

        expect(spec.operations.ratio).toMatchObject({ kind: 'percentage', basis: 'row_count', scale: 100 });
        expect(spec.operations.ratio?.numerator.description).toContain('qualifying subset');
        expect(spec.operations.ratio?.denominator.description).toContain('reference population');
    });
});
