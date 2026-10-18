import React, { useEffect, useMemo, useState } from 'react';
import type { DashboardFilter } from '../store/useAppStore';
import {
  buildDashboardDateEntries,
  dashboardAddDays,
  dashboardDateOptions,
  type DashboardDateSelection,
} from '../utils/dashboardDateFilter';

interface DashboardDateFilterProps {
  column: string;
  rows: Record<string, unknown>[];
  activeFilter?: DashboardFilter;
  onApply: (filter: DashboardFilter) => void;
  onRemove: () => void;
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function legacySelection(filter?: DashboardFilter): DashboardDateSelection | undefined {
  if (!filter || filter.dateMode || filter.values.length !== 1) return undefined;
  const value = filter.values[0];
  if (/^\d{4}$/.test(value)) return { year: value };
  const quarter = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarter) return { year: quarter[1], quarter: quarter[2] };
  return undefined;
}

function initialMode(filter?: DashboardFilter): 'range' | 'calendar' {
  if (filter?.dateMode) return filter.dateMode;
  return filter?.values.some(value => /^\d{4}(?:-Q[1-4])?$/.test(value)) ? 'calendar' : 'range';
}

const selectClass = 'w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:bg-slate-700 dark:text-white';

export const DashboardDateFilter: React.FC<DashboardDateFilterProps> = ({ column, rows, activeFilter, onApply, onRemove }) => {
  const [mode, setMode] = useState<'range' | 'calendar'>(() => initialMode(activeFilter));
  const legacyDates = activeFilter?.dateMode ? [] : (activeFilter?.values || []).filter(value => datePattern.test(value));
  const [from, setFrom] = useState(activeFilter?.dateRange?.from || legacyDates[0] || '');
  const [to, setTo] = useState(activeFilter?.dateRange?.to || legacyDates[1] || '');
  const entries = useMemo(() => buildDashboardDateEntries(rows, column), [rows, column]);
  const selection = activeFilter?.dateMode === 'calendar' ? activeFilter.dateSelection : legacySelection(activeFilter);
  const options = useMemo(() => dashboardDateOptions(entries, selection), [entries, selection]);

  useEffect(() => {
    if (!activeFilter) { setFrom(''); setTo(''); }
  }, [activeFilter]);

  const changeMode = (next: 'range' | 'calendar') => {
    if (next === mode) return;
    setMode(next);
    setFrom('');
    setTo('');
    if (activeFilter) onRemove();
  };

  const changeSelection = (next: DashboardDateSelection | undefined) => {
    if (!next?.year) { onRemove(); return; }
    const token = next.day || next.weekStart || (next.month ? `${next.year}-${next.month}` : next.quarter ? `${next.year}-Q${next.quarter}` : next.year);
    onApply({ column, type: 'dimension', dateMode: 'calendar', dateSelection: next, values: [token] });
  };

  return (
    <div className="flex min-w-[260px] flex-1 flex-col gap-3">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Date filter</div>
        <div role="tablist" aria-label="Date filter mode" className="mt-1.5 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1 dark:border-white/10 dark:bg-slate-900/60">
          {(['range', 'calendar'] as const).map(option => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={mode === option}
              onClick={() => changeMode(option)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${mode === option
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-700'}`}
            >
              {option === 'range' ? 'Date range' : 'Year → Quarter → Month → Week → Day'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'range' ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            From
            <input aria-label="From date" type="date" value={from} onChange={event => setFrom(event.target.value)} className={selectClass} />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
            To
            <input aria-label="To date" type="date" value={to} onChange={event => setTo(event.target.value)} className={selectClass} />
          </label>
          <button
            type="button"
            disabled={!from || !to || from > to}
            onClick={() => onApply({ column, type: 'dimension', dateMode: 'range', dateRange: { from, to }, values: [from, to] })}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply range
          </button>
          {from && to && from > to && <span role="alert" className="text-xs text-rose-500">From must be before To.</span>}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Year
              <select aria-label="Year" value={selection?.year || ''} onChange={event => changeSelection(event.target.value ? { year: event.target.value } : undefined)} className={`mt-1 ${selectClass}`}>
                <option value="">All years</option>
                {options.years.map(year => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Quarter
              <select aria-label="Quarter" disabled={!selection?.year} value={selection?.quarter || ''} onChange={event => changeSelection({ year: selection!.year, ...(event.target.value ? { quarter: event.target.value } : {}) })} className={`mt-1 ${selectClass}`}>
                <option value="">All quarters</option>
                {options.quarters.map(quarter => <option key={quarter} value={quarter}>Q{quarter}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Month
              <select aria-label="Month" disabled={!selection?.quarter} value={selection?.month || ''} onChange={event => changeSelection({ year: selection!.year, quarter: selection!.quarter, ...(event.target.value ? { month: event.target.value } : {}) })} className={`mt-1 ${selectClass}`}>
                <option value="">All months</option>
                {options.months.map(month => <option key={month} value={month}>{monthNames[Number(month) - 1]}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Week
              <select aria-label="Week" disabled={!selection?.month} value={selection?.weekStart || ''} onChange={event => changeSelection({ year: selection!.year, quarter: selection!.quarter, month: selection!.month, ...(event.target.value ? { weekStart: event.target.value } : {}) })} className={`mt-1 ${selectClass}`}>
                <option value="">All weeks</option>
                {options.weeks.map(weekStart => <option key={weekStart} value={weekStart}>{weekStart} – {dashboardAddDays(weekStart, 6)}</option>)}
              </select>
            </label>
            <label className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">Day
              <select aria-label="Day" disabled={!selection?.weekStart} value={selection?.day || ''} onChange={event => changeSelection({ year: selection!.year, quarter: selection!.quarter, month: selection!.month, weekStart: selection!.weekStart, ...(event.target.value ? { day: event.target.value } : {}) })} className={`mt-1 ${selectClass}`}>
                <option value="">All days</option>
                {options.days.map(day => <option key={day} value={day}>{day}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">Stop at any level to filter by that period. Weeks run Monday–Sunday; only dates in the selected month are included.</p>
        </div>
      )}

      {activeFilter && !activeFilter.dateMode && (
        <p className="text-[11px] text-amber-600 dark:text-amber-300">An older saved date filter is active. Choosing a new period replaces it.</p>
      )}
    </div>
  );
};
