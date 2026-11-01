import React, { useState, useMemo } from 'react';
import { Database, ToggleLeft, ToggleRight, X, Save, Edit3 } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { CleaningLogEntry } from '../services/dataCleaningEngine';
import { ETLStepCard } from './ETLStepCard';

interface ETLViewProps {
  dataset: Dataset;
  onSchemaOverride?: (columnName: string, newType: ColumnType) => void;
  onRowsRecovered?: (recoveredRows: Record<string, any>[]) => void;
  onDataCleaned?: (newRows: Record<string, any>[], log: CleaningLogEntry) => void;
  onSwitchToLive?: () => void;
}

type LogFilter = 'all' | 'applied' | 'skipped' | 'info';
type ETLMode = 'auto' | 'manual';

// ─── Row Editor Modal ───────────────────────────────────────
interface RowEditorProps {
  rows: Record<string, any>[];
  onClose: () => void;
  onSave: (editedRows: Record<string, any>[]) => void;
}

const RowEditorModal: React.FC<RowEditorProps> = ({ rows, onClose, onSave }) => {
  const [editableRows, setEditableRows] = useState(() => rows.map(r => ({ ...r, _keep: false })));
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  const updateCell = (rowIdx: number, col: string, value: string) => {
    setEditableRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, [col]: value } : r));
  };

  const toggleKeep = (rowIdx: number) => {
    setEditableRows(prev => prev.map((r, i) => i === rowIdx ? { ...r, _keep: !r._keep } : r));
  };

  const handleSave = () => {
    const keptRows = editableRows
      .filter(r => r._keep)
      .map(({ _keep, ...rest }) => rest);
    onSave(keptRows);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-[90vw] max-w-4xl max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2">
            <Edit3 className="w-5 h-5 text-indigo-600" />
            <h3 className="font-bold" style={{ color: '#0f172a' }}>Edit Removed Rows</h3>
            <span className="text-xs ml-2" style={{ color: '#94a3b8' }}>{rows.length} row(s) flagged for removal</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <p className="text-xs mb-3" style={{ color: '#64748b' }}>
            Check the <strong>Keep</strong> box to retain a row (with your edits). Unchecked rows will be permanently removed.
          </p>
          <div className="overflow-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left font-bold text-indigo-700 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap">Keep</th>
                  {columns.map(col => (
                    <th key={col} className="px-3 py-2 text-left font-bold text-slate-600 uppercase tracking-wider border-b border-slate-200 whitespace-nowrap">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {editableRows.map((row, ri) => (
                  <tr key={ri} className={`transition-colors ${row._keep ? 'bg-emerald-50/50' : 'bg-red-50/30 hover:bg-red-50/50'}`}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={row._keep}
                        onChange={() => toggleKeep(ri)}
                        className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                      />
                    </td>
                    {columns.map(col => (
                      <td key={col} className="px-2 py-1">
                        <input
                          type="text"
                          value={String(row[col] ?? '')}
                          onChange={e => updateCell(ri, col, e.target.value)}
                          style={{ color: '#0f172a', backgroundColor: row._keep ? '#ffffff' : '#f8fafc' }}
                          className={`w-full px-2 py-1 rounded border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400 transition-all ${row._keep ? 'border-emerald-200' : 'border-slate-200'
                            }`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100 bg-slate-50">
          <span className="text-xs text-slate-400">
            {editableRows.filter(r => r._keep).length} of {editableRows.length} rows will be kept
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 shadow-sm transition-all"
            >
              <Save className="w-4 h-4" />
              Apply Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Cleaning log ───────────────────────────────────────────
/**
 * Every automatic cleaning step, as a compact list with filters. Dataset-level
 * facts (download, connection mode, column types, time range) live in the
 * workspace header and Columns tab, so this view is only the step log.
 */
export const ETLView: React.FC<ETLViewProps> = ({ dataset, onRowsRecovered }) => {
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [etlMode, setEtlMode] = useState<ETLMode>('auto');
  const [approvedSteps, setApprovedSteps] = useState<Set<string>>(new Set());
  const [skippedSteps, setSkippedSteps] = useState<Set<string>>(new Set());
  const [editingRemovedRows, setEditingRemovedRows] = useState<{ stepKey: string; rows: Record<string, any>[] } | null>(null);

  const logs = dataset?.etlLogs || [];

  // Stable keys (step name + index) so filtering doesn't break expansion.
  const filteredLogs = useMemo(() => {
    const indexed = logs.map((l, i) => ({ ...l, _key: `${l.step}_${i}` }));
    if (logFilter === 'all') return indexed;
    return indexed.filter(l => l.status === logFilter);
  }, [logs, logFilter]);

  const counts = useMemo(() => ({
    all: logs.length,
    applied: logs.filter(l => l.status === 'applied').length,
    skipped: logs.filter(l => l.status === 'skipped').length,
    info: logs.filter(l => l.status === 'info').length,
  }), [logs]);

  if (!dataset) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400">
        <div className="text-center">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p className="text-lg font-medium">No dataset loaded</p>
          <p className="text-sm mt-1">Upload a file or connect to a database to view the ETL pipeline.</p>
        </div>
      </div>
    );
  }

  const toggleStep = (key: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const FILTERS: { key: LogFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'applied', label: 'Applied' },
    { key: 'info', label: 'Flagged' },
    { key: 'skipped', label: 'Not needed' },
  ];

  return (
    <>
      <div className="qi-ws-card rounded-xl overflow-hidden">
        <div className="qi-ws-toolbar flex flex-wrap items-center gap-2 px-4 py-2.5">
          <div className="qi-ws-segmented inline-flex rounded-lg p-0.5" role="group" aria-label="Filter steps">
            {FILTERS.map(f => (
              <button
                key={f.key}
                type="button"
                onClick={() => setLogFilter(f.key)}
                aria-pressed={logFilter === f.key}
                className={`px-2.5 py-1 rounded-md text-[12px] font-semibold ${logFilter === f.key ? 'is-active' : ''}`}
              >
                {f.label} <span className="qi-ws-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              setEtlMode(prev => prev === 'auto' ? 'manual' : 'auto');
              setApprovedSteps(new Set());
              setSkippedSteps(new Set());
            }}
            aria-pressed={etlMode === 'manual'}
            className="qi-ws-ghost inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold"
            title={etlMode === 'auto' ? 'Review and approve each applied step' : 'Back to automatic cleaning'}
          >
            {etlMode === 'manual' ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
            Approve steps one by one
          </button>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="qi-ws-muted p-10 text-center text-sm">No steps match this filter.</div>
        ) : (
          <div className="qi-ws-list">
            {filteredLogs.map(entry => (
              <ETLStepCard
                key={entry._key}
                entry={entry}
                isExpanded={expandedSteps.has(entry._key)}
                onToggle={toggleStep}
                etlMode={etlMode}
                isApproved={approvedSteps.has(entry._key)}
                isSkipped={skippedSteps.has(entry._key)}
                onApprove={(k) => setApprovedSteps(prev => new Set([...prev, k]))}
                onSkip={(k) => setSkippedSteps(prev => new Set([...prev, k]))}
                onEditRemoved={(k, rows) => setEditingRemovedRows({ stepKey: k, rows })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Row Editor Modal */}
      {editingRemovedRows && (
        <RowEditorModal
          rows={editingRemovedRows.rows}
          onClose={() => setEditingRemovedRows(null)}
          onSave={(keptRows) => {
            if (keptRows.length > 0 && onRowsRecovered) {
              onRowsRecovered(keptRows);
            }
            setEditingRemovedRows(null);
            // In manual mode, auto-approve the step after editing
            setApprovedSteps(prev => new Set([...prev, editingRemovedRows.stepKey]));
          }}
        />
      )}
    </>
  );
};
