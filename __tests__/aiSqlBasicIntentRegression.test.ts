import { describe, expect, it } from 'vitest';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { buildQueryContract, validateResultAgainstContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import { canCompileTotalPeriodComparisonLocally } from '../services/ai-sql/deterministicRouting';
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

  it('keeps MAX per group as all groups instead of a top-one ranking', () => {
    const model = baseModel([
      field('Singer_ID', 'dimension', 'identifier'),
      field('Name', 'dimension', 'category'),
      field('Net_Worth_Millions', 'metric', 'currency', ['net worth']),
      field('Citizenship', 'dimension', 'category'),
    ]);
    const question = 'Show different citizenships and the maximum net worth of singers of each citizenship.';
    const plan = generateLocalPlan(question, model);

    expect(plan.intent).toBe('breakdown');
    expect(plan.dimensions).toEqual([{ field: 'Citizenship' }]);
    expect(plan.metrics).toEqual([{ field: 'Net_Worth_Millions', agg: 'max' }]);
    expect(plan.limit).toBeNull();
    const sql = correctSQL(plan, model);
    expect(sql).toContain('MAX(');
    expect(sql).toContain('GROUP BY "Citizenship"');
    expect(sql).not.toContain('LIMIT');

    const contract = buildQueryContract(question, plan, [], model);
    expect(contract.selectionMode).toBe('all_groups');
    expect(contract.requiresRanking).toBe(false);
    expect(validateSQLAgainstContract(
      'SELECT Citizenship, MAX(Net_Worth_Millions) FROM data GROUP BY Citizenship ORDER BY 2 DESC LIMIT 1',
      contract,
    ).map(issue => issue.code)).toContain('unexpected_limit');
  });

  it('projects every requested field for natural-language directional ordering', () => {
    const model = baseModel([
      field('Singer_ID', 'dimension', 'identifier'),
      field('Name', 'dimension', 'category'),
      field('Country', 'dimension', 'geography'),
      field('Age', 'metric', 'quantity'),
      field('Song_Name', 'dimension', 'category'),
    ]);
    const question = 'Show name, country, age for all singers ordered by age from the oldest to the youngest.';
    const plan = generateLocalPlan(question, model);

    expect(plan.intent).toBe('projection');
    expect(plan.projectionFields).toEqual(['Name', 'Country', 'Age']);
    expect(plan.sort).toEqual([{ field: 'Age', dir: 'desc' }]);
    expect(plan.limit).toBeNull();
    const sql = correctSQL(plan, model);
    expect(sql).toBe('SELECT "Name", "Country", "Age"\nFROM "data"\nORDER BY "Age" DESC');

    const contract = buildQueryContract(question, plan, [], model);
    expect(contract.selectionMode).toBe('all_rows');
    expect(validateSQLAgainstContract(
      'SELECT Country, SUM(Age) FROM data GROUP BY Country ORDER BY 2 ASC LIMIT 1',
      contract,
    ).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'unexpected_limit', 'unexpected_aggregation', 'unexpected_grouping', 'missing_ordering_field', 'missing_output_entity',
    ]));
  });

  it('keeps this-month versus last-month sales as a two-total comparison', () => {
    const model: SemanticModel = {
      ...baseModel([
        field('order_id', 'dimension', 'identifier'),
        field('order_date', 'dimension', 'date'),
        field('year_month', 'dimension', 'category'),
        field('amount', 'metric', 'currency', ['sales', 'revenue']),
      ]),
      timeContext: {
        primaryDateColumn: 'order_date',
        anchorDate: '2025-03-15',
        minDate: '2024-01-01',
        maxDate: '2025-03-15',
      },
    };
    const plan = generateLocalPlan('show the comparision between this month and last month sales', model);

    expect(plan.intent).toBe('total_comparison');
    expect(plan.comparison).toEqual(expect.objectContaining({
      type: 'previous_period',
      mode: 'total',
      grain: 'month',
    }));
    expect(plan.metrics).toEqual([expect.objectContaining({ field: 'amount', agg: 'sum' })]);
    expect(plan.dimensions).toEqual([]);
    expect(plan.filters).toContainEqual(expect.objectContaining({
      field: 'order_date',
      op: 'between',
      value: ['2025-03-01', '2025-03-31'],
    }));

    const sql = correctSQL(plan, model);
    expect(sql).toMatch(/^WITH periods/i);
    expect(sql).toMatch(/LAG\("amount_sum", 1\) OVER \(ORDER BY period_order\)/i);
    expect(sql).toContain('AS growth_pct');
    expect(sql).toContain("DATE '2025-02-01'");
    expect(sql).toContain("DATE '2025-02-28'");

    expect(canCompileTotalPeriodComparisonLocally(plan, model)).toBe(true);
    const contract = buildQueryContract('show the comparision between this month and last month sales', plan, [], model);
    expect(contract.outputEntity).toBeUndefined();
    expect(contract.requiredOutputFields).toEqual([]);
    expect(contract.resultRowExpectation).toEqual({ exact: 2, basis: 'period_comparison' });
    expect(validateSQLAgainstContract(
      `SELECT order_id,
              SUM(CASE WHEN order_date >= DATE '2025-03-01' THEN amount ELSE 0 END) AS this_month_sales,
              SUM(CASE WHEN order_date < DATE '2025-03-01' THEN amount ELSE 0 END) AS last_month_sales
       FROM data GROUP BY order_id`,
      contract,
    ).map(issue => issue.code)).toContain('unexpected_grouping');
    expect(validateResultAgainstContract(
      Array.from({ length: 6 }, (_, index) => ({ order_id: `B-${index}` })),
      contract,
    ).map(issue => issue.code)).toContain('unexpected_result_cardinality');
  });
});
