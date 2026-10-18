import { describe, expect, it } from 'vitest';
import {
  buildDashboardDateEntries,
  dashboardDateFilterLabel,
  dashboardDateKey,
  dashboardDateOptions,
  matchesDashboardDateFilter,
} from '../utils/dashboardDateFilter';
import type { DashboardFilter } from '../store/useAppStore';

const calendarFilter = (dateSelection: NonNullable<DashboardFilter['dateSelection']>): DashboardFilter => ({
  column: 'order_date', type: 'dimension', dateMode: 'calendar', dateSelection, values: [dateSelection.year],
});

describe('dashboard date filters', () => {
  it('builds dependent year, quarter, month, Monday-based week and day choices from real dataset dates', () => {
    const entries = buildDashboardDateEntries([
      { order_date: '2025-01-31' },
      { order_date: '2025-02-01' },
      { order_date: '2025-02-03T00:00:00Z' },
      { order_date: '2025-02-09' },
      { order_date: '2025-02-10' },
      { order_date: '2026-01-01' },
      { order_date: '2025-02-01' },
    ], 'order_date');

    expect(dashboardDateOptions(entries).years).toEqual(['2026', '2025']);
    expect(dashboardDateOptions(entries, { year: '2025' }).quarters).toEqual(['1']);
    expect(dashboardDateOptions(entries, { year: '2025', quarter: '1' }).months).toEqual(['01', '02']);
    expect(dashboardDateOptions(entries, { year: '2025', quarter: '1', month: '02' }).weeks)
      .toEqual(['2025-01-27', '2025-02-03', '2025-02-10']);
    expect(dashboardDateOptions(entries, { year: '2025', quarter: '1', month: '02', weekStart: '2025-01-27' }).days)
      .toEqual(['2025-02-01']);
  });

  it('applies each calendar level and keeps cross-month weeks within their selected month', () => {
    expect(matchesDashboardDateFilter(calendarFilter({ year: '2025' }), '2025-12-31')).toBe(true);
    expect(matchesDashboardDateFilter(calendarFilter({ year: '2025' }), '2026-01-01')).toBe(false);
    expect(matchesDashboardDateFilter(calendarFilter({ year: '2025', quarter: '1' }), '2025-04-01')).toBe(false);
    expect(matchesDashboardDateFilter(calendarFilter({ year: '2025', quarter: '1', month: '02' }), '2025-01-31')).toBe(false);
    const week = calendarFilter({ year: '2025', quarter: '1', month: '02', weekStart: '2025-01-27' });
    expect(matchesDashboardDateFilter(week, '2025-02-01')).toBe(true);
    expect(matchesDashboardDateFilter(week, '2025-01-31')).toBe(false);
    expect(matchesDashboardDateFilter({ ...week, dateSelection: { ...week.dateSelection!, day: '2025-02-01' } }, '2025-02-02')).toBe(false);
  });

  it('treats range endpoints as inclusive calendar days, including timestamp rows', () => {
    const filter: DashboardFilter = {
      column: 'order_date', type: 'dimension', dateMode: 'range',
      dateRange: { from: '2025-02-01', to: '2025-02-09' }, values: ['2025-02-01', '2025-02-09'],
    };
    expect(matchesDashboardDateFilter(filter, '2025-02-01')).toBe(true);
    expect(matchesDashboardDateFilter(filter, '2025-02-09T23:59:59Z')).toBe(true);
    expect(matchesDashboardDateFilter(filter, '2025-02-10')).toBe(false);
    expect(matchesDashboardDateFilter(filter, null)).toBe(false);
    expect(dashboardDateFilterLabel(filter)).toBe('2025-02-01 → 2025-02-09');
  });

  it('keeps older saved year, quarter and range filters working', () => {
    const oldYear: DashboardFilter = { column: 'order_date', values: ['2025'] };
    const oldQuarter: DashboardFilter = { column: 'order_date', values: ['2025-Q1'] };
    const oldRange: DashboardFilter = { column: 'order_date', values: ['2025-02-01', '2025-02-09'] };
    expect(matchesDashboardDateFilter(oldYear, '2025-11-01')).toBe(true);
    expect(matchesDashboardDateFilter(oldQuarter, '2025-04-01')).toBe(false);
    expect(matchesDashboardDateFilter(oldRange, '2025-02-09')).toBe(true);
    expect(matchesDashboardDateFilter(oldRange, '2025-02-10')).toBe(false);
    expect(dashboardDateKey('2025-02-29')).toBeNull();
  });
});
