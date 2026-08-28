import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ai-sql/modelConfig', () => ({
  fetchWithFallback: vi.fn(),
  LUNA_MODEL: 'luna',
  PLANNER_MODEL: 'terra',
  SOL_MODEL: 'sol',
}));

import { fetchWithFallback } from '../services/ai-sql/modelConfig';
import { generateDirectSQL } from '../services/ai-sql/directSqlEngine';
import type { QueryContract } from '../services/ai-sql/queryContract';

const mockedFetch = vi.mocked(fetchWithFallback);

const contract: QueryContract = {
  requirements: ['Use AVG semantics for the requested measure.'],
  expectedCardinality: 'scalar',
  requiresGrouping: false,
  requiresFiscalCalendar: false,
  requiresRanking: false,
  selectionMode: 'unspecified',
  prohibitsImplicitLimit: false,
  requiresDistinctProjection: false,
  requiredOutputFields: [],
  uniqueResultFields: [],
  allowedGroupingFields: [],
  strictOutputProjection: false,
  forbiddenOutputFields: [],
  requiresRowProjection: false,
  requiresComparison: false,
  requiredTables: [],
  relationshipPath: [],
  existenceMode: 'none',
  relationshipMode: 'none',
  expectedAggregation: 'avg',
};

function response(content: string, model: string, tokens = 10): any {
  return {
    model,
    data: {
      choices: [{ message: { content } }],
      usage: { total_tokens: tokens },
    },
  };
}

describe('direct SQL query-contract repair', () => {
  beforeEach(() => mockedFetch.mockReset());

  it('repairs a contract violation before returning executable SQL', async () => {
    mockedFetch
      .mockResolvedValueOnce(response(JSON.stringify({
        goal: 'Average sales',
        operations: { measures: [{ field: 'sales', aggregation: 'avg' }] },
        expectedResult: { grain: 'one row', columns: ['average_sales'] },
        assumptions: [],
      }), 'terra'))
      .mockResolvedValueOnce(response('SELECT SUM(sales) AS average_sales FROM data', 'luna'))
      .mockResolvedValueOnce(response('SELECT SUM(sales) AS average_sales FROM data', 'sol'))
      .mockResolvedValueOnce(response('SELECT AVG(sales) AS average_sales FROM data', 'sol'));

    const result = await generateDirectSQL(
      'What is the average sales?',
      'Table data: sales DOUBLE',
      undefined,
      undefined,
      undefined,
      'benchmark',
      contract,
    );

    expect(result.error).toBeUndefined();
    expect(result.sql).toContain('AVG(sales)');
    expect(result.tokens).toBe(40);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it('retains safe read-only SQL with advisory warnings when focused repair still violates the contract', async () => {
    mockedFetch
      .mockResolvedValueOnce(response(JSON.stringify({
        goal: 'Average sales',
        operations: { measures: [{ field: 'sales', aggregation: 'avg' }] },
        expectedResult: { grain: 'one row', columns: ['average_sales'] },
        assumptions: [],
      }), 'terra'))
      .mockResolvedValueOnce(response('SELECT SUM(sales) FROM data', 'luna'))
      .mockResolvedValueOnce(response('SELECT SUM(sales) FROM data', 'sol'))
      .mockResolvedValueOnce(response('SELECT SUM(sales) FROM data', 'sol'));

    const result = await generateDirectSQL(
      'What is the average sales?',
      'Table data: sales DOUBLE',
      undefined,
      undefined,
      undefined,
      'benchmark',
      contract,
    );

    expect(result.blocked).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.sql).toContain('SUM(sales)');
    expect(result.contractWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining('requires AVG semantics'),
    ]));
  });

  it('keeps the model-authored compositional plan instead of canonicalising it to one ranking', async () => {
    const rankedContract: QueryContract = {
      ...contract,
      requirements: ['Build two independent rankings and subtract the second population from the first.'],
      expectedCardinality: 'grouped',
      requiresGrouping: true,
      requiresRanking: true,
      selectionMode: 'top_n',
      requiredOutputFields: [{ table: 'data', field: 'city', confidence: 'high' }],
      strictOutputProjection: true,
      forbiddenOutputFields: ['amount', 'profit'],
      uniqueResultFields: ['city'],
      allowedGroupingFields: ['city'],
      requiredDimension: 'city',
      rankingLimit: 10,
      rankingDirection: 'desc',
      expectedAggregation: 'sum',
      expectedAggregations: ['sum'],
      expectedMeasures: [
        { field: 'amount', aggregation: 'sum', confidence: 'high' },
        { field: 'profit', aggregation: 'sum', confidence: 'high' },
      ],
      rankedSetOperation: {
        operation: 'difference',
        entityField: 'city',
        branches: [
          { metricField: 'amount', aggregation: 'sum', direction: 'desc', limit: 10 },
          { metricField: 'profit', aggregation: 'sum', direction: 'desc', limit: 10 },
        ],
      },
    };
    const spec = {
      goal: 'Cities in sales top ten but outside profit top ten',
      operations: {
        rankedSets: {
          operation: 'difference',
          entity: 'city',
          branches: [
            { metric: 'amount', aggregation: 'sum', direction: 'desc', limit: 10 },
            { metric: 'profit', aggregation: 'sum', direction: 'desc', limit: 10 },
          ],
        },
      },
      expectedResult: { grain: 'one row per city', columns: ['city'] },
      assumptions: [],
    };
    const sql = `WITH sales_top AS (SELECT city FROM data GROUP BY city ORDER BY SUM(amount) DESC LIMIT 10),
      profit_top AS (SELECT city FROM data GROUP BY city ORDER BY SUM(profit) DESC LIMIT 10)
      SELECT city FROM sales_top EXCEPT SELECT city FROM profit_top`;
    mockedFetch
      .mockResolvedValueOnce(response(JSON.stringify(spec), 'terra'))
      .mockResolvedValueOnce(response(sql, 'luna'))
      .mockResolvedValueOnce(response(sql, 'sol'));

    const result = await generateDirectSQL(
      'Which cities are in the top 10 by sales but not in the top 10 by profit?',
      'Table data(city VARCHAR, amount DOUBLE, profit DOUBLE)',
      undefined,
      undefined,
      undefined,
      'benchmark',
      rankedContract,
    );

    expect(result.error).toBeUndefined();
    expect(result.sql).toBe(sql);
    expect(result.querySpec?.operations.rankedSets?.branches).toHaveLength(2);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });
});
