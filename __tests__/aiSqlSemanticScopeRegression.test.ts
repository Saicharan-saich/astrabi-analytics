import { describe, expect, it } from 'vitest';
import { enforceRequestedBreakdownDimension } from '../services/ai-sql/intentPlanner';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import type { AnalysisPlan, SemanticField, SemanticModel } from '../services/ai-sql/types';

function semanticField(overrides: Partial<SemanticField> & Pick<SemanticField, 'name'>): SemanticField {
    return {
        displayLabel: overrides.name,
        physicalType: 'string',
        semanticType: 'category',
        role: 'dimension',
        defaultAgg: 'none',
        timeGrainSupport: [],
        synonyms: [],
        valueDescriptors: [],
        distinctCount: 3,
        hasNulls: false,
        ...overrides,
    };
}

function semanticModel(fields: SemanticField[], name = 'data'): SemanticModel {
    return {
        datasetName: name,
        rowCount: 100,
        grain: 'one row per record',
        compositeMetrics: [],
        derivedMetrics: [],
        fields,
    };
}

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'single_metric',
        dimensions: [],
        metrics: [],
        filters: [],
        sort: [],
        limit: null,
        ambiguous: false,
        resultGrain: 'one row',
        originalQuestion: '',
        ...overrides,
    };
}

describe('AI SQL semantic grain and reference-population regressions', () => {
    it('grounds a compound grouping noun even when semantic roles are imperfect', () => {
        const petsModel = semanticModel([
            semanticField({ name: 'PetID', displayLabel: 'Pet ID', semanticType: 'identifier', synonyms: ['pet identifier'] }),
            // Deliberately wrong role: exact language/schema matching must still
            // recover PetType as the requested grouping.
            semanticField({ name: 'PetType', displayLabel: 'Pet Type', role: 'metric', defaultAgg: 'count', synonyms: ['type of pet'], distinctCount: 2 }),
            semanticField({ name: 'pet_age', displayLabel: 'Pet Age', physicalType: 'number', semanticType: 'quantity', synonyms: ['age of pet'] }),
            semanticField({ name: 'weight', displayLabel: 'Weight', physicalType: 'number', semanticType: 'quantity', role: 'metric', defaultAgg: 'avg', synonyms: ['pet weight'] }),
        ], 'Pets');
        const question = 'What is the average weight for each type of pet?';
        const wrongDraft = plan({
            intent: 'breakdown',
            dimensions: [{ field: 'pet_age' }],
            metrics: [{ field: 'weight', agg: 'avg' }],
            resultGrain: 'one row per pet_age',
        });

        enforceRequestedBreakdownDimension(wrongDraft, question, petsModel);
        expect(wrongDraft.dimensions).toEqual([{ field: 'PetType' }]);

        const contract = buildQueryContract(question, wrongDraft, [], petsModel);
        expect(contract.requiredDimension).toBe('PetType');
        expect(contract.outputEntity).toMatchObject({ field: 'PetType', confidence: 'high' });
        expect(validateSQLAgainstContract(
            'SELECT PetType, AVG(weight) AS average_weight FROM data GROUP BY PetType',
            contract,
        )).toEqual([]);
        expect(validateSQLAgainstContract(
            'SELECT pet_age, AVG(weight) AS average_weight FROM data GROUP BY pet_age',
            contract,
        ).map(issue => issue.code)).toContain('missing_requested_dimension');
    });

    it('requires a relative average to inherit the filtered cohort and strict boundary', () => {
        const clinicalModel = semanticModel([
            semanticField({ name: 'Thrombosis', physicalType: 'number', semanticType: 'ordinal', synonyms: ['thrombosis level'] }),
            semanticField({ name: 'ANA Pattern', synonyms: ['ANA'] }),
            semanticField({ name: 'aCL IgM', physicalType: 'number', semanticType: 'quantity', role: 'metric', defaultAgg: 'avg', synonyms: ['anti Cardiolipin antibody IgM'], distinctCount: 80 }),
        ], 'Examination');
        const question = 'What number of patients with thrombosis level 2 and ANA pattern S have aCL IgM 20% higher than average?';
        const filteredPlan = plan({
            metrics: [{ field: 'aCL IgM', agg: 'count' }],
            filters: [
                { field: 'Thrombosis', op: '=', value: 2 },
                { field: 'ANA Pattern', op: '=', value: 'S' },
            ],
        });
        const contract = buildQueryContract(question, filteredPlan, [], clinicalModel);

        expect(contract.relativeComparison).toMatchObject({
            scope: 'row_to_filtered_average',
            referencePopulation: 'filtered_cohort',
            comparator: '>',
            multiplier: 1.2,
            measureField: 'aCL IgM',
        });
        const wrong = `SELECT COUNT(*) AS patient_count FROM data
            WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'
              AND "aCL IgM" >= 1.2 * (SELECT AVG("aCL IgM") FROM data)`;
        expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
            .toEqual(expect.arrayContaining(['wrong_comparison_scope', 'missing_comparator']));
        const wrongMeasure = `SELECT COUNT(*) AS patient_count FROM data
            WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'
              AND "aCL IgM" > (
                SELECT AVG(Thrombosis) * 1.2 FROM data
                WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'
              )`;
        expect(validateSQLAgainstContract(wrongMeasure, contract).map(issue => issue.code))
            .toContain('wrong_comparison_scope');

        const correct = `SELECT COUNT(*) AS patient_count FROM data
            WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'
              AND "aCL IgM" > (
                SELECT AVG("aCL IgM") * 1.2 FROM data
                WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'
              )`;
        expect(validateSQLAgainstContract(correct, contract)).toEqual([]);
    });

    it('keeps the reference population global only when wording says overall', () => {
        const salesModel = semanticModel([
            semanticField({ name: 'category' }),
            semanticField({ name: 'product_name', synonyms: ['product'] }),
            semanticField({ name: 'sales', physicalType: 'number', semanticType: 'currency', role: 'metric', defaultAgg: 'sum' }),
        ]);
        const question = 'Which Office products have sales 20% higher than the overall average?';
        const contract = buildQueryContract(
            question,
            plan({ filters: [{ field: 'category', op: '=', value: 'Office' }] }),
            [],
            salesModel,
        );
        expect(contract.relativeComparison).toMatchObject({
            scope: 'row_to_global_average',
            referencePopulation: 'global',
            comparator: '>',
            multiplier: 1.2,
            inheritedFilters: [],
        });
    });
});
