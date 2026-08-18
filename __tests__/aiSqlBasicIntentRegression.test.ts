import { describe, expect, it } from 'vitest';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import type { SemanticModel } from '../services/ai-sql/types';

const field = (
  name: string,
  role: 'metric' | 'dimension',
  semanticType: any,
  synonyms: string[] = [],
): any => ({
  name,
  displayLabel: name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' '),
  physicalType: role === 'metric' ? 'number' : 'string',
  semanticType,
  role,
  defaultAgg: role === 'metric' ? 'sum' : 'none',
  timeGrainSupport: [],
  synonyms,
  valueDescriptors: [],
  distinctCount: 12,
  hasNulls: false,
});

const baseModel = (fields: any[]): SemanticModel => ({
  datasetName: 'data',
  rowCount: 12,
  grain: 'one row per record',
  fields,
  compositeMetrics: [],
  derivedMetrics: [],
});

describe('basic semantic intent regressions', () => {
  it('keeps an ascending list as an unbounded row projection', () => {
    const model = baseModel([
      field('Conductor_ID', 'dimension', 'identifier'),
      field('Name', 'dimension', 'category', ['conductor name']),
      field('Age', 'metric', 'quantity'),
      field('Nationality', 'dimension', 'category'),
      field('Year_of_Work', 'metric', 'quantity'),
    ]);
    const question = 'List the names of conductors in ascending order of age.';
    const plan = generateLocalPlan(question, model);

    expect(plan.intent).toBe('projection');
    expect(plan.projectionFields).toEqual(['Name']);
    expect(plan.metrics).toEqual([]);
    expect(plan.sort).toEqual([{ field: 'Age', dir: 'asc' }]);
    expect(plan.limit).toBeNull();
    expect(correctSQL(plan, model)).toBe('SELECT "Name"\nFROM "data"\nORDER BY "Age" ASC');

    const contract = buildQueryContract(question, plan, [], model);
    expect(contract.orderedProjection).toEqual({ fields: ['Name'], orderBy: 'Age', direction: 'asc', unbounded: true });
    expect(validateSQLAgainstContract(
      'SELECT Name, SUM(Age) AS total_age FROM data GROUP BY Name ORDER BY total_age DESC LIMIT 1',
      contract,
    ).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'unexpected_aggregation', 'unexpected_grouping', 'unexpected_limit', 'missing_ordering_field',
    ]));
    expect(validateSQLAgainstContract('SELECT Name FROM data ORDER BY Age ASC', contract)).toEqual([]);
  });

  it('grounds "type of pet" to PetType rather than pet_age', () => {
    const model = baseModel([
      field('PetID', 'dimension', 'identifier'),
      field('PetType', 'dimension', 'category', ['pet type']),
      field('pet_age', 'metric', 'quantity'),
      field('weight', 'metric', 'quantity'),
    ]);
    const question = 'What is the average weight for each type of pet?';
    const plan = generateLocalPlan(question, model);

    expect(plan.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'weight', agg: 'avg' })]));
    expect(plan.dimensions).toEqual([{ field: 'PetType' }]);
    const sql = correctSQL(plan, model);
    expect(sql).toMatch(/AVG\([^)]*"weight"/);
    expect(sql).toContain('GROUP BY "PetType"');
    expect(sql).not.toContain('GROUP BY "pet_age"');

    const contract = buildQueryContract(question, plan, [], model);
    expect(contract.requiredDimension).toBe('PetType');
    expect(validateSQLAgainstContract('SELECT pet_age, AVG(weight) FROM data GROUP BY pet_age', contract)
      .map(issue => issue.code)).toContain('missing_requested_dimension');
    expect(validateSQLAgainstContract('SELECT PetType, AVG(weight) FROM data GROUP BY PetType', contract)).toEqual([]);
  });
});
