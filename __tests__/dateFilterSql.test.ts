/**
 * A date filter from the Question Builder (or from typing "in 2025") must
 * appear once in the SQL shown with the answer. A second, made-up
 * `order_date IN ('2025')` clause made the answer check report a mismatch
 * even though the figures were right.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { checkAnswer } from '../services/answerCheck/answerCheck';
import { salesRows } from '../e2e-visual/fixtures';
import { AnalysisType, TimeGrain } from '../types';

const out = runETLPipeline(salesRows(), 'Sales.csv');
const ds: any = { id: 's', name: 'Sales.csv', rows: out.rows, columns: out.columns, timeContext: out.timeContext };

const cases: Array<[string, any]> = [
  ['year', { column: 'order_date', timeGrain: 'year', values: ['2025'] }],
  ['quarter', { column: 'order_date', timeGrain: 'quarter', values: ['2025-Q2'] }],
  ['month', { column: 'order_date', timeGrain: 'month', values: ['2025-03'] }],
];

describe('date filters in the answer SQL', () => {
  it.each(cases)('%s filter appears once and the answer verifies', async (_name, df) => {
    const res: any = await runAnalysis(ds, {
      questionId: 'custom_builder', metric: 'profit', dimension: 'product', aggregation: 'SUM',
      timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time',
      filters: {}, sort: 'desc', limit: 5, asOfDate: '2026-09-20', dateFilters: [df],
    } as any);
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.sql).not.toMatch(/order_date IN \(/);
    const chk: any = checkAnswer({ sql: res.sql, rows: res.data, data: ds.rows, matchByName: true });
    expect(chk.status).not.toBe('mismatch');
  });
});
