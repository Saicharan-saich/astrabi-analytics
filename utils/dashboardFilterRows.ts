import type { ColumnDefinition } from '../types';
import type { DashboardFilter } from '../store/useAppStore';
import { matchesDashboardDateFilter } from './dashboardDateFilter';

/** Apply dashboard predicates to source rows before a saved query is executed. */
export function filterDashboardRows<T extends Record<string, any>>(
  rows: T[],
  columns: ColumnDefinition[],
  filters: DashboardFilter[],
): T[] {
  if (!filters.length) return rows;
  const dateColumns = new Set(columns.filter(column => column.type === 'DATE').map(column => column.name));
  return rows.filter(row => filters.every(filter => {
    const value = row[filter.column];
    if (filter.dateMode || filter.dateRange || filter.dateSelection || dateColumns.has(filter.column)) {
      return matchesDashboardDateFilter(filter, value);
    }
    if (value === undefined || value === null) return false;
    if (filter.type === 'measure' && filter.operator && filter.numericValue !== undefined) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return false;
      switch (filter.operator) {
        case '>': return number > filter.numericValue;
        case '<': return number < filter.numericValue;
        case '=': return number === filter.numericValue;
        case '!=': return number !== filter.numericValue;
        case '>=': return number >= filter.numericValue;
        case '<=': return number <= filter.numericValue;
      }
    }
    return filter.values.length === 0 || filter.values.includes(String(value));
  }));
}
