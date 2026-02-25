import React, { useState, useMemo } from 'react';
import {
  CheckCircle, XCircle, AlertTriangle, Info, Database,
  ChevronDown, ChevronRight, Filter, BarChart3, Shield,
  Sparkles, Layers, ArrowDownUp, Clock
} from 'lucide-react';
import { Dataset, ETLLog, ColumnType } from '../types';

interface ETLViewProps {
  dataset: Dataset;
  onSchemaOverride?: (columnName: string, newType: ColumnType) => void;
}

type LogFilter = 'all' | 'applied' | 'skipped' | 'info';

export const ETLView: React.FC<ETLViewProps> = ({ dataset, onSchemaOverride }) => {
  // All hooks MUST be called before any conditional return (Rules of Hooks)
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());

  const logs = dataset?.etlLogs || [];

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return logs;
    return logs.filter(l => l.status === logFilter);
  }, [logs, logFilter]);

  const stats = useMemo(() => {
    const applied = logs.filter(l => l.status === 'applied').length;
    const skipped = logs.filter(l => l.status === 'skipped').length;
    const flagged = logs.filter(l => l.status === 'info').length;

    // Try to extract summary from last log
    const summaryLog = logs.find(l => l.step === 'Final Summary');
    const totalRows = dataset?.totalRows || 0;
    const rowsBefore = summaryLog?.rowsBefore || totalRows;
    const rowsAfter = summaryLog?.rowsAfter || totalRows;

    // Find quality score from details if available
    let qualityScore = 100;
    if (summaryLog?.details) {
      const match = summaryLog.details.match(/quality:\s*(\d+)/i);
      if (match) qualityScore = parseInt(match[1]);
    }

    return { applied, skipped, flagged, rowsBefore, rowsAfter, qualityScore, total: logs.length };
  }, [logs, dataset?.totalRows]);

  // Guard: no dataset loaded yet (AFTER all hooks)
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

  const toggleStep = (idx: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
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

  return (
    <div className="h-full w-full overflow-auto bg-slate-50">
      <div className="max-w-7xl mx-auto p-6 animate-fade-in">

        {/* ─── Header ─────────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg shadow-indigo-200">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-900">ETL Pipeline</h2>
              <p className="text-sm text-slate-500">
                Automated data cleaning for <span className="font-mono font-semibold text-indigo-600">{dataset.name}</span>
              </p>
            </div>
          </div>
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
              <BarChart3 className="w-4 h-4 text-indigo-500" />
              <span className="text-xs text-slate-500 uppercase tracking-wider font-medium">Quality</span>
            </div>
            <div className={`text-2xl font-bold ${getQualityColor(stats.qualityScore)}`}>{stats.qualityScore}/100</div>
            <div className="w-full h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${getQualityBarColor(stats.qualityScore)}`}
                style={{ width: `${stats.qualityScore}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ─── Left: Pipeline Timeline ──────────────────────────────── */}
          <div className="lg:col-span-2 space-y-4">

            {/* Filter Bar */}
            <div className="flex items-center gap-2 bg-white rounded-xl px-4 py-3 border border-slate-200 shadow-sm">
              <Filter className="w-4 h-4 text-slate-400" />
              <span className="text-sm text-slate-600 font-medium mr-2">Filter:</span>
              {(['all', 'applied', 'skipped', 'info'] as LogFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setLogFilter(f)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${logFilter === f
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                >
                  {f === 'all' ? `All (${stats.total})` :
                    f === 'applied' ? `Applied (${stats.applied})` :
                      f === 'skipped' ? `Skipped (${stats.skipped})` :
                        `Flagged (${stats.flagged})`}
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
                    const isExpanded = expandedSteps.has(idx);
                    const hasDetails = entry.affectedColumns?.length || entry.rowsBefore !== undefined || entry.affectedRows !== undefined;

                    return (
                      <div
                        key={idx}
                        className={`transition-colors ${entry.status === 'applied' ? 'hover:bg-emerald-50/50' :
                          entry.status === 'info' ? 'hover:bg-amber-50/50' :
                            'hover:bg-slate-50/50'
                          }`}
                      >
                        {/* Main row */}
                        <div
                          className="px-5 py-3.5 flex items-start gap-3 cursor-pointer select-none"
                          onClick={() => hasDetails && toggleStep(idx)}
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
                                {hasDetails && (
                                  isExpanded
                                    ? <ChevronDown className="w-4 h-4 text-slate-400" />
                                    : <ChevronRight className="w-4 h-4 text-slate-400" />
                                )}
                              </div>
                            </div>
                            <p className="text-sm text-slate-600 mt-1 leading-relaxed">{entry.details}</p>
                          </div>
                        </div>

                        {/* Expanded detail panel */}
                        {isExpanded && hasDetails && (
                          <div className="px-5 pb-4 pl-14">
                            <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 space-y-2">
                              {(entry.rowsBefore !== undefined && entry.rowsAfter !== undefined) && (
                                <div className="flex items-center gap-4 text-xs">
                                  <span className="text-slate-500">Rows:</span>
                                  <span className="font-mono font-bold text-slate-700">{entry.rowsBefore.toLocaleString()}</span>
                                  <span className="text-slate-400">→</span>
                                  <span className="font-mono font-bold text-emerald-600">{entry.rowsAfter.toLocaleString()}</span>
                                  {entry.rowsBefore !== entry.rowsAfter && (
                                    <span className="text-red-500 font-medium">
                                      (−{(entry.rowsBefore - entry.rowsAfter).toLocaleString()})
                                    </span>
                                  )}
                                </div>
                              )}
                              {entry.affectedRows !== undefined && !entry.rowsBefore && (
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="text-slate-500">Cells affected:</span>
                                  <span className="font-mono font-bold text-indigo-600">{entry.affectedRows.toLocaleString()}</span>
                                </div>
                              )}
                              {entry.affectedColumns && entry.affectedColumns.length > 0 && (
                                <div className="text-xs">
                                  <span className="text-slate-500 mr-2">Columns:</span>
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
  );
};
