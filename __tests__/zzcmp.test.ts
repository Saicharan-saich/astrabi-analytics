import { it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { AnalysisType, TimeGrain } from '../types';
it('p', async () => {
  const raw = Array.from({ length: 900 }, (_, i) => ({ 'Order ID': `R${i}`, 'Order Date': `2026-0${7 + (i % 3)}-${String(1 + (i % 28)).padStart(2,'0')}`, Location: ['Leeds','York'][i%2], 'Gross Sales': 10 + (i % 7) }));
  const out = runETLPipeline(raw, 'r.csv');
  const ds: any = { id: 'r', name: 'r.csv', rows: out.rows, columns: out.columns, timeContext: out.timeContext };
  const base = { questionId: 'custom_builder', metric: 'gross_sales', aggregation: 'SUM', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, filters: {}, asOfDate: '2026-09-20' };
  for (const extra of [
    { dimension: '', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month' },
    { dimension: 'day', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month', sort: 'oldest' },
    { dimension: 'location', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month' },
    { dimension: 'month', timeFilter: 'last_2_months', sort: 'oldest' },
  ]) {
    const r: any = await runAnalysis(ds, { ...base, ...extra } as any);
    console.log('PP', JSON.stringify(extra), r.error || '', r.xKey, r.yKey, r.vis, r.data?.length, JSON.stringify(r.data?.slice(0, 3)), JSON.stringify(r.growth || r.kpi || ''));
  }
});
