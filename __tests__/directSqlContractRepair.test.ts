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

  it('fails closed when the focused repair still violates the contract', async () => {
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

    expect(result.blocked).toBe(true);
    expect(result.error).toContain('after repair');
  });
});
