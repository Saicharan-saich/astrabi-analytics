import React, { useMemo, useState } from 'react';
import { Check, Copy, ListChecks } from 'lucide-react';

interface DimensionResultViewProps {
  rows: Record<string, unknown>[];
  isDark: boolean;
  ranked?: boolean;
}

function displayLabel(column: string): string {
  return column
    .replace(/_/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/** A readable result surface for entity/category projections with no measure. */
export const DimensionResultView: React.FC<DimensionResultViewProps> = ({ rows, isDark, ranked = false }) => {
  const [copied, setCopied] = useState(false);
  const columns = useMemo(() => {
    const ordered = new Set<string>();
    rows.forEach(row => Object.keys(row).forEach(column => ordered.add(column)));
    return Array.from(ordered);
  }, [rows]);
  const singleColumn = columns.length === 1;
  const entityLabel = singleColumn ? displayLabel(columns[0]) : 'Results';

  const copyRows = async () => {
    const text = [
      columns.map(displayLabel).join('\t'),
      ...rows.map(row => columns.map(column => displayValue(row[column])).join('\t')),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access may be blocked by the browser; the result remains usable.
    }
  };

  return (
    <div data-appearance={isDark ? 'dark' : 'light'} className={`qi-dimension-result flex h-full flex-col overflow-hidden rounded-[24px] border shadow-xl ${isDark ? 'border-white/10 bg-[#111827]' : 'border-slate-200 bg-white'}`}>
      <div className={`flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 sm:px-7 ${isDark ? 'border-white/[0.07] bg-white/[0.025]' : 'border-slate-100 bg-gradient-to-r from-indigo-50/70 to-cyan-50/50'}`}>
        <div className="flex min-w-0 items-center gap-3.5">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${isDark ? 'bg-indigo-500/15 text-indigo-300' : 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'}`}>
            <ListChecks className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className={`truncate text-base font-extrabold ${isDark ? 'text-white' : 'text-slate-900'}`}>{entityLabel}</h3>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {rows.length.toLocaleString()} {rows.length === 1 ? 'result' : 'results'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={copyRows}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-colors ${isDark ? 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {singleColumn ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row, index) => (
              <div
                key={`${displayValue(row[columns[0]])}-${index}`}
                className={`qi-entity-card flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${isDark ? 'border-white/[0.07] bg-white/[0.035] hover:bg-white/[0.065]' : 'border-slate-200 bg-slate-50/70 hover:border-indigo-200 hover:bg-indigo-50/40'}`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-black tabular-nums ${ranked && index < 3 ? 'bg-indigo-600 text-white' : isDark ? 'bg-slate-700 text-slate-300' : 'bg-white text-slate-400 shadow-sm ring-1 ring-slate-200'}`}>
                  {index + 1}
                </span>
                <span className={`min-w-0 break-words text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  {displayValue(row[columns[0]])}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-white/[0.08]' : 'border-slate-200'}`}>
            <table className="qi-result-table w-full border-collapse text-sm">
              <thead>
                <tr className={isDark ? 'bg-slate-800/95' : 'bg-slate-50'}>
                  <th className={`w-16 px-4 py-3 text-center text-[11px] font-black uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>#</th>
                  {columns.map(column => (
                    <th key={column} className={`px-4 py-3 text-left text-[11px] font-black uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                      {displayLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className={`border-t transition-colors ${isDark ? 'border-white/[0.05] hover:bg-white/[0.04]' : 'border-slate-100 hover:bg-indigo-50/40'}`}>
                    <td className={`px-4 py-3 text-center text-xs font-bold ${ranked && index < 3 ? 'text-indigo-500' : isDark ? 'text-slate-500' : 'text-slate-400'}`}>{index + 1}</td>
                    {columns.map(column => (
                      <td key={column} className={`px-4 py-3 text-left text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                        {displayValue(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
