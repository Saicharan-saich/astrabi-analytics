import { describe, expect, it } from 'vitest';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import { buildCanonicalQueryIntent } from '../services/ai-sql/canonicalIntent';
import {
    buildAnalyticalIR,
    verifyAnalyticalIR,
} from '../services/ai-sql/analyticalIR';
import { reconcileQuerySpecWithAnalyticalIR, type DynamicQuerySpec } from '../services/ai-sql/directSqlEngine';
import { validateAnalyticalResult } from '../services/ai-sql/analyticalResultValidator';
import { compileAnalyticalIRToSQL } from '../services/ai-sql/analyticalSqlAst';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { processPlan } from '../services/ai-sql/derivedMetricEngine';

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

    it('preserves a word-number Top N, multiple physical measures, and a governed KPI', () => {
        const customerModel: SemanticModel = {
            datasetName: 'data',
            rowCount: 100,
            grain: 'one row per order line',
            derivedMetrics: [],
            fields: [
                { ...field('order_id', 'dimension', 'identifier'), role: 'dimension', defaultAgg: 'none' },
                { ...field('customer_name', 'dimension'), synonyms: ['customer', 'customers'] },
                { ...field('amount', 'metric', 'currency'), displayLabel: 'Sales Amount', synonyms: ['sales', 'total sales', 'revenue'] },
                { ...field('profit', 'metric', 'currency'), displayLabel: 'Profit', synonyms: ['total profit'] },
            ],
            compositeMetrics: [{
                id: 'net_profit_margin_pct',
                label: 'Net Profit Margin %',
                formula: 'SUM(profit) / NULLIF(SUM(amount), 0) * 100',
                dependsOn: ['profit', 'amount'],
                semanticType: 'percentage',
                preAggregated: true,
                description: 'Profit as a percentage of sales',
                synonyms: ['profit margin', 'net margin', 'profit pct'],
            }],
        };
        const question = 'Which five customers generated the highest total sales, and what were their total profit and profit margin?';
        const localPlan = generateLocalPlan(question, customerModel);
        const contract = buildQueryContract(question, localPlan, [], customerModel);
        const canonical = buildCanonicalQueryIntent(contract);
        const ir = buildAnalyticalIR(question, localPlan, customerModel, contract, canonical);
        const compiled = compileAnalyticalIRToSQL(ir);

        expect(localPlan.limit).toBe(5);
        expect(localPlan.dimensions).toEqual([{ field: 'customer_name' }]);
        expect(localPlan.metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'amount', agg: 'sum' }),
            expect.objectContaining({ field: 'profit', agg: 'sum' }),
            expect.objectContaining({ compositeId: 'net_profit_margin_pct' }),
        ]));
        expect(contract.rankingLimit).toBe(5);
        expect(contract.expectedMeasures).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'amount', aggregation: 'sum' }),
            expect.objectContaining({ field: 'profit', aggregation: 'sum' }),
        ]));
        expect(contract.expectedComputedMetrics?.map(metric => metric.id)).toEqual(['net_profit_margin_pct']);
        expect(validateSQLAgainstContract(
            'SELECT customer_name FROM data GROUP BY customer_name ORDER BY SUM(amount) DESC LIMIT 1',
            contract,
        ).filter(issue => issue.severity === 'error').map(issue => issue.code)).toEqual(expect.arrayContaining([
            'missing_ranking', 'missing_aggregation',
        ]));
        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain('SUM("amount") AS "sum_amount"');
        expect(compiled.sql).toContain('SUM("profit") AS "sum_profit"');
        expect(compiled.sql).toContain('SUM(profit) / NULLIF(SUM(amount), 0) * 100 AS "net_profit_margin_pct"');
        expect(compiled.sql).toContain('ORDER BY SUM("amount") DESC');
        expect(compiled.sql).toContain('LIMIT 5');
        expect(validateAnalyticalResult([{ customer_name: 'A' }], ir).map(issue => issue.code))
            .toContain('missing_visible_calculation');
    });

    it('enriches derived duration metrics before IR freeze without mutating the draft plan', () => {
        const durationModel: SemanticModel = {
            datasetName: 'data',
            rowCount: 20,
            grain: 'one row per delivery',
            compositeMetrics: [],
            derivedMetrics: [],
            fields: [
                { ...field('product_name', 'dimension'), synonyms: ['product', 'products'] },
                { ...field('order date', 'dimension', 'date'), physicalType: 'date', semanticType: 'date' },
                { ...field('delivery date', 'dimension', 'date'), physicalType: 'date', semanticType: 'date' },
            ],
        };
        const draft = plan({
            intent: 'breakdown',
            dimensions: [{ field: 'product_name' }],
            metrics: [{ field: 'delivery date', agg: 'avg' }],
            originalQuestion: 'What is the average delivery time for each product?',
        });

        const enriched = processPlan(draft, durationModel);
        expect(draft.metrics).toEqual([{ field: 'delivery date', agg: 'avg' }]);
        expect(enriched.plan.metrics[0]).toMatchObject({ derivedMetricId: 'date_diff' });
        const contract = buildQueryContract(draft.originalQuestion, enriched.plan, [], durationModel);
        const canonical = buildCanonicalQueryIntent(contract);
        const ir = buildAnalyticalIR(
            draft.originalQuestion,
            enriched.plan,
            durationModel,
            contract,
            canonical,
            enriched.derivedMetrics,
        );
        const compiled = compileAnalyticalIRToSQL(ir);

        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain(`AVG(DATE_DIFF('day', "order date", "delivery date"))`);
        expect(compiled.sql).toContain('GROUP BY "product_name"');
        expect(compiled.sql).not.toContain('JULIANDAY');
    });

    it('compiles numerator and denominator populations for conditional percentages', () => {
        const question = 'What percentage of loan amount has status A?';
        const draft = plan({
            intent: 'conditional_percentage',
            metrics: [{ field: 'amount', agg: 'sum' }],
            filters: [{ field: 'status', op: '=', value: 'A' }],
            originalQuestion: question,
        });
        const contract = buildQueryContract(question, draft, [], model);
        const canonical = buildCanonicalQueryIntent(contract);
        const ir = buildAnalyticalIR(question, draft, model, contract, canonical);
        const compiled = compileAnalyticalIRToSQL(ir);

        expect(contract.ratio).toMatchObject({
            basis: 'measure',
            measureField: 'amount',
            denominatorFilters: [],
            numeratorFilters: [{ field: 'status', op: '=', value: 'A' }],
        });
        expect(ir.operators.some(operator => operator.kind === 'filter')).toBe(false);
        expect(verifyAnalyticalIR(ir)).toEqual([]);
        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain(`SUM(CASE WHEN "status" = 'A' THEN "amount" ELSE 0 END)`);
        expect(compiled.sql).toContain('NULLIF(SUM("amount"), 0)');
        expect(compiled.sql).toContain('AS "percentage"');
        expect(compiled.sql).not.toContain('WHERE "status"');
        expect(validateSQLAgainstContract(compiled.sql!, contract).filter(issue => issue.severity === 'error')).toEqual([]);
    });

    it('compiles a row value against the average of the same filtered cohort', () => {
        const cohortModel: SemanticModel = {
            datasetName: 'data',
            rowCount: 100,
            grain: 'one row per patient',
            compositeMetrics: [],
            derivedMetrics: [],
            fields: [
                field('Thrombosis', 'dimension'),
                field('ANA Pattern', 'dimension'),
                field('aCL IgM', 'metric'),
            ],
        };
        const question = 'What number of patients with Thrombosis 2 and ANA Pattern S have aCL IgM 20% higher than average?';
        const draft = plan({
            intent: 'aggregate_filter',
            metrics: [{ field: '*', agg: 'count' }],
            filters: [
                { field: 'Thrombosis', op: '=', value: 2 },
                { field: 'ANA Pattern', op: '=', value: 'S' },
                { field: 'aCL IgM', op: 'above_avg', value: null, isHaving: true },
            ],
            originalQuestion: question,
        });
        const contract = buildQueryContract(question, draft, [], cohortModel);
        const canonical = buildCanonicalQueryIntent(contract);
        const ir = buildAnalyticalIR(question, draft, cohortModel, contract, canonical);
        const compiled = compileAnalyticalIRToSQL(ir);

        expect(contract.relativeComparison).toMatchObject({
            scope: 'row_to_filtered_average',
            comparator: '>',
            multiplier: 1.2,
            measureField: 'aCL IgM',
        });
        expect(compiled.supported).toBe(true);
        expect(compiled.sql).toContain('"Thrombosis" = 2');
        expect(compiled.sql).toContain(`"ANA Pattern" = 'S'`);
        expect(compiled.sql).toContain(`"aCL IgM" > 1.2 * (SELECT AVG("aCL IgM") FROM "data" WHERE "Thrombosis" = 2 AND "ANA Pattern" = 'S')`);
        expect(validateSQLAgainstContract(compiled.sql!, contract).filter(issue => issue.severity === 'error')).toEqual([]);
    });
});
