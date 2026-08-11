import { beforeEach, describe, expect, it, vi } from 'vitest';

const executedSql: string[] = [];

vi.mock('../services/duckdbEngine', () => ({
  executeSQLViaDuckDB: vi.fn(async (_rows: unknown[], sql: string) => {
    executedSql.push(sql);
    if (/COUNT\(\*\) as cnt/i.test(sql)) return { data: [{ cnt: 2 }] };
    if (/AS min_date/i.test(sql)) {
      return { data: [{ min_date: '2024-01-01', max_date: '2024-01-03', span_days: 2, distinct_dates: 2 }] };
    }
    return { data: [] };
  }),
}));

import { resolveLocalStatistics } from '../services/ai-sql/localStatisticsResolver';

describe('local statistics date handling', () => {
  beforeEach(() => {
    executedSql.length = 0;
  });

  it('casts uploaded string-backed date values before DATEDIFF aggregates', async () => {
    await resolveLocalStatistics('varchar-date-fixture', {
      datasetName: 'varchar-date-fixture',
      rowCount: 2,
      fields: [{
        name: 'invoice_date',
        physicalType: 'date',
        semanticType: 'date',
        role: 'dimension',
        defaultAgg: 'none',
        timeGrainSupport: ['day', 'month', 'year'],
        synonyms: [],
        valueDescriptors: [],
        distinctCount: 2,
        hasNulls: false,
        displayLabel: 'Invoice Date',
      }],
      compositeMetrics: [],
      derivedMetrics: [],
    } as any);

    const timeQuery = executedSql.find(sql => /DATEDIFF\('day'/i.test(sql)) || '';
    expect(timeQuery).toContain('MIN(TRY_CAST("invoice_date" AS DATE))');
    expect(timeQuery).toContain('MAX(TRY_CAST("invoice_date" AS DATE))');
    expect(timeQuery).not.toContain('DATEDIFF(\'day\', MIN("invoice_date"), MAX("invoice_date"))');
  });
});
