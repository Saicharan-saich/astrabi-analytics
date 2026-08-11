/**
 * Launch gate for the highest-risk user journeys reported in production.
 *
 * These cases prove that an AI SQL plan which fits the Question Builder DSL is
 * compiled by the exact same deterministic path and preserves human-readable
 * dimensions instead of silently adding identifiers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDuck, type DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { mapPlanToQBConfig } from '../services/ai-sql/qbMapper';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ROWS = [
  { order_id: 'O1', order_date: '2024-12-20', product_id: 'P1', product_name: 'Legacy Copier', customer_id: 'C1', customer_name: 'Alice', sales: 900, profit: 90 },
  { order_id: 'O2', order_date: '2025-01-05', product_id: 'P1', product_name: 'Copier Pro', customer_id: 'C1', customer_name: 'Alice', sales: 500, profit: 50 },
  { order_id: 'O3', order_date: '2025-02-10', product_id: 'P1', product_name: 'Copier Pro', customer_id: 'C2', customer_name: 'Bob', sales: 700, profit: -20 },
  { order_id: 'O4', order_date: '2025-03-12', product_id: 'P2', product_name: 'Binding System', customer_id: 'C2', customer_name: 'Bob', sales: 450, profit: 40 },
  { order_id: 'O5', order_date: '2025-04-18', product_id: 'P2', product_name: 'Binding System', customer_id: 'C3', customer_name: 'Carla', sales: 350, profit: 35 },
  { order_id: 'O6', order_date: '2025-05-01', product_id: 'P3', product_name: 'Task Chair', customer_id: 'C3', customer_name: 'Carla', sales: 600, profit: -60 },
  { order_id: 'O7', order_date: '2025-06-21', product_id: 'P4', product_name: 'Desk Lamp', customer_id: 'C4', customer_name: 'David', sales: 200, profit: 25 },
];

let duck: DuckHandle;
let model: any;

beforeAll(async () => {
  duck = await createDuck();
  const etl = runETLPipeline(ROWS, 'retail-orders.csv');
  model = buildSemanticModel({
    id: 'golden-retail',
    name: 'retail-orders',
    rows: etl.rows,
    columns: etl.columns,
    totalRows: etl.rows.length,
    etlLogs: [],
    timeContext: etl.timeContext,
  } as any);
  duck.loadTable('data', etl.rows);
}, 60_000);

afterAll(() => duck?.close());

function plan(overrides: Partial<AnalysisPlan>): AnalysisPlan {
  return {
    intent: 'breakdown',
    dimensions: [],
    metrics: [],
    filters: [],
    sort: [],
    limit: null,
    ambiguous: false,
    resultGrain: 'summary',
    originalQuestion: '',
    ...overrides,
  };
}

function compileBuilderPath(input: AnalysisPlan): { sql: string; rows: Record<string, any>[] } {
  const mapped = mapPlanToQBConfig(input, model);
  if (!mapped.fits) throw new Error(`Expected Question Builder fit: ${(mapped as any).reason}`);
  const dates = getDates(model.timeContext?.anchorDate || '2025-06-21');
  const queryPlan = buildQueryPlan(mapped.config, mapped.dateColumnKey, dates, 'data');
  const sql = compileSQL(queryPlan);
  return { sql, rows: duck.query(sql) };
}

describe('AI SQL ↔ Question Builder golden parity', () => {
  it('answers "top products this year" with one readable dimension and correct totals', () => {
    const result = compileBuilderPath(plan({
      intent: 'ranking',
      dimensions: [{ field: 'product_name' }],
      metrics: [{ field: 'sales', agg: 'sum' }],
      filters: [{ field: 'order_date', op: 'this_year', value: null }],
      sort: [{ field: 'sales', dir: 'desc' }],
      limit: 3,
      originalQuestion: 'Which 3 products generated the most sales this year?',
    }));

    expect(result.sql).toContain('GROUP BY "product_name"');
    expect(result.sql).not.toContain('GROUP BY "product_name", "product_id"');
    expect(result.rows.map(row => String(row.product_name))).toEqual([
      'Copier Pro',
      'Binding System',
      'Task Chair',
    ]);
    expect(result.rows.map(row => Number(row.sum_sales))).toEqual([1200, 800, 600]);
  });

  it('uses customer_name—not customer_id—for a human-facing highest-AOV answer', () => {
    const result = compileBuilderPath(plan({
      intent: 'ranking',
      dimensions: [{ field: 'customer_name' }],
      metrics: [{ field: 'sales', agg: 'avg' }],
      sort: [{ field: 'sales', dir: 'desc' }],
      limit: 1,
      originalQuestion: 'Which customer has the highest average order value?',
    }));

    expect(result.sql).toContain('GROUP BY "customer_name"');
    expect(result.sql).not.toContain('GROUP BY "customer_id"');
    expect(result.rows).toHaveLength(1);
    expect(String(result.rows[0].customer_name)).toBe('Alice');
    expect(Number(result.rows[0].avg_sales)).toBe(700);
  });

  it('keeps the prior year outside a current-year ranking', () => {
    const result = compileBuilderPath(plan({
      intent: 'ranking',
      dimensions: [{ field: 'product_name' }],
      metrics: [{ field: 'sales', agg: 'sum' }],
      filters: [{ field: 'order_date', op: 'this_year', value: null }],
      sort: [{ field: 'sales', dir: 'desc' }],
      limit: 10,
      originalQuestion: 'Which products generated the most sales this year?',
    }));

    expect(result.rows.some(row => String(row.product_name) === 'Legacy Copier')).toBe(false);
    expect(result.rows.reduce((sum, row) => sum + Number(row.sum_sales), 0)).toBe(2800);
  });
});
