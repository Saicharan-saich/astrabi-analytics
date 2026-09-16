import { describe, expect, it } from 'vitest';
import type { AnalysisResult, DashboardItem } from '../types';
import {
  normalizeDashboardVisualTitle,
  saveEditedDashboardItem,
  titleDashboardItem,
} from '../services/dashboardVisualLifecycle';

const result = (insight: string): AnalysisResult => ({
  data: [{ region: 'North', sales: 10 }],
  chartType: 'bar',
  xAxis: 'region',
  yAxis: 'sales',
  xLabel: 'Region',
  yLabel: 'Sales',
  insight,
  config: {} as AnalysisResult['config'],
});

const item = (): DashboardItem => ({
  id: 'visual-1',
  title: 'My regional sales',
  result: result('Generated result title'),
  width: 'full',
  datasetId: 'dataset-1',
  datasetName: 'Sales workbook',
  datasetVersion: 7,
  ignoreGlobalFilter: true,
  pinnedAt: 1234,
});

describe('dashboard visual title lifecycle', () => {
  it('uses a user-supplied name when a visual is pinned', () => {
    expect(titleDashboardItem(item(), '  Executive sales view  ').title)
      .toBe('Executive sales view');
  });

  it('preserves a dashboard rename when the analysis is edited and saved', () => {
    const existing = item();
    const updated = saveEditedDashboardItem(existing, result('New generated default'));

    expect(updated.title).toBe('My regional sales');
    expect(updated.result.insight).toBe('New generated default');
  });

  it('preserves card identity, layout, provenance, and filter preferences', () => {
    const updated = saveEditedDashboardItem(item(), result('Updated analysis'));

    expect(updated).toMatchObject({
      id: 'visual-1',
      width: 'full',
      datasetId: 'dataset-1',
      datasetName: 'Sales workbook',
      datasetVersion: 7,
      ignoreGlobalFilter: true,
      pinnedAt: 1234,
    });
  });

  it('rejects whitespace-only names and keeps the existing title', () => {
    expect(titleDashboardItem(item(), '   ').title).toBe('My regional sales');
    expect(normalizeDashboardVisualTitle('   ')).toBe('Untitled Visual');
  });
});
