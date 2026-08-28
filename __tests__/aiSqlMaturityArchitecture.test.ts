import { describe, expect, it } from 'vitest';
import { chooseBestSQLCandidate } from '../services/ai-sql/directSqlEngine';
import { buildQueryContract, validateSQLAgainstContract } from '../services/ai-sql/queryContract';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

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
  distinctCount: 10,
  hasNulls: false,
});

function model(fields: any[]): SemanticModel {
  return {
    datasetName: 'data',
    rowCount: 100,
    grain: 'one row per record',
    compositeMetrics: [],
    derivedMetrics: [],
    fields,
  };
}

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
  return {
    intent: 'projection',
    dimensions: [],
    metrics: [],
    filters: [],
    sort: [],
    limit: null,
    ambiguous: false,
    resultGrain: 'one row per record',
    originalQuestion: '',
    ...overrides,
  };
}

describe('mature compositional AI SQL contracts', () => {
  it('keeps schema-grounded row filters without leaking them into the output grain', () => {
    const semanticModel = model([
      field('league_name', 'dimension'),
      field('country', 'dimension'),
    ]);
    const contract = buildQueryContract(
      'Please list the leagues from Germany.',
      plan({
        dimensions: [{ field: 'league_name' }],
        projectionFields: ['league_name'],
        filters: [{ field: 'country', op: '=', value: 'Germany' }],
      }),
      [],
      semanticModel,
    );

    expect(contract.requiredPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'country', operator: '=', value: 'Germany', scope: 'where', confidence: 'high' }),
    ]));
    expect(validateSQLAgainstContract('SELECT league_name FROM data', contract).map(issue => issue.code))
      .toContain('missing_filter');
    expect(validateSQLAgainstContract("SELECT league_name FROM data WHERE country = 'Germany'", contract))
      .toEqual([]);
  });

  it('validates the ranking expression rather than accepting any ORDER BY', () => {
    const semanticModel = model([
      field('product_name', 'dimension'),
      field('sales', 'metric', 'currency'),
      field('profit', 'metric', 'currency'),
    ]);
    const contract = buildQueryContract(
      'Which product has the highest total sales?',
      plan({
        intent: 'ranking',
        dimensions: [{ field: 'product_name' }],
        metrics: [{ field: 'sales', agg: 'sum' }],
        sort: [{ field: 'sales', dir: 'desc' }],
        limit: 1,
      }),
      [],
      semanticModel,
    );

    expect(contract.rankingTarget).toMatchObject({
      mode: 'group_aggregate', field: 'sales', aggregation: 'sum', confidence: 'high',
    });
    const wrong = 'SELECT product_name, SUM(sales) AS total_sales, SUM(profit) AS total_profit FROM data GROUP BY product_name ORDER BY total_profit DESC LIMIT 1';
    expect(validateSQLAgainstContract(wrong, contract).map(issue => issue.code))
      .toContain('wrong_ranking_target');
    const correct = 'SELECT product_name, SUM(sales) AS total_sales FROM data GROUP BY product_name ORDER BY total_sales DESC LIMIT 1';
    expect(validateSQLAgainstContract(correct, contract)).toEqual([]);
  });

  it('retains a simpler faithful draft when a reviewer changes the ranking target', () => {
    const semanticModel = model([
      field('product_name', 'dimension'),
      field('sales', 'metric', 'currency'),
      field('profit', 'metric', 'currency'),
    ]);
    const contract = buildQueryContract(
      'Which product has the highest total sales?',
      plan({
        intent: 'ranking',
        dimensions: [{ field: 'product_name' }],
        metrics: [{ field: 'sales', agg: 'sum' }],
        sort: [{ field: 'sales', dir: 'desc' }],
        limit: 1,
      }),
      [],
      semanticModel,
    );
    const draft = 'SELECT product_name, SUM(sales) AS total_sales FROM data GROUP BY product_name ORDER BY total_sales DESC LIMIT 1';
    const review = 'SELECT product_name, SUM(sales) AS total_sales, SUM(profit) AS total_profit FROM data GROUP BY product_name ORDER BY total_profit DESC LIMIT 1';

    expect(chooseBestSQLCandidate(draft, review, contract)).toMatchObject({ source: 'draft', sql: draft, contractErrors: 0 });
    expect(chooseBestSQLCandidate(review, draft, contract)).toMatchObject({ source: 'review', sql: draft, contractErrors: 0 });
  });

  it('does not require every table merely because a physical column name is duplicated', () => {
    const semanticModel = model([
      field('Name', 'dimension'),
      field('Course_ID', 'metric', 'count'),
    ]);
    const schema = {
      tables: [
        { name: 'teacher', rowCount: 10, columns: [{ name: 'Teacher_ID', isPK: true }, { name: 'Name' }] },
        { name: 'course_arrange', rowCount: 20, columns: [{ name: 'Teacher_ID' }, { name: 'Course_ID', isPK: true }] },
        { name: 'audit_log', rowCount: 50, columns: [{ name: 'Audit_ID', isPK: true }, { name: 'Name' }] },
      ],
      links: [
        { leftTable: 'course_arrange', leftColumn: 'Teacher_ID', rightTable: 'teacher', rightColumn: 'Teacher_ID', type: 'fk' as const },
      ],
    };
    const contract = buildQueryContract(
      'What are the names of the teachers and how many courses do they teach?',
      plan({
        intent: 'breakdown',
        dimensions: [{ field: 'Name' }],
        metrics: [{ field: 'Course_ID', agg: 'count' }],
      }),
      [],
      semanticModel,
      schema,
    );

    expect(contract.requiredTables).toEqual(expect.arrayContaining(['teacher', 'course_arrange']));
    expect(contract.requiredTables).not.toContain('audit_log');
  });

  it('preserves two independent rankings and their set difference as a compositional contract', () => {
    const semanticModel = model([
      { ...field('city', 'dimension'), synonyms: ['cities'] },
      { ...field('amount', 'metric', 'currency'), displayLabel: 'Sales Amount', synonyms: ['sales'] },
      { ...field('profit', 'metric', 'currency'), synonyms: ['profit'] },
    ]);
    const question = 'Which cities are in the top 10 by sales but not in the top 10 by profit?';
    const contract = buildQueryContract(question, plan({
      intent: 'ranking',
      dimensions: [{ field: 'city' }],
      metrics: [{ field: 'profit', agg: 'sum' }],
      sort: [{ field: 'profit', dir: 'desc' }],
      limit: 10,
    }), [], semanticModel);

    expect(contract.rankedSetOperation).toEqual({
      operation: 'difference',
      entityField: 'city',
      branches: [
        { metricField: 'amount', aggregation: 'sum', direction: 'desc', limit: 10 },
        { metricField: 'profit', aggregation: 'sum', direction: 'desc', limit: 10 },
      ],
    });

    const collapsed = 'SELECT city FROM data GROUP BY city ORDER BY SUM(profit) DESC LIMIT 10';
    expect(validateSQLAgainstContract(collapsed, contract).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'missing_ranked_set_branch',
      'missing_ranked_set_operation',
      'missing_aggregation',
    ]));

    const composed = `WITH sales_top AS (
      SELECT city FROM data GROUP BY city ORDER BY SUM(amount) DESC LIMIT 10
    ), profit_top AS (
      SELECT city FROM data GROUP BY city ORDER BY SUM(profit) DESC LIMIT 10
    )
    SELECT city FROM sales_top
    EXCEPT
    SELECT city FROM profit_top`;
    expect(validateSQLAgainstContract(composed, contract)).toEqual([]);
  });
});
