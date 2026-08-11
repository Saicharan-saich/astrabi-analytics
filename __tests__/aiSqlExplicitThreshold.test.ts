import { describe, expect, it } from 'vitest';
import { generateLocalPlan } from '../services/ai-sql/intentPlanner';
import { processPlan } from '../services/ai-sql/derivedMetricEngine';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import type { SemanticModel } from '../services/ai-sql/types';

const field = (
  name: string,
  role: 'metric' | 'dimension',
  semanticType: string,
  defaultAgg: 'sum' | 'none',
): any => ({
  name,
  displayLabel: name.replace(/_/g, ' '),
  physicalType: role === 'metric' ? 'number' : 'string',
  semanticType,
  role,
  defaultAgg,
  timeGrainSupport: [],
  synonyms: [],
  valueDescriptors: [],
  distinctCount: 3,
  hasNulls: false,
});

const model: SemanticModel = {
  datasetName: 'Retail',
  rowCount: 72,
  grain: 'one row per order',
  fields: [
    field('category', 'dimension', 'category', 'none'),
    field('sales', 'metric', 'currency', 'sum'),
    field('cost', 'metric', 'currency', 'sum'),
    field('profit', 'metric', 'currency', 'sum'),
  ],
  compositeMetrics: [],
  derivedMetrics: [],
};

describe('explicit aggregate threshold fallback', () => {
  it('preserves category, the literal 2000, and the native profit metric', () => {
    const plan = generateLocalPlan('Which categories have total profit below 2000?', model);
    expect(plan.intent).toBe('aggregate_filter');
    expect(plan.dimensions).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'category' })]));
    expect(plan.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'profit', op: '<', value: 2000, isHaving: true }),
    ]));

    const processed = processPlan(plan, model);
    expect(processed.derivedMetricApplied).toBe(false);
    expect(processed.plan.metrics[0].field).toBe('profit');

    const sql = correctSQL(processed.plan, model, processed.derivedMetrics);
    expect(sql).toContain('GROUP BY "category"');
    expect(sql).toContain('HAVING SUM("profit") < 2000');
    expect(sql).not.toContain('sales - cost');
    expect(sql).not.toContain('profit_sum DESC\nLIMIT 5');
  });
});
