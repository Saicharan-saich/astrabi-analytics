import { describe, expect, it } from 'vitest';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';
import { buildQueryContract } from '../services/ai-sql/queryContract';
import { buildCanonicalQueryIntent } from '../services/ai-sql/canonicalIntent';
import {
    buildAnalyticalIR,
    verifyAnalyticalIR,
} from '../services/ai-sql/analyticalIR';
import { reconcileQuerySpecWithAnalyticalIR, type DynamicQuerySpec } from '../services/ai-sql/directSqlEngine';
import { validateAnalyticalResult } from '../services/ai-sql/analyticalResultValidator';
import { compileAnalyticalIRToSQL } from '../services/ai-sql/analyticalSqlAst';

const field = (
    name: string,
    role: 'metric' | 'dimension',
    semanticType: any = role === 'metric' ? 'quantity' : 'category',
): any => ({
    name,
    displayLabel: name.replace(/_/g, ' '),
    physicalType: role === 'metric' ? 'number' : 'string',
    semanticType,
    role,
    defaultAgg: role === 'metric' ? 'sum' : 'none',
    timeGrainSupport: [],
    synonyms: [],
    valueDescriptors: [],
    distinctCount: role === 'metric' ? 10 : 4,
    hasNulls: false,
    additivity: semanticType === 'percentage' ? 'non_additive' : role === 'metric' ? 'additive' : 'not_applicable',
    unit: semanticType === 'currency' ? 'currency' : 'quantity',
    nativeGrain: 'one row per record',
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
        field('Age', 'metric'),
        field('PetType', 'dimension'),
        field('pet_age', 'dimension'),
        field('Weight', 'metric'),
        field('industry', 'dimension'),
        field('satisfaction_score', 'metric'),
        field('status', 'dimension'),
        field('amount', 'metric', 'currency'),
        field('grade', 'dimension'),
        field('ID', 'metric'),
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

function irFor(question: string, draft: AnalysisPlan) {
    const contract = buildQueryContract(question, draft, [], model);
    const canonical = buildCanonicalQueryIntent(contract);
    return buildAnalyticalIR(question, draft, model, contract, canonical);
}

describe('Canonical Analytical IR', () => {
    it('freezes an ordered row projection without aggregate or implicit limit', () => {
        const ir = irFor(
            'Show name, country, age for all singers ordered by age from oldest to youngest.',
            plan({
                intent: 'ranking',
                dimensions: [{ field: 'Country' }],
                metrics: [{ field: 'Age', agg: 'sum' }],
                sort: [{ field: 'Age', dir: 'asc' }],
                limit: 1,
            }),
        );

        expect(ir.answer.kind).toBe('detail_projection');
        expect(ir.answer.fields.map(item => item.field)).toEqual(expect.arrayContaining(['Name', 'Country', 'Age']));
        expect(ir.operators.map(operator => operator.kind)).not.toContain('aggregate');
        expect(ir.operators.map(operator => operator.kind)).not.toContain('limit');
        expect(verifyAnalyticalIR(ir)).toEqual([]);
        expect(Object.isFrozen(ir)).toBe(true);
        expect(Object.isFrozen(ir.operators)).toBe(true);
    });

    it('represents grouped average as GROUP → AGGREGATE → PROJECT at pet type grain', () => {
        const ir = irFor(
            'What is the average weight for each type of pet?',
            plan({
                intent: 'breakdown',
                dimensions: [{ field: 'pet_age' }],
                metrics: [{ field: 'Weight', agg: 'sum' }],
            }),
        );
        const aggregate: any = ir.operators.find(operator => operator.kind === 'aggregate');

        expect(ir.answer.grain.map(item => item.field)).toEqual(['PetType']);
        expect(aggregate.measures).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'Weight', aggregation: 'avg', visibility: 'visible' }),
        ]));
        expect(ir.operators.map(operator => operator.kind)).toEqual(['group', 'aggregate', 'project']);
        expect(verifyAnalyticalIR(ir)).toEqual([]);
    });

    it('keeps a qualification aggregate hidden when the question asks only which entities', () => {
        const ir = irFor(
            'Which industries have average satisfaction score at least 70?',
            plan({
                intent: 'aggregate_filter',
                dimensions: [{ field: 'industry' }],
                metrics: [{ field: 'satisfaction_score', agg: 'avg' }],
                filters: [{ field: 'satisfaction_score', op: '>=', value: 70, isHaving: true }],
            }),
        );
        const aggregate: any = ir.operators.find(operator => operator.kind === 'aggregate');

        expect(ir.answer.fields.filter(item => item.visibility === 'visible').map(item => item.field)).toEqual(['industry']);
        expect(aggregate.measures[0]).toMatchObject({ field: 'satisfaction_score', aggregation: 'avg', visibility: 'helper' });
    });

    it('overrides a drifting model specification with the frozen IR', () => {
        const ir = irFor(
            'What is the average weight for each type of pet?',
            plan({ intent: 'breakdown', dimensions: [{ field: 'PetType' }], metrics: [{ field: 'Weight', agg: 'avg' }] }),
        );
        const badSpec: DynamicQuerySpec = {
            goal: 'one old pet',
            operations: {
                measures: [{ field: 'Age', aggregation: 'sum' }],
                groupBy: [{ field: 'pet_age' }],
                orderBy: [{ expression: 'SUM(Age)', direction: 'desc' }],
                limit: 1,
            },
            expectedResult: { grain: 'one row', columns: ['pet_age', 'total_age'] },
            assumptions: [],
        };

        const reconciled = reconcileQuerySpecWithAnalyticalIR(badSpec, ir);
        expect(reconciled.operations.groupBy).toEqual([{ field: 'PetType' }]);
        expect(reconciled.operations.measures).toEqual([{ field: 'Weight', aggregation: 'avg' }]);
        expect(reconciled.operations.limit).toBeUndefined();
        expect(reconciled.expectedResult.columns).toEqual(['PetType', 'avg_weight']);
    });

    it('detects duplicate grouped results and invalid population percentages', () => {
        const grouped = irFor(
            'What is the average weight for each type of pet?',
            plan({ intent: 'breakdown', dimensions: [{ field: 'PetType' }], metrics: [{ field: 'Weight', agg: 'avg' }] }),
        );
        expect(validateAnalyticalResult([
            { PetType: 'cat', avg_weight: 12 },
            { PetType: 'cat', avg_weight: 13 },
        ], grouped).map(issue => issue.code)).toContain('duplicate_result_grain');

        const ratio = irFor(
            'What percentage of loan amount has status A?',
            plan({
                intent: 'conditional_percentage',
                dimensions: [],
                metrics: [{ field: 'amount', agg: 'sum' }],
                filters: [{ field: 'status', op: '=', value: 'A' }],
            }),
        );
        expect(validateAnalyticalResult([{ percentage: 118 }], ratio).map(issue => issue.code)).toContain('percentage_range');
    });

    it('compiles the common analytical subset through a typed SQL AST', () => {
        const grouped = irFor(
            'What is the average weight for each type of pet?',
            plan({ intent: 'breakdown', dimensions: [{ field: 'PetType' }], metrics: [{ field: 'Weight', agg: 'avg' }] }),
        );
        const compiled = compileAnalyticalIRToSQL(grouped);
        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain('SELECT');
        expect(compiled.sql).toContain('"PetType"');
        expect(compiled.sql).toContain('AVG("Weight") AS "avg_weight"');
        expect(compiled.sql).toContain('GROUP BY "PetType"');

        const projection = irFor(
            'Show name, country, age for all singers ordered by age from oldest to youngest.',
            plan({ intent: 'projection', dimensions: [{ field: 'Name' }, { field: 'Country' }, { field: 'Age' }], metrics: [], sort: [{ field: 'Age', dir: 'desc' }] }),
        );
        const projectionSQL = compileAnalyticalIRToSQL(projection).sql || '';
        expect(projectionSQL).not.toMatch(/\b(?:SUM|AVG|COUNT)\s*\(/i);
        expect(projectionSQL).not.toMatch(/\bLIMIT\b/i);
        expect(projectionSQL).toContain('ORDER BY "Age" DESC');
    });

    it('compiles qualifying groups directly instead of returning repeated detail rows', () => {
        const grades = irFor(
            'Which grades have 4 or more high schoolers?',
            plan({
                intent: 'aggregate_filter',
                dimensions: [{ field: 'grade' }],
                metrics: [{ field: 'ID', agg: 'count' }],
                filters: [{ field: 'ID', op: '>=', value: 4, isHaving: true }],
            }),
        );
        const compiled = compileAnalyticalIRToSQL(grades);
        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain('SELECT');
        expect(compiled.sql).toContain('"grade"');
        expect(compiled.sql).toContain('GROUP BY "grade"');
        expect(compiled.sql).toMatch(/HAVING COUNT\("ID"\) >= 4/);
        expect(compiled.sql).not.toMatch(/WHERE\s+"grade"\s+IN/i);
    });
});
