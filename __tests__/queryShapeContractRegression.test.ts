import { describe, expect, it } from 'vitest';
import { inferQueryShape } from '../services/ai-sql/queryShape';
import {
    buildQueryContract,
    validateResultAgainstContract,
    validateSQLAgainstContract,
} from '../services/ai-sql/queryContract';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
    datasetName: 'Dynamic fixture',
    rowCount: 12,
    grain: 'one row per record',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        { name: 'Name', displayLabel: 'Name', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 12, hasNulls: false },
        { name: 'Category', displayLabel: 'Category', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 5, hasNulls: false },
        { name: 'Age', displayLabel: 'Age', physicalType: 'number', semanticType: 'count', role: 'metric', defaultAgg: 'avg', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 10, hasNulls: false },
        { name: 'Value', displayLabel: 'Value', physicalType: 'number', semanticType: 'quantity', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 11, hasNulls: false },
        { name: 'Number_products', displayLabel: 'Number products', physicalType: 'number', semanticType: 'count', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: ['product count'], valueDescriptors: [], distinctCount: 8, hasNulls: false },
        { name: 'PetType', displayLabel: 'Pet type', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: ['type of pet'], valueDescriptors: [], distinctCount: 2, hasNulls: false },
        { name: 'Weight', displayLabel: 'Weight', physicalType: 'number', semanticType: 'quantity', role: 'metric', defaultAgg: 'avg', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 8, hasNulls: false },
    ],
};

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'single_metric', dimensions: [], metrics: [{ field: 'Value', agg: 'sum' }],
        filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'one row', originalQuestion: '',
        ...overrides,
    };
}

