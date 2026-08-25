import { describe, expect, it } from 'vitest';
import { buildCanonicalQueryIntent, reconcilePlanWithCanonicalIntent } from '../services/ai-sql/canonicalIntent';
import {
    normalizeSimpleSQLToContract,
    reconcileQuerySpecWithCanonicalIntent,
} from '../services/ai-sql/directSqlEngine';
import {
    buildQueryContract,
    normalizeResultToContract,
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

    it('treats two independently filtered populations as a set intersection, not GROUP BY', () => {
        const question = 'What are the record companies that are used by both orchestras founded before 2003 and those founded after 2003?';
        const semanticModel = model([
            field('Record_Company', 'dimension'),
            field('Year_of_Founded', 'dimension', 'integer'),
        ]);
        const draft = plan(question, {
            intent: 'breakdown',
            dimensions: [{ field: 'Record_Company' }],
            metrics: [{ field: 'Year_of_Founded', agg: 'count' }],
        });
        const contract = buildQueryContract(question, draft, [], semanticModel, {
            tables: [{
                name: 'orchestra',
                rowCount: 12,
                columns: [{ name: 'Record_Company' }, { name: 'Year_of_Founded' }],
            }],
            links: [],
        });
        const canonical = buildCanonicalQueryIntent(contract);
        const reconciled = reconcilePlanWithCanonicalIntent(draft, canonical).plan;
        const intersectionSQL = `SELECT Record_Company FROM orchestra WHERE Year_of_Founded < 2003
            INTERSECT SELECT Record_Company FROM orchestra WHERE Year_of_Founded > 2003`;

        expect(contract).toMatchObject({
            setOperation: 'intersection',
            requiresGrouping: false,
            requiresRowProjection: true,
            requiresDistinctProjection: true,
        });
        expect(canonical.answerKind).toBe('set_result');
        expect(reconciled.metrics).toEqual([]);
        expect(reconciled.projectionFields).toEqual(['Record_Company']);
        expect(validateSQLAgainstContract(intersectionSQL, contract)).toEqual([]);
        expect(validateSQLAgainstContract(
            'SELECT Record_Company FROM orchestra WHERE Year_of_Founded < 2003',
            contract,
        ).map(issue => issue.code)).toContain('missing_set_operation');
        expect(normalizeResultToContract([
            { Record_Company: 'Decca Records' },
            { Record_Company: 'Decca Records' },
        ], contract)).toEqual([{ Record_Company: 'Decca Records' }]);
    });

    it('keeps a comparison measure hidden when member identity and contact fields are requested', () => {
        const question = 'Give the full name and contact number of members who had to spend more than average on each expense.';
        const semanticModel = model([
            field('first_name', 'dimension'),
            field('last_name', 'dimension'),
            field('phone', 'dimension'),
            field('member_id', 'dimension', 'identifier'),
            field('cost', 'metric'),
            field('link_to_member', 'dimension', 'identifier'),
        ]);
        const draft = plan(question, {
            dimensions: [{ field: 'cost' }],
            projectionFields: ['cost'],
            filters: [{ field: 'cost', op: 'above_avg', value: null }],
        });
        const contract = buildQueryContract(question, draft, [], semanticModel, {
            tables: [
                {
                    name: 'expense', rowCount: 20,
                    columns: [{ name: 'cost' }, { name: 'link_to_member' }],
                },
                {
                    name: 'member', rowCount: 6,
                    columns: [
                        { name: 'member_id', isPK: true },
                        { name: 'first_name' },
                        { name: 'last_name' },
                        { name: 'phone' },
                    ],
                },
            ],
            links: [{
                leftTable: 'expense', leftColumn: 'link_to_member',
                rightTable: 'member', rightColumn: 'member_id', type: 'fk',
            }],
        });
        const canonical = buildCanonicalQueryIntent(contract);
        const reconciled = reconcilePlanWithCanonicalIntent(draft, canonical).plan;
        const correctSQL = `SELECT DISTINCT member.first_name, member.last_name, member.phone
            FROM expense INNER JOIN member ON expense.link_to_member = member.member_id
            WHERE expense.cost > (SELECT AVG(cost) FROM expense)`;

        expect(contract.requiredOutputFields.filter(item => item.confidence === 'high').map(item => item.field))
            .toEqual(expect.arrayContaining(['first_name', 'last_name', 'phone']));
        expect(contract.requiredTables).toEqual(expect.arrayContaining(['expense', 'member']));
        expect(contract.requiresDistinctProjection).toBe(true);
        expect(reconciled.projectionFields).toEqual(expect.arrayContaining(['first_name', 'last_name', 'phone']));
        expect(reconciled.projectionFields).not.toContain('cost');
        expect(validateSQLAgainstContract(correctSQL, contract)).toEqual([]);
        expect(validateSQLAgainstContract(
            'SELECT DISTINCT cost FROM expense WHERE cost > (SELECT AVG(cost) FROM expense)',
            contract,
        ).map(issue => issue.code)).toEqual(expect.arrayContaining([
            'missing_requested_output',
            'missing_required_table',
        ]));
    });
});
