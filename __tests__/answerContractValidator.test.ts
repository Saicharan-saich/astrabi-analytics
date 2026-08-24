import { describe, expect, it } from 'vitest';
import { validateAnswerContract } from '../services/ai-sql/answerContractValidator';

const model: any = {
  fields: [
    { name: 'sales', role: 'metric', semanticType: 'currency' },
    { name: 'CountryName', role: 'dimension', semanticType: 'category' },
  ],
  compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 15, grain: 'record',
};

const plan: any = {
  intent: 'single_metric', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }],
  filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'one row per record', originalQuestion: '',
};

describe('answer contract validation', () => {
  it('uses the final AI query contract instead of a fragmented local draft', () => {
    const result = validateAnswerContract(
      plan,
      'SELECT CountryName FROM countries',
      [{ CountryName: 'germany' }, { CountryName: 'france' }],
      'table',
      'missing_chart_key',
      'another_missing_chart_key',
      model,
      undefined,
      { expectedResult: { grain: 'one row per country', columns: ['CountryName'] } },
    );

    expect(result.passed).toBe(true);
    expect(result.checks.find(check => check.id === 'metrics_present')?.status).toBe('pass');
    expect(result.checks.find(check => check.id === 'chart_matches_data')?.status).toBe('warn');
  });

  it('normalizes shorthand contract fields instead of making validation unavailable', () => {
    const shorthandContract = {
      expectedResult: { columns: [{ field: 'CountryName' }] },
      operations: {
        groupBy: ['CountryName'],
        filters: ['Continent = europe'],
      },
    } as any;

    expect(() => validateAnswerContract(
      plan,
      "SELECT CountryName FROM countries WHERE Continent = 'europe' GROUP BY CountryName",
      [{ CountryName: 'germany' }],
      'table',
      'CountryName',
      'CountryName',
      model,
      undefined,
      shorthandContract,
    )).not.toThrow();
  });

  it('recognises equivalent predicates across aliases, casts, and BETWEEN syntax', () => {
    const result = validateAnswerContract(
      plan,
      `SELECT SUM(d.sales) AS total_sales
       FROM data d
       WHERE CAST(d.order_date AS DATE) BETWEEN DATE '2017-01-01' AND DATE '2017-12-31'`,
      [{ total_sales: 100 }],
      'kpiCard',
      'total_sales',
      'total_sales',
      model,
      undefined,
      {
        expectedResult: { columns: ['total_sales'] },
        operations: {
          filters: [{ expression: 'CAST(data.order_date AS DATE) >= DATE 2017-01-01' }],
        },
      },
    );

    expect(result.checks.find(check => check.id === 'conditions_applied')).toMatchObject({ status: 'pass' });
  });

  it('still fails a genuinely missing governed predicate', () => {
    const result = validateAnswerContract(
      plan,
      'SELECT SUM(sales) AS total_sales FROM data',
      [{ total_sales: 100 }],
      'kpiCard',
      'total_sales',
      'total_sales',
      model,
      undefined,
      { operations: { filters: [{ field: 'region', operator: '=', value: 'North' }] } },
    );

    expect(result.checks.find(check => check.id === 'conditions_applied')).toMatchObject({ status: 'fail' });
  });
});