describe('dynamic query-shape and cardinality contract', () => {
    it.each([
        ['Show each category and the maximum value for each category', 'grouped_aggregate', 'all_groups', 'max'],
        ['What is the average value for every category?', 'grouped_aggregate', 'all_groups', 'avg'],
        ['What is the maximum value?', 'scalar_aggregate', 'unspecified', 'max'],
        ['Which category has the maximum value?', 'ranking', 'single', 'max'],
    ] as const)('separates aggregation from cardinality: %s', (question, operation, selection, aggregation) => {
        expect(inferQueryShape(question)).toMatchObject({ operation, selection, explicitAggregation: aggregation });
    });

    it.each([
        ['List names ordered by age from the oldest to the youngest', 'desc'],
        ['Show name and category sorted by age from youngest to oldest', 'asc'],
        ['List names in ascending order of age', 'asc'],
    ] as const)('treats ordered listings as unbounded projections: %s', (question, direction) => {
        expect(inferQueryShape(question)).toMatchObject({
            operation: 'projection', selection: 'all_rows', orderDirection: direction, prohibitsImplicitLimit: true,
        });
    });

    it('rejects LIMIT and a collapsed output for all requested groups', () => {
        const question = 'Show each category and the maximum value for each category';
        const contract = buildQueryContract(question, plan({
            intent: 'breakdown',
            dimensions: [{ field: 'Category' }],
            metrics: [{ field: 'Value', agg: 'max' }],
        }), [], model);

        expect(validateSQLAgainstContract(
            'SELECT Category, MAX(Value) maximum_value FROM data GROUP BY Category ORDER BY maximum_value DESC LIMIT 1',
            contract,
        ).map(issue => issue.code)).toContain('unexpected_limit');
        expect(contract.resultRowExpectation).toEqual({ minimum: 5, basis: 'distinct_groups' });
        expect(validateResultAgainstContract([{ Category: 'one', maximum_value: 10 }], contract)
            .map(issue => issue.code)).toContain('unexpected_result_cardinality');
        expect(validateResultAgainstContract(
            Array.from({ length: 5 }, (_, index) => ({ Category: index, maximum_value: index })),
            contract,
        )).toEqual([]);
    });

    it('rejects aggregation, grouping, LIMIT, and a collapsed output for an all-row listing', () => {
        const question = 'Show name, category and age for all records ordered by age from oldest to youngest';
        const contract = buildQueryContract(question, plan({
            intent: 'projection', metrics: [], projectionFields: ['Name', 'Category', 'Age'],
            sort: [{ field: 'Age', dir: 'desc' }],
        }), [], model);
        const wrongSql = 'SELECT Category, SUM(Age) total_age FROM data GROUP BY Category ORDER BY total_age DESC LIMIT 1';
        expect(validateSQLAgainstContract(wrongSql, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['unexpected_aggregation', 'unexpected_grouping', 'unexpected_limit']));
        expect(contract.resultRowExpectation).toEqual({ exact: 12, basis: 'source_rows' });
        expect(validateResultAgainstContract([{ Category: 'one', total_age: 63 }], contract)).toHaveLength(1);
    });

    it.each([
        'Which categories have at least 3 records?',
        'Show categories with at most 5 records',
    ])('does not mistake a threshold for ranking: %s', question => {
        expect(inferQueryShape(question).operation).not.toBe('ranking');
    });

    it('requires explicit de-duplication for a unique-value projection', () => {
        const question = 'List the different categories ordered by category ascending';
        const contract = buildQueryContract(question, plan({
            intent: 'projection', metrics: [], projectionFields: ['Category'],
            sort: [{ field: 'Category', dir: 'asc' }],
        }), [], model);
        expect(contract.requiresDistinctProjection).toBe(true);
        expect(contract.resultRowExpectation).toBeUndefined();
        expect(validateSQLAgainstContract('SELECT Category FROM data ORDER BY Category ASC', contract)
            .map(issue => issue.code)).toContain('missing_distinct_projection');
        expect(validateSQLAgainstContract('SELECT DISTINCT Category FROM data ORDER BY Category ASC', contract)).toEqual([]);
    });

    it('keeps requested names in the outer result when an average is only a filter threshold', () => {
        const question = 'Find the names of stores whose number products is more than the average number of products.';
        const contract = buildQueryContract(question, plan({
            intent: 'single_metric',
            dimensions: [],
            metrics: [{ field: 'Name', agg: 'count' }],
        }), [], model);

        expect(contract).toMatchObject({
            expectedCardinality: 'detail',
            requiresGrouping: false,
            requiresRanking: false,
            requiresRowProjection: true,
        });
        expect(contract.requiredOutputFields.map(field => field.field)).toContain('Name');
        expect(validateSQLAgainstContract(
            'SELECT Name FROM data WHERE Number_products > (SELECT AVG(Number_products) FROM data)',
            contract,
        )).toEqual([]);
        expect(validateSQLAgainstContract(
            'SELECT COUNT(Name) AS store_count_above_average FROM data WHERE Number_products > (SELECT AVG(Number_products) FROM data)',
            contract,
        ).map(issue => issue.code)).toContain('unexpected_aggregation');
    });

    it('treats names plus how-many as grouped output rather than one scalar count', () => {
        const question = 'What are the pet types and how many records belong to each?';
        const contract = buildQueryContract(question, plan({
            intent: 'breakdown',
            dimensions: [{ field: 'PetType' }],
            metrics: [{ field: 'Name', agg: 'count' }],
        }), [], model);

        expect(contract.expectedCardinality).toBe('grouped');
        expect(contract.requiresGrouping).toBe(true);
        expect(validateSQLAgainstContract(
            'SELECT PetType, COUNT(*) AS record_count FROM data GROUP BY PetType',
            contract,
        )).toEqual([]);
    });

    it('assigns duplicated output column names to the entity named in the answer clause', () => {
        const contract = buildQueryContract(
            'What are the names of teachers and how many courses do they teach?',
            plan({
                intent: 'breakdown',
                dimensions: [{ field: 'Name' }],
                metrics: [{ field: 'Course_ID', agg: 'count' }],
            }),
            [],
            model,
            {
                tables: [
                    { name: 'teacher', rowCount: 7, columns: [{ name: 'Teacher_ID', isPK: true }, { name: 'Name' }] },
                    { name: 'course', rowCount: 12, columns: [{ name: 'Course_ID', isPK: true }, { name: 'Name' }, { name: 'Teacher_ID' }] },
                ],
                links: [{ leftTable: 'teacher', leftColumn: 'Teacher_ID', rightTable: 'course', rightColumn: 'Teacher_ID', type: 'fk' }],
            },
        );
        expect(contract.requiredOutputFields).toEqual(expect.arrayContaining([
            expect.objectContaining({ table: 'teacher', field: 'Name', confidence: 'high' }),
        ]));
        expect(contract.requiredOutputFields).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ table: 'course', field: 'Name' }),
        ]));
    });

    it('does not turn a comparator reference into an outer top-one ranking', () => {
        const shape = inferQueryShape('Which cars have more than the lowest horsepower?');
        expect(shape).toMatchObject({ operation: 'projection', selection: 'all_rows', prohibitsImplicitLimit: true });
    });

    it('places raw numeric thresholds in WHERE even when the answer itself is a count', () => {
        const contract = buildQueryContract(
            'How many pets are owned by people whose age is greater than 20?',
            plan({ intent: 'single_metric', metrics: [{ field: 'Name', agg: 'count' }] }),
            [],
            model,
        );
        expect(contract.threshold).toMatchObject({ operator: '>', value: 20, requiresHaving: false });
    });

    it('rejects collection aggregates that hide requested row fields', () => {
        const contract = buildQueryContract(
            'Show the name and category for all records.',
            plan({ intent: 'projection', metrics: [], projectionFields: ['Name', 'Category'] }),
            [],
            model,
        );
        expect(validateSQLAgainstContract(
            'SELECT Category, ARRAY_AGG(Name) AS names FROM data GROUP BY Category',
            contract,
        ).map(issue => issue.code)).toContain('unexpected_aggregation');
    });
});
