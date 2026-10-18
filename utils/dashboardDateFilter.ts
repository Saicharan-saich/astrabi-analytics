import type { DashboardFilter } from '../store/useAppStore';

export type DashboardDateSelection = NonNullable<DashboardFilter['dateSelection']>;

export interface DashboardDateEntry {
  key: string;
  year: string;
  quarter: string;
  month: string;
  weekStart: string;
}

const pad = (value: number) => String(value).padStart(2, '0');
const isDateKey = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Keep a date-only value on its calendar day, independent of browser timezone. */
export function dashboardDateKey(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  let year: number;
  let month: number;
  let day: number;

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(value)) {
    year = Number(value.slice(0, 4));
    month = Number(value.slice(5, 7));
    day = Number(value.slice(8, 10));
  } else {
    const parsed = value instanceof Date ? value : new Date(value as string | number);
    if (Number.isNaN(parsed.getTime())) return null;
    year = value instanceof Date ? parsed.getUTCFullYear() : parsed.getFullYear();
    month = (value instanceof Date ? parsed.getUTCMonth() : parsed.getMonth()) + 1;
    day = value instanceof Date ? parsed.getUTCDate() : parsed.getDate();
  }

  const validated = new Date(Date.UTC(year, month - 1, day));
  if (validated.getUTCFullYear() !== year || validated.getUTCMonth() + 1 !== month || validated.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function dashboardWeekStart(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function dashboardAddDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildDashboardDateEntries(rows: Record<string, unknown>[], column: string): DashboardDateEntry[] {
  const distinct = new Set<string>();
  for (const row of rows) {
    const key = dashboardDateKey(row[column]);
    if (key) distinct.add(key);
  }
  return Array.from(distinct).sort().map(key => {
    const month = key.slice(5, 7);
    return {
      key,
      year: key.slice(0, 4),
      quarter: String(Math.ceil(Number(month) / 3)),
      month,
      weekStart: dashboardWeekStart(key),
    };
  });
}

export function dashboardDateOptions(entries: DashboardDateEntry[], selection?: DashboardDateSelection) {
  const years = Array.from(new Set(entries.map(entry => entry.year))).sort().reverse();
  const inYear = selection?.year ? entries.filter(entry => entry.year === selection.year) : [];
  const quarters = Array.from(new Set(inYear.map(entry => entry.quarter))).sort();
  const inQuarter = selection?.quarter ? inYear.filter(entry => entry.quarter === selection.quarter) : [];
  const months = Array.from(new Set(inQuarter.map(entry => entry.month))).sort();
  const inMonth = selection?.month ? inQuarter.filter(entry => entry.month === selection.month) : [];
  const weeks = Array.from(new Set(inMonth.map(entry => entry.weekStart))).sort();
  const inWeek = selection?.weekStart ? inMonth.filter(entry => entry.weekStart === selection.weekStart) : [];
  const days = inWeek.map(entry => entry.key);
  return { years, quarters, months, weeks, days };
}

export function matchesDashboardDateFilter(filter: DashboardFilter, rawValue: unknown): boolean {
  if (!filter.dateMode && filter.values.length === 0) return true;
  const key = dashboardDateKey(rawValue);
  if (!key) return false;

  if (filter.dateMode === 'range') {
    const from = filter.dateRange?.from || filter.values[0];
    const to = filter.dateRange?.to || filter.values[1];
    return (!from || key >= from) && (!to || key <= to);
  }

  if (filter.dateMode === 'calendar') {
    const selection = filter.dateSelection;
    if (!selection?.year) return true;
    const month = Number(key.slice(5, 7));
    return key.slice(0, 4) === selection.year
      && (!selection.quarter || String(Math.ceil(month / 3)) === selection.quarter)
      && (!selection.month || key.slice(5, 7) === selection.month)
      && (!selection.weekStart || dashboardWeekStart(key) === selection.weekStart)
      && (!selection.day || key === selection.day);
  }

  // Backward compatibility for saved dashboard filters created by the old
  // year/quarter pills and inclusive date-range inputs.
  const hierarchyTokens = filter.values.filter(value => !isDateKey(value));
  const rangeValues = filter.values.filter(isDateKey);
  const year = key.slice(0, 4);
  const quarter = `${year}-Q${Math.ceil(Number(key.slice(5, 7)) / 3)}`;
  const hierarchyMatch = hierarchyTokens.length === 0 || hierarchyTokens.some(value => value === year || value === quarter);
  const rangeMatch = rangeValues.length === 0 || (rangeValues.length === 1
    ? key === rangeValues[0]
    : key >= rangeValues[0] && key <= rangeValues[1]);
  return hierarchyTokens.length > 0 && rangeValues.length > 0
    ? hierarchyMatch || rangeMatch
    : hierarchyMatch && rangeMatch;
}

export function dashboardDateFilterLabel(filter: DashboardFilter): string {
  if (filter.dateMode === 'range') {
    const from = filter.dateRange?.from || filter.values[0];
    const to = filter.dateRange?.to || filter.values[1];
    return `${from} → ${to}`;
  }
  if (filter.dateMode === 'calendar' && filter.dateSelection) {
    const { year, quarter, month, weekStart, day } = filter.dateSelection;
    if (day) return day;
    if (weekStart) return `Week of ${weekStart}`;
    if (month) return `${year}-${month}`;
    if (quarter) return `${year} Q${quarter}`;
    return year;
  }
  return filter.values.join(', ');
}
