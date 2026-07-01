import React, { useState, useMemo } from 'react';
import {
  CheckCircle, XCircle, AlertTriangle, Info, Database,
  ChevronDown, ChevronRight, Filter, BarChart3, Shield,
  Sparkles, Layers, ArrowDownUp, Clock, Download, Eye, Table,
  ToggleLeft, ToggleRight, Edit3, Check, SkipForward, X, Save,
  Zap, Upload
} from 'lucide-react';
import { Dataset, ETLLog, ColumnType } from '../types';
import { DataCleaningPanel } from './DataCleaningPanel';
import { CleaningLogEntry } from '../services/dataCleaningEngine';

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

// ─── Main ETL View ──────────────────────────────────────────
export const ETLView: React.FC<ETLViewProps> = ({ dataset, onSchemaOverride, onRowsRecovered, onDataCleaned, onSwitchToLive }) => {
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [etlMode, setEtlMode] = useState<ETLMode>('auto');
  const [approvedSteps, setApprovedSteps] = useState<Set<string>>(new Set());
  const [skippedSteps, setSkippedSteps] = useState<Set<string>>(new Set());
  const [editingRemovedRows, setEditingRemovedRows] = useState<{ stepKey: string; rows: Record<string, any>[] } | null>(null);

  const logs = dataset?.etlLogs || [];

  // Use stable keys for expansion (step name + index) so filtering doesn't break expansion
  const filteredLogs = useMemo(() => {
    const indexed = logs.map((l, i) => ({ ...l, _key: `${l.step}_${i}` }));
    if (logFilter === 'all') return indexed;
    return indexed.filter(l => l.status === logFilter);
  }, [logs, logFilter]);

  const stats = useMemo(() => {
    const applied = logs.filter(l => l.status === 'applied').length;
    const skipped = logs.filter(l => l.status === 'skipped').length;
    const flagged = logs.filter(l => l.status === 'info').length;

    const summaryLog = logs.find(l => l.step === 'Final Summary');
    const totalRows = dataset?.totalRows || 0;
    const rowsBefore = summaryLog?.rowsBefore || totalRows;
    const rowsAfter = summaryLog?.rowsAfter || totalRows;

    // After ETL cleaning, quality is always 100% — all fixable issues are resolved
    const qualityScore = 100;

    // Build cleaning summary
    const cleaningNotes: string[] = [];
    logs.forEach(l => {
      if (l.status === 'applied') {
        if (l.step.toLowerCase().includes('duplicate') || l.step.toLowerCase().includes('dedup')) {
          const removed = (l.rowsBefore || 0) - (l.rowsAfter || 0);
          if (removed > 0) cleaningNotes.push(`Removed ${removed} duplicate rows`);
        } else if (l.affectedRows && l.affectedRows > 0) {
          cleaningNotes.push(`${l.step}: ${l.affectedRows} cells cleaned`);
        }
      }
    });
    if (rowsBefore !== rowsAfter) {
      cleaningNotes.push(`Total rows reduced: ${rowsBefore} → ${rowsAfter}`);
    }

    return { applied, skipped, flagged, rowsBefore, rowsAfter, qualityScore, total: logs.length, cleaningNotes };
  }, [logs, dataset?.totalRows]);

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

  const handleTypeChange = (columnName: string, newType: ColumnType) => {
    if (onSchemaOverride) {
      onSchemaOverride(columnName, newType);
    }
    setEditingColumn(null);
  };

  const handleDownloadCleanedData = () => {
    if (!dataset.rows.length) return;
    const columns = dataset.columns.map(c => c.name);
    const escapeCSV = (val: any) => {
      if (val == null) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };
    const header = columns.map(escapeCSV).join(',');
    const rows = dataset.rows.map(row =>
      columns.map(col => escapeCSV(row[col])).join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = dataset.name.replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `${baseName}_cleaned.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleStep = (key: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'METRIC': return 'bg-emerald-100 text-emerald-700 border-emerald-300';
      case 'DIMENSION': return 'bg-blue-100 text-blue-700 border-blue-300';
      case 'DATE': return 'bg-amber-100 text-amber-700 border-amber-300';
      case 'ID': return 'bg-purple-100 text-purple-700 border-purple-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'applied': return <CheckCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />;
      case 'skipped': return <XCircle className="w-5 h-5 text-slate-400 flex-shrink-0" />;
      case 'info': return <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />;
      default: return <Info className="w-5 h-5 text-blue-500 flex-shrink-0" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'applied': return 'bg-emerald-100 text-emerald-700 border-emerald-300';
      case 'skipped': return 'bg-slate-100 text-slate-500 border-slate-300';
      case 'info': return 'bg-amber-100 text-amber-700 border-amber-300';
      default: return 'bg-blue-100 text-blue-700 border-blue-300';
    }
  };

  const getQualityColor = (score: number) => {
    if (score >= 90) return 'text-emerald-600';
    if (score >= 70) return 'text-amber-600';
    return 'text-red-600';
  };

  const getQualityBarColor = (score: number) => {
    if (score >= 90) return 'bg-emerald-500';
    if (score >= 70) return 'bg-amber-500';
    return 'bg-red-500';
  };

  const hasExpandableContent = (entry: ETLLog) => {
    return !!(
      entry.affectedColumns?.length ||
      entry.rowsBefore !== undefined ||
      entry.affectedRows !== undefined ||
      (entry.removedRowSamples && entry.removedRowSamples.length > 0) ||
      (entry.transformSamples && entry.transformSamples.length > 0)
    );
  };

  return (
    <>
      <div className="h-full w-full overflow-auto bg-slate-50">
        <div className="max-w-7xl mx-auto p-6 animate-fade-in">

          {/* ─── Header ─────────────────────────────────────────────────── */}
          <div className="mb-6">
            <div className="flex items-center gap-3 mb-1">
              <div className="p-2 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg shadow-indigo-200">
                <Shield className="w-6 h-6 text-white" />
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-slate-900">ETL Pipeline</h2>
                <p className="text-sm text-slate-500">
                  {etlMode === 'auto' ? 'Automated' : 'Manual approval'} data cleaning for <span className="font-mono font-semibold text-indigo-600">{dataset.name}</span>
                </p>
              </div>

              {/* ETL Mode Toggle */}
              <button
                onClick={() => {
                  setEtlMode(prev => prev === 'auto' ? 'manual' : 'auto');
                  setApprovedSteps(new Set());
                  setSkippedSteps(new Set());
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-all duration-200 ${etlMode === 'manual'
                  ? 'bg-amber-50 text-amber-700 border-amber-300 shadow-sm shadow-amber-100 hover:bg-amber-100'
                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                title={etlMode === 'auto' ? 'Switch to Manual ETL (per-step approval)' : 'Switch to Auto ETL'}
              >
                {etlMode === 'manual' ? <ToggleRight className="w-5 h-5 text-amber-600" /> : <ToggleLeft className="w-5 h-5 text-slate-400" />}
                {etlMode === 'manual' ? 'Manual Mode' : 'Auto Mode'}
              </button>

              <button
                onClick={handleDownloadCleanedData}
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-emerald-200 hover:shadow-xl hover:shadow-emerald-300 hover:scale-105 transition-all duration-200"
                title="Download cleaned dataset as CSV"
              >
                <Download className="w-4 h-4" />
                Download Cleaned Data
              </button>
            </div>

            {/* Connection Mode Badge */}
            {dataset.connectionMode && (
              <div className="flex items-center gap-3 mt-2 ml-[52px]">
                {dataset.connectionMode === 'live' ? (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <Zap className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-xs font-bold text-emerald-700">Live Connection</span>
                    <span className="text-[10px] text-emerald-500 ml-1">Real-time data from {dataset.liveConnection?.dbType || 'database'}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg">
                      <Upload className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-xs font-bold text-slate-600">Import Mode</span>
                      <span className="text-[10px] text-slate-400 ml-1">Static snapshot</span>
                    </div>
                    {onSwitchToLive && (
                      <button
                        onClick={onSwitchToLive}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-700 transition-all hover:shadow-sm"
                        title="Reconnect to the database in Live mode for real-time data"
                      >
                        <Zap className="w-3.5 h-3.5" />
                        Switch to Live
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ─── Data Cleaning Studio ─────────────────────────────────── */}
          <div className="mb-6">
            <DataCleaningPanel
              dataset={dataset}
              onDataCleaned={(newRows, log) => {
                if (onDataCleaned) onDataCleaned(newRows, log);
              }}
            />
          </div>

          {/* ─── Summary Cards ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Layers className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Rows In</span>
              </div>
              <div className="text-2xl font-bold text-slate-900">{stats.rowsBefore.toLocaleString()}</div>
            </div>

            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <ArrowDownUp className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Rows Out</span>
              </div>
              <div className="text-2xl font-bold text-emerald-600">{stats.rowsAfter.toLocaleString()}</div>
              {stats.rowsBefore !== stats.rowsAfter && (
                <div className="text-xs text-red-500 mt-0.5">−{(stats.rowsBefore - stats.rowsAfter).toLocaleString()} removed</div>
              )}
            </div>

            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Database className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Columns</span>
              </div>
              <div className="text-2xl font-bold text-slate-900">{dataset.columns.length}</div>
            </div>

            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-emerald-500" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Applied</span>
              </div>
              <div className="text-2xl font-bold text-emerald-600">{stats.applied}</div>
            </div>

            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Skipped</span>
              </div>
              <div className="text-2xl font-bold text-slate-500">{stats.skipped}</div>
            </div>

            <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <BarChart3 className="w-4 h-4 text-emerald-500" />
                <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Cleaning Report</span>
              </div>
              <div className={`text-2xl font-bold ${getQualityColor(stats.qualityScore)}`}>{stats.qualityScore}/100</div>
              <div className="w-full h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${getQualityBarColor(stats.qualityScore)}`}
                  style={{ width: `${stats.qualityScore}%` }}
                />
              </div>
              {stats.cleaningNotes.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {stats.cleaningNotes.slice(0, 3).map((note, i) => (
                    <div key={i} className="text-[10px] text-emerald-600 flex items-center gap-1">
                      <CheckCircle className="w-2.5 h-2.5 flex-shrink-0" />
                      <span className="truncate">{note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* ─── Left: Pipeline Timeline ──────────────────────────────── */}
            <div className="lg:col-span-2 space-y-4">

              {/* Filter Bar */}
              <div className="flex items-center gap-2 bg-white rounded-xl px-4 py-3 border border-slate-200 shadow-sm">
                <Filter className="w-4 h-4 text-slate-400" />
                <span className="text-sm text-slate-600 font-medium mr-2">Filter:</span>
                {([
                  { key: 'all' as LogFilter, label: 'All', count: stats.total },
                  { key: 'applied' as LogFilter, label: 'Applied', count: stats.applied },
                  { key: 'skipped' as LogFilter, label: 'Skipped', count: stats.skipped },
                  { key: 'info' as LogFilter, label: 'Flagged', count: stats.flagged },
                ]).map(f => (
                  <button
                    key={f.key}
                    onClick={() => setLogFilter(f.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${logFilter === f.key
                      ? f.key === 'applied' ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-200'
                        : f.key === 'skipped' ? 'bg-slate-600 text-white shadow-sm'
                          : f.key === 'info' ? 'bg-amber-500 text-white shadow-sm shadow-amber-200'
                            : 'bg-indigo-600 text-white shadow-sm shadow-indigo-200'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                  >
                    {f.label} ({f.count})
                  </button>
                ))}
              </div>

              {/* Pipeline Steps */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-indigo-500" />
                    <h3 className="font-semibold text-slate-700">Pipeline Steps</h3>
                  </div>
                  <span className="text-xs text-slate-400">{filteredLogs.length} step(s)</span>
                </div>

                <div className="divide-y divide-slate-100">
                  {filteredLogs.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-sm">
                      No steps match the current filter.
                    </div>
                  ) : (
                    filteredLogs.map((entry, idx) => {
                      const isExpanded = expandedSteps.has(entry._key);
                      const expandable = hasExpandableContent(entry);

                      return (
                        <div
                          key={entry._key}
                          className={`transition-colors ${entry.status === 'applied' ? 'hover:bg-emerald-50/50' :
                            entry.status === 'info' ? 'hover:bg-amber-50/50' :
                              'hover:bg-slate-50/50'
                            }`}
                        >
                          {/* Main row */}
                          <div
                            className={`px-5 py-3.5 flex items-start gap-3 select-none ${expandable ? 'cursor-pointer' : ''}`}
                            onClick={() => expandable && toggleStep(entry._key)}
                          >
                            {/* Step number + status line */}
                            <div className="flex flex-col items-center gap-1 pt-0.5">
                              {getStatusIcon(entry.status)}
                              {idx < filteredLogs.length - 1 && (
                                <div className={`w-0.5 h-6 rounded-full ${entry.status === 'applied' ? 'bg-emerald-200' :
                                  entry.status === 'info' ? 'bg-amber-200' : 'bg-slate-200'
                                  }`} />
                              )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  {entry.stepNumber && (
                                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-xs font-bold flex items-center justify-center">
                                      {entry.stepNumber}
                                    </span>
                                  )}
                                  <h4 className="font-semibold text-slate-900 truncate">{entry.step}</h4>
                                  <span className={`flex-shrink-0 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${getStatusBadge(entry.status)}`}>
                                    {entry.status}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <span className="text-[10px] text-slate-400 font-mono hidden sm:block">
                                    {new Date(entry.timestamp).toLocaleTimeString()}
                                  </span>
                                  {expandable && (
                                    <div className={`p-1 rounded transition-all ${isExpanded ? 'bg-indigo-100' : 'bg-slate-50 hover:bg-slate-100'}`}>
                                      {isExpanded
                                        ? <ChevronDown className="w-4 h-4 text-indigo-600" />
                                        : <ChevronRight className="w-4 h-4 text-slate-400" />
                                      }
                                    </div>
                                  )}
                                </div>
                              </div>
                              {/* Render log details — Transform Plans get a clean table */}
                              {entry.step === 'Transform Plans' ? (
                                <div className="mt-2">
                                  <p className="text-xs text-slate-500 mb-2">Each column gets a series of cleaning steps applied automatically:</p>
                                  <div className="overflow-auto max-h-64 rounded-lg border border-slate-200 bg-white">
                                    <table className="w-full text-[11px]">
                                      <thead className="bg-slate-50 sticky top-0">
                                        <tr>
                                          <th className="px-3 py-2 text-left font-bold text-slate-700 uppercase tracking-wider border-b border-slate-200">Column</th>
                                          <th className="px-3 py-2 text-left font-bold text-indigo-600 uppercase tracking-wider border-b border-slate-200">Type</th>
                                          <th className="px-3 py-2 text-left font-bold text-slate-600 uppercase tracking-wider border-b border-slate-200">Cleaning Steps</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {entry.details.split('\n').filter(line => line.includes(':')).slice(1).map((line, li) => {
                                          const match = line.match(/^(.+?)\s*\((\w+)\):\s*(.+)$/);
                                          if (!match) return null;
                                          const [, colName, colType, stepsRaw] = match;
                                          const STEP_LABELS: Record<string, { label: string; icon: string }> = {
                                            'TITLE_CASE': { label: 'Standardize text casing', icon: '🔤' },
                                            'SYNONYM_MAP': { label: 'Normalize category names', icon: '🔄' },
                                            'IMPUTE_UNKNOWN': { label: 'Fill blanks with "Unknown"', icon: '🔲' },
                                            'PARSE_NUMBER': { label: 'Convert to number', icon: '🔢' },
                                            'IMPUTE_NULL': { label: 'Handle missing values', icon: '⬜' },
                                            'REMOVE_CURRENCY': { label: 'Remove currency symbols ($, €)', icon: '💲' },
                                            'REMOVE_PERCENTAGE': { label: 'Remove % symbols', icon: '📊' },
                                            'CAST_ID': { label: 'Clean ID format', icon: '🔑' },
                                            'NORMALIZE_BOOLEAN': { label: 'Standardize yes/no values', icon: '✅' },
                                            'WORD_TO_NUMBER': { label: 'Convert text to numbers', icon: '🔡' },
                                          };
                                          const steps = stepsRaw.split('→').map(s => s.trim());
                                          return (
                                            <tr key={li} className="hover:bg-slate-50/50">
                                              <td className="px-3 py-1.5 font-mono font-medium text-slate-800 whitespace-nowrap">{colName.trim()}</td>
                                              <td className="px-3 py-1.5">
                                                <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase border ${getTypeColor(colType)}`}>{colType}</span>
                                              </td>
                                              <td className="px-3 py-1.5">
                                                <div className="flex flex-wrap gap-1">
                                                  {steps.map((step, si) => {
                                                    const dateMatch = step.match(/^PARSE_DATE\((.+)\)$/);
                                                    const info = dateMatch
                                                      ? { label: `Parse date (${dateMatch[1]})`, icon: '📅' }
                                                      : STEP_LABELS[step] || { label: step, icon: '⚙️' };
                                                    return (
                                                      <span key={si} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded text-[10px] border border-indigo-100" title={step}>
                                                        <span>{info.icon}</span> {info.label}
                                                      </span>
                                                    );
                                                  })}
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-sm text-slate-600 mt-1 leading-relaxed whitespace-pre-wrap">{entry.details}</p>
                              )}

                              {/* Manual Mode: Approval Buttons */}
                              {etlMode === 'manual' && entry.status === 'applied' && (
                                <div className="flex items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
                                  {approvedSteps.has(entry._key) ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-100 px-3 py-1 rounded-full">
                                      <Check className="w-3.5 h-3.5" /> Approved
                                    </span>
                                  ) : skippedSteps.has(entry._key) ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                                      <SkipForward className="w-3.5 h-3.5" /> Skipped
                                    </span>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => setApprovedSteps(prev => new Set([...prev, entry._key]))}
                                        className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 px-3 py-1.5 rounded-lg transition-all shadow-sm"
                                      >
                                        <Check className="w-3.5 h-3.5" /> Approve
                                      </button>
                                      <button
                                        onClick={() => setSkippedSteps(prev => new Set([...prev, entry._key]))}
                                        className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 border border-slate-300 px-3 py-1.5 rounded-lg transition-all"
                                      >
                                        <SkipForward className="w-3.5 h-3.5" /> Skip
                                      </button>
                                      {entry.removedRowSamples && entry.removedRowSamples.length > 0 && (
                                        <button
                                          onClick={() => setEditingRemovedRows({ stepKey: entry._key, rows: entry.removedRowSamples! })}
                                          className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-300 px-3 py-1.5 rounded-lg transition-all"
                                        >
                                          <Edit3 className="w-3.5 h-3.5" /> Edit Removed Rows
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Expanded detail panel */}
                          {isExpanded && expandable && (
                            <div className="px-5 pb-4 pl-14 animate-fade-in">
                              <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-3">

                                {/* Row count change */}
                                {(entry.rowsBefore !== undefined && entry.rowsAfter !== undefined) && (
                                  <div className="flex items-center gap-4 text-xs">
                                    <span className="text-slate-500 font-medium">Rows:</span>
                                    <span className="font-mono font-bold text-slate-700">{entry.rowsBefore.toLocaleString()}</span>
                                    <span className="text-slate-400">→</span>
                                    <span className="font-mono font-bold text-emerald-600">{entry.rowsAfter.toLocaleString()}</span>
                                    {entry.rowsBefore !== entry.rowsAfter && (
                                      <span className="text-red-500 font-semibold bg-red-50 px-2 py-0.5 rounded-full">
                                        −{(entry.rowsBefore - entry.rowsAfter).toLocaleString()} removed
                                      </span>
                                    )}
                                  </div>
                                )}

                                {/* Cells affected */}
                                {entry.affectedRows !== undefined && !entry.rowsBefore && (
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="text-slate-500 font-medium">Cells affected:</span>
                                    <span className="font-mono font-bold text-indigo-600">{entry.affectedRows.toLocaleString()}</span>
                                  </div>
                                )}

                                {/* Affected columns */}
                                {entry.affectedColumns && entry.affectedColumns.length > 0 && (
                                  <div className="text-xs">
                                    <span className="text-slate-500 font-medium mr-2">Columns:</span>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      {entry.affectedColumns.slice(0, 15).map((col, i) => (
                                        <span key={i} className="inline-block px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-md text-[10px] font-mono border border-indigo-200">
                                          {col}
                                        </span>
                                      ))}
                                      {entry.affectedColumns.length > 15 && (
                                        <span className="text-slate-400 text-[10px]">
                                          +{entry.affectedColumns.length - 15} more
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}

                                {/* ─── REMOVED ROWS TABLE ─── */}
                                {entry.removedRowSamples && entry.removedRowSamples.length > 0 && (
                                  <div className="mt-2">
                                    <div className="flex items-center gap-2 mb-2">
                                      <Eye className="w-3.5 h-3.5 text-red-500" />
                                      <span className="text-xs font-semibold text-red-700">Removed Rows Preview</span>
                                      <span className="text-[10px] text-slate-400">
                                        (showing {entry.removedRowSamples.length} of {entry.rowsBefore !== undefined && entry.rowsAfter !== undefined ? entry.rowsBefore - entry.rowsAfter : entry.removedRowSamples.length})
                                      </span>
                                    </div>
                                    <div className="overflow-auto max-h-48 rounded-lg border border-red-200 bg-white">
                                      <table className="w-full text-[11px]">
                                        <thead className="bg-red-50 sticky top-0">
                                          <tr>
                                            {Object.keys(entry.removedRowSamples[0]).map(col => (
                                              <th key={col} className="px-2 py-1.5 text-left font-bold text-red-700 uppercase tracking-wider border-b border-red-200 whitespace-nowrap">
                                                {col}
                                              </th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-red-100">
                                          {entry.removedRowSamples.map((row, ri) => (
                                            <tr key={ri} className="hover:bg-red-50/50">
                                              {Object.keys(entry.removedRowSamples![0]).map(col => {
                                                const val = row[col];
                                                const isEmpty = val === null || val === undefined || val === '';
                                                return (
                                                  <td key={col} className={`px-2 py-1 font-mono whitespace-nowrap ${isEmpty ? 'text-red-400 italic' : 'text-slate-700'}`}>
                                                    {isEmpty ? '∅' : String(val)}
                                                  </td>
                                                );
                                              })}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}

                                {/* ─── TRANSFORM SAMPLES (BEFORE / AFTER) ─── */}
                                {entry.transformSamples && entry.transformSamples.length > 0 && (
                                  <div className="mt-2">
                                    <div className="flex items-center gap-2 mb-2">
                                      <Table className="w-3.5 h-3.5 text-indigo-500" />
                                      <span className="text-xs font-semibold text-indigo-700">Transform Samples</span>
                                    </div>
                                    <div className="overflow-auto max-h-40 rounded-lg border border-indigo-200 bg-white">
                                      <table className="w-full text-[11px]">
                                        <thead className="bg-indigo-50 sticky top-0">
                                          <tr>
                                            <th className="px-2 py-1.5 text-left font-bold text-indigo-700 uppercase tracking-wider border-b border-indigo-200">Column</th>
                                            <th className="px-2 py-1.5 text-left font-bold text-red-600 uppercase tracking-wider border-b border-indigo-200">Before</th>
                                            <th className="px-2 py-1.5 text-center text-slate-400 border-b border-indigo-200">→</th>
                                            <th className="px-2 py-1.5 text-left font-bold text-emerald-600 uppercase tracking-wider border-b border-indigo-200">After</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-indigo-100">
                                          {entry.transformSamples.map((s, si) => (
                                            <tr key={si} className="hover:bg-indigo-50/50">
                                              <td className="px-2 py-1 font-mono text-indigo-700 font-semibold whitespace-nowrap">{s.column}</td>
                                              <td className="px-2 py-1 font-mono text-red-600 whitespace-nowrap bg-red-50/30">{s.before === null || s.before === undefined ? '∅' : String(s.before)}</td>
                                              <td className="px-2 py-1 text-center text-slate-300">→</td>
                                              <td className="px-2 py-1 font-mono text-emerald-700 font-semibold whitespace-nowrap bg-emerald-50/30">{s.after === null || s.after === undefined ? '∅' : String(s.after)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* ─── Right: Schema + Column Info ─────────────────────────── */}
            <div className="space-y-4">

              {/* Column Type Distribution */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <h3 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-indigo-500" />
                  Column Distribution
                </h3>
                <div className="space-y-2">
                  {([
                    { type: 'METRIC', color: 'bg-emerald-500', lightColor: 'bg-emerald-100' },
                    { type: 'DIMENSION', color: 'bg-blue-500', lightColor: 'bg-blue-100' },
                    { type: 'DATE', color: 'bg-amber-500', lightColor: 'bg-amber-100' },
                    { type: 'ID', color: 'bg-purple-500', lightColor: 'bg-purple-100' },
                  ] as const).map(({ type, color, lightColor }) => {
                    const count = dataset.columns.filter(c => c.type === type).length;
                    const pct = dataset.columns.length > 0 ? (count / dataset.columns.length) * 100 : 0;
                    return (
                      <div key={type}>
                        <div className="flex justify-between items-center text-xs mb-1">
                          <span className="font-medium text-slate-600">{type}</span>
                          <span className="text-slate-400">{count} ({pct.toFixed(0)}%)</span>
                        </div>
                        <div className={`w-full h-2 rounded-full ${lightColor} overflow-hidden`}>
                          <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Schema Editor */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
                <h3 className="font-semibold text-slate-900 mb-1 flex items-center gap-2">
                  <Database className="w-4 h-4 text-indigo-500" />
                  Schema Editor
                </h3>
                <p className="text-[11px] text-slate-400 mb-3">Click a type badge to override the auto-detected type</p>

                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                  {dataset.columns.map((col, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-slate-50 transition-colors group">
                      <span className="font-mono text-xs text-slate-600 truncate flex-1 mr-3 group-hover:text-slate-900 transition-colors">{col.name}</span>

                      {editingColumn === col.name ? (
                        <select
                          autoFocus
                          value={col.type}
                          onChange={(e) => handleTypeChange(col.name, e.target.value as ColumnType)}
                          onBlur={() => setEditingColumn(null)}
                          className="px-2 py-1 rounded-lg text-xs font-medium border-2 border-indigo-400 focus:outline-none bg-white text-slate-900 shadow-sm"
                          style={{ color: '#0f172a', backgroundColor: '#ffffff' }}
                        >
                          <option value="METRIC" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>METRIC</option>
                          <option value="DIMENSION" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>DIMENSION</option>
                          <option value="DATE" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>DATE</option>
                          <option value="ID" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>ID</option>
                        </select>
                      ) : (
                        <button
                          onClick={() => setEditingColumn(col.name)}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider border cursor-pointer hover:shadow-sm transition-all flex items-center gap-1 ${getTypeColor(col.type)}`}
                        >
                          {col.type}
                          <ChevronDown className="w-3 h-3 opacity-50" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Timeline Metadata */}
              {dataset.timeContext && (
                <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-5 border border-indigo-100">
                  <h3 className="font-semibold text-indigo-900 mb-3 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-indigo-500" />
                    Time Context
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-indigo-600">Earliest</span>
                      <span className="font-mono font-bold text-indigo-900">{dataset.timeContext.minDate}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-indigo-600">Latest</span>
                      <span className="font-mono font-bold text-indigo-900">{dataset.timeContext.maxDate}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-indigo-600">Anchor Date</span>
                      <span className="font-mono font-bold text-indigo-900">{dataset.timeContext.defaultAnchorDate}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Row Editor Modal */}
      {editingRemovedRows && (
        <RowEditorModal
          rows={editingRemovedRows.rows}
          onClose={() => setEditingRemovedRows(null)}
          onSave={(keptRows) => {
            console.log(`[ETL] Row editor: ${keptRows.length} rows recovered from step ${editingRemovedRows.stepKey}`);
            // Add recovered rows back to the dataset
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
