import { describe, expect, it } from 'vitest';
import { executeQueryPlan } from '../services/queryPlan/executeQueryPlan';
import type { QueryPlan } from '../services/queryPlan/types';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';
import { applyTableCalculation } from '../utils/tableCalculations';

const plan: QueryPlan = {
  source: 'data',
  dimensions: [{ type: 'column', column: 'status' }],
  metrics: [{
    id: 'failure-count',
    alias: 'count_failure_reason',
    expression: { type: 'column', column: 'failure_reason' },
    aggregation: 'COUNT',
  }],
  filters: { row: [], range: [], date: [], group: [] },
  orderBy: [{ type: 'metric', metricId: 'failure-count', direction: 'DESC' }],
};

describe('QueryPlan COUNT over imported text columns', () => {
  it('maps the Builder Count option to a row count while preserving its label', () => {
    const builderPlan = buildQueryPlan(
      { metric: 'failure_reason', aggregation: 'COUNT', dimension: 'status' },
      '',
      getDates('2026-01-01'),
      'data',
    );
    const result = executeQueryPlan(builderPlan, [
      { status: 'pass', failure_reason: '' },
      { status: 'pass', failure_reason: null },
      { status: 'wrong_result', failure_reason: 'Expected 2 rows' },
    ]);

    expect(builderPlan.metrics[0].aggregation).toBe('COUNT_ALL');
    expect(result.yKey).toBe('count_failure_reason');
    expect(result.data).toEqual([
      { status: 'pass', count_failure_reason: 2 },
      { status: 'wrong_result', count_failure_reason: 1 },
    ]);
    expect(compileSQL(builderPlan)).toContain('COUNT(*)');
  });

  it('counts non-null text values by dimension and skips blank cells', () => {
    const rows = [
      { status: 'wrong_result', failure_reason: 'Expected 2 rows' },
      { status: 'wrong_result', failure_reason: 'Expected 1 row' },
      { status: 'execution_error', failure_reason: 'Binder error' },
      { status: 'pass', failure_reason: '' },
      { status: 'pass', failure_reason: null },
    ];

    const result = executeQueryPlan(plan, rows);

    expect(result.xKey).toBe('status');
    expect(result.yKey).toBe('count_failure_reason');
    expect(result.data).toEqual([
      { status: 'wrong_result', count_failure_reason: 2 },
      { status: 'execution_error', count_failure_reason: 1 },
      { status: 'pass', count_failure_reason: 0 },
    ]);
  });

  it('calculates percent of total from those counts and marks it as percent', () => {
    const result = executeQueryPlan(plan, [
      { status: 'wrong_result', failure_reason: 'one' },
      { status: 'wrong_result', failure_reason: 'two' },
      { status: 'execution_error', failure_reason: 'three' },
    ]);

    const calculated = applyTableCalculation(
      result.data,
      result.yKey,
      'percent_of_total',
      'COUNT of failure_reason',
    );

    expect(calculated.suggestedNumberFormat).toBe('percent');
    expect(calculated.transformedData[0].count_failure_reason).toBeCloseTo(66.6667, 3);
    expect(calculated.transformedData[1].count_failure_reason).toBeCloseTo(33.3333, 3);
  });
});
