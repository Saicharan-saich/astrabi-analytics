/**
 * DataCleaningPanel.tsx — Interactive Data Cleaning Tools
 * 
 * User-facing cleaning operations integrated into the ETL view.
 * Provides: dedup, missing value imputation, string normalization,
 * outlier detection, find/replace, column split/merge, data quality report.
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
    Trash2, Droplets, Type, TrendingDown, Search, Scissors, Merge,
    Shield, ChevronDown, ChevronRight, Play, AlertTriangle, CheckCircle,
    BarChart3, XCircle, Undo2, Redo2, Sparkles, Eye, X, Info
} from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import {
    findDuplicates, removeDuplicates, imputeMissing, normalizeStrings,
    detectOutliers, handleOutliers, findAndReplace, splitColumn, mergeColumns,
    generateQualityReport, CleaningHistory, CleaningLogEntry,
    DedupKeep, ImputeStrategy, CaseMode, OutlierMethod, OutlierAction,
    DataQualityReport, DuplicateGroup
} from '../services/dataCleaningEngine';

interface DataCleaningPanelProps {
    dataset: Dataset;
    onDataCleaned: (newRows: Record<string, any>[], log: CleaningLogEntry) => void;
}

type CleaningTool = 'quality' | 'duplicates' | 'missing' | 'strings' | 'outliers' | 'findreplace' | 'split' | 'merge';

// Static accent classes per tool (compiled Tailwind purges dynamic `bg-${x}` names,
// so the active-tab colours must be spelled out) + a plain-English description.
const TOOL_META: Record<CleaningTool, { active: string; icon: string; desc: string }> = {
    quality: { active: 'bg-indigo-600 border-indigo-600 text-white', icon: 'text-indigo-500', desc: 'A health report for your data — completeness, uniqueness, consistency, and any issues found.' },
    duplicates: { active: 'bg-rose-600 border-rose-600 text-white', icon: 'text-rose-500', desc: 'Find and remove duplicate rows so counts and totals aren’t inflated.' },
    missing: { active: 'bg-blue-600 border-blue-600 text-white', icon: 'text-blue-500', desc: 'Fill or handle blank values in a column with a strategy you choose.' },
    strings: { active: 'bg-purple-600 border-purple-600 text-white', icon: 'text-purple-500', desc: 'Tidy text — trim spaces, fix casing, and collapse duplicate spacing.' },
    outliers: { active: 'bg-amber-500 border-amber-500 text-white', icon: 'text-amber-500', desc: 'Detect and handle extreme values that would distort averages and totals.' },
    findreplace: { active: 'bg-teal-600 border-teal-600 text-white', icon: 'text-teal-500', desc: 'Search a column and replace matching values — optionally with regex.' },
    split: { active: 'bg-orange-600 border-orange-600 text-white', icon: 'text-orange-500', desc: 'Split one column into several using a delimiter (e.g. "red;blue").' },
    merge: { active: 'bg-cyan-600 border-cyan-600 text-white', icon: 'text-cyan-500', desc: 'Combine several columns into one (e.g. first + last name).' },
};

// ─── Quality Score Badge ─────────────────────────────────────────
const QualityBadge: React.FC<{ score: number; size?: 'sm' | 'lg' }> = ({ score, size = 'sm' }) => {
    // Static classes only — compiled Tailwind purges dynamic `text-${color}-600`.
    const color = score >= 90 ? 'text-emerald-600 dark:text-emerald-400' : score >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
    const cls = size === 'lg' ? 'text-4xl' : 'text-lg';
    return <span className={`${cls} font-black ${color} tabular-nums`}>{score.toFixed(0)}%</span>;
};

// ─── Column Quality Bar ──────────────────────────────────────────
const QualityBar: React.FC<{ value: number; label: string }> = ({ value, label }) => {
    const color = value >= 90 ? 'bg-emerald-500' : value >= 70 ? 'bg-amber-500' : 'bg-red-500';
    return (
        <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 dark:text-slate-400 w-20 shrink-0">{label}</span>
            <div className="flex-1 h-1.5 bg-slate-100 dark:bg-white/10 rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${value}%` }} />
            </div>
            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300 w-8 text-right tabular-nums">{value.toFixed(0)}%</span>
        </div>
    );
};

export const DataCleaningPanel: React.FC<DataCleaningPanelProps> = ({ dataset, onDataCleaned }) => {
    const [activeTool, setActiveTool] = useState<CleaningTool>('quality');
    const [cleaningLogs, setCleaningLogs] = useState<CleaningLogEntry[]>([]);

    // ── Tool State ──
    // Dedup
    const [dedupColumns, setDedupColumns] = useState<string[]>([]);
    const [dedupKeep, setDedupKeep] = useState<DedupKeep>('first');
    const [dedupPreview, setDedupPreview] = useState<DuplicateGroup[] | null>(null);

    // Missing values
    const [imputeColumn, setImputeColumn] = useState('');
    const [imputeStrategy, setImputeStrategy] = useState<ImputeStrategy>('mean');
    const [imputeCustomValue, setImputeCustomValue] = useState('');

    // String normalization
    const [normColumn, setNormColumn] = useState('');
    const [normTrim, setNormTrim] = useState(true);
    const [normCase, setNormCase] = useState<CaseMode | ''>('');
    const [normDedup, setNormDedup] = useState(true);

    // Outliers
    const [outlierColumn, setOutlierColumn] = useState('');
    const [outlierMethod, setOutlierMethod] = useState<OutlierMethod>('iqr');
    const [outlierAction, setOutlierAction] = useState<OutlierAction>('cap');
    const [outlierThreshold, setOutlierThreshold] = useState(1.5);

    // Find & Replace
    const [frColumn, setFrColumn] = useState('');
    const [frFind, setFrFind] = useState('');
    const [frReplace, setFrReplace] = useState('');
    const [frRegex, setFrRegex] = useState(false);
    const [frCaseSensitive, setFrCaseSensitive] = useState(false);

    // Split/Merge
    const [splitCol, setSplitCol] = useState('');
    const [splitDelimiter, setSplitDelimiter] = useState(',');
    const [mergeCols, setMergeCols] = useState<string[]>([]);
    const [mergeNewName, setMergeNewName] = useState('');
    const [mergeSeparator, setMergeSeparator] = useState(' ');

    // Data quality report
    const qualityReport = useMemo(() => {
        if (!dataset?.rows?.length) return null;
        return generateQualityReport(dataset.rows);
    }, [dataset?.rows]);

    const columns = dataset?.columns || [];
    const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const dimCols = columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name);
    const allColNames = columns.map(c => c.name);

    // ── Apply cleaning operation ──
    const applyCleaning = useCallback((result: { data: Record<string, any>[]; log: CleaningLogEntry }) => {
        setCleaningLogs(prev => [...prev, result.log]);
        onDataCleaned(result.data, result.log);
    }, [onDataCleaned]);

    // ── Tool definitions ──
    const tools: { key: CleaningTool; label: string; icon: React.ReactNode; color: string }[] = [
        { key: 'quality', label: 'Data Quality', icon: <BarChart3 className="w-4 h-4" />, color: 'indigo' },
        { key: 'duplicates', label: 'Duplicates', icon: <Trash2 className="w-4 h-4" />, color: 'red' },
        { key: 'missing', label: 'Missing Values', icon: <Droplets className="w-4 h-4" />, color: 'blue' },
        { key: 'strings', label: 'Strings', icon: <Type className="w-4 h-4" />, color: 'purple' },
        { key: 'outliers', label: 'Outliers', icon: <TrendingDown className="w-4 h-4" />, color: 'amber' },
        { key: 'findreplace', label: 'Find/Replace', icon: <Search className="w-4 h-4" />, color: 'teal' },
        { key: 'split', label: 'Split Column', icon: <Scissors className="w-4 h-4" />, color: 'orange' },
        { key: 'merge', label: 'Merge Columns', icon: <Merge className="w-4 h-4" />, color: 'cyan' },
    ];

    const selectClass = "w-full px-3 py-2 bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-white/10 rounded-xl text-sm text-slate-800 dark:text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all";
    const inputClass = "w-full px-3 py-2 bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-white/10 rounded-xl text-sm text-slate-800 dark:text-slate-100 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all";
    const btnPrimary = "flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold rounded-xl shadow-lg shadow-indigo-200 dark:shadow-none hover:shadow-xl hover:scale-[1.02] transition-all duration-200";
    const labelClass = "block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-white/10 shadow-sm overflow-hidden">
            {/* ── Header ── */}
            <div className="px-6 py-4 border-b border-slate-100 dark:border-white/10 bg-gradient-to-r from-slate-50 to-indigo-50/40 dark:from-white/[0.03] dark:to-indigo-500/[0.06]">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-gradient-to-br from-violet-500 to-indigo-600 rounded-xl shadow-lg shadow-indigo-200 dark:shadow-none">
                        <Sparkles className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white">Cleaning Tools</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Pick a tool below — fix, transform, and refine your data by hand</p>
                    </div>
                    {qualityReport && (
                        <div className="text-right">
                            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Quality Score</div>
                            <QualityBadge score={qualityReport.overallScore} size="lg" />
                        </div>
                    )}
                </div>
            </div>

            {/* ── Tool Selector (pills) + active description ── */}
            <div className="px-4 pt-4 pb-3 border-b border-slate-100 dark:border-white/10">
                <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
                    {tools.map(tool => {
                        const active = activeTool === tool.key;
                        const meta = TOOL_META[tool.key];
                        return (
                            <button
                                key={tool.key}
                                onClick={() => setActiveTool(tool.key)}
                                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap border transition-all ${
                                    active
                                        ? `${meta.active} shadow-sm`
                                        : 'bg-slate-50 dark:bg-white/5 text-slate-500 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10'
                                }`}
                            >
                                <span className={active ? 'text-white' : meta.icon}>{tool.icon}</span>
                                {tool.label}
                            </button>
                        );
                    })}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2.5 px-1">{TOOL_META[activeTool].desc}</p>
            </div>

            {/* ── Tool Content ── */}
            <div className="p-6">
                {/* ═══ DATA QUALITY REPORT ═══ */}
                {activeTool === 'quality' && qualityReport && (
                    <div className="space-y-4">
                        {/* Issues */}
                        {qualityReport.issues.length > 0 && (
                            <div className="space-y-2">
                                <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200">Issues Found</h4>
                                {qualityReport.issues.slice(0, 10).map((issue, i) => (
                                    <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                                        issue.severity === 'critical' ? 'bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-700 dark:text-red-300' :
                                        issue.severity === 'warning' ? 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-amber-700 dark:text-amber-300' :
                                        'bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-300'
                                    }`}>
                                        {issue.severity === 'critical' ? <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> :
                                         issue.severity === 'warning' ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> :
                                         <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                                        {issue.message}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* Per-column quality */}
                        <div>
                            <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Column Quality</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {qualityReport.columns.map(col => (
                                    <div key={col.column} className="bg-slate-50 dark:bg-white/5 rounded-xl p-4 border border-slate-100 dark:border-white/10">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-sm font-bold text-slate-800 dark:text-slate-100 capitalize">{col.column.replace(/_/g, ' ')}</span>
                                            <QualityBadge score={col.overallScore} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <QualityBar value={col.completeness} label="Complete" />
                                            <QualityBar value={Math.min(col.uniqueness, 100)} label="Unique" />
                                            <QualityBar value={col.consistency} label="Consistent" />
                                        </div>
                                        <div className="flex gap-3 mt-2 text-[10px] text-slate-400 dark:text-slate-500">
                                            {col.nullCount > 0 && <span>🕳️ {col.nullCount} nulls</span>}
                                            {col.outlierCount > 0 && <span>📊 {col.outlierCount} outliers</span>}
                                            <span className="ml-auto">{col.dataType}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* ═══ DUPLICATE REMOVAL ═══ */}
                {activeTool === 'duplicates' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Key Columns (leave empty for exact row match)</label>
                            <div className="flex flex-wrap gap-2 mb-2">
                                {allColNames.map(col => (
                                    <button
                                        key={col}
                                        onClick={() => setDedupColumns(prev =>
                                            prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
                                        )}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                            dedupColumns.includes(col)
                                                ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/40'
                                                : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                                        }`}
                                    >
                                        {col.replace(/_/g, ' ')}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Keep Strategy</label>
                            <select value={dedupKeep} onChange={e => setDedupKeep(e.target.value as DedupKeep)} className={selectClass}>
                                <option value="first">Keep first occurrence</option>
                                <option value="last">Keep last occurrence</option>
                                <option value="none">Remove all duplicates</option>
                            </select>
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => {
                                const dupes = findDuplicates(dataset.rows, dedupColumns.length > 0 ? dedupColumns : undefined);
                                setDedupPreview(dupes);
                            }} className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 text-sm font-bold rounded-xl hover:bg-slate-200 transition-all">
                                <Eye className="w-4 h-4" /> Preview ({dedupPreview ? `${dedupPreview.length} groups` : '?'})
                            </button>
                            <button onClick={() => {
                                const result = removeDuplicates(dataset.rows, dedupColumns.length > 0 ? dedupColumns : undefined, dedupKeep);
                                if (result.changes > 0) applyCleaning(result);
                                setDedupPreview(null);
                            }} className={btnPrimary}>
                                <Trash2 className="w-4 h-4" /> Remove Duplicates
                            </button>
                        </div>
                        {dedupPreview && dedupPreview.length > 0 && (
                            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-700">
                                Found <strong>{dedupPreview.length}</strong> duplicate groups ({dedupPreview.reduce((s, g) => s + g.rows.length - 1, 0)} rows to remove)
                            </div>
                        )}
                        {dedupPreview && dedupPreview.length === 0 && (
                            <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-xl p-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                                <CheckCircle className="w-4 h-4" /> No duplicates found!
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ MISSING VALUES ═══ */}
                {activeTool === 'missing' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Column</label>
                            <select value={imputeColumn} onChange={e => setImputeColumn(e.target.value)} className={selectClass}>
                                <option value="">Select column...</option>
                                {allColNames.map(c => {
                                    const nullCount = dataset.rows.filter(r => r[c] == null || r[c] === '' || r[c] === 'null').length;
                                    return <option key={c} value={c}>{c.replace(/_/g, ' ')} {nullCount > 0 ? `(${nullCount} missing)` : '✓'}</option>;
                                })}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Imputation Strategy</label>
                            <select value={imputeStrategy} onChange={e => setImputeStrategy(e.target.value as ImputeStrategy)} className={selectClass}>
                                <option value="mean">Mean (average)</option>
                                <option value="median">Median (middle value)</option>
                                <option value="mode">Mode (most common)</option>
                                <option value="zero">Fill with 0</option>
                                <option value="custom">Custom value</option>
                                <option value="forward_fill">Forward fill (use previous row)</option>
                                <option value="backward_fill">Backward fill (use next row)</option>
                                <option value="drop_row">Drop rows with missing values</option>
                            </select>
                        </div>
                        {imputeStrategy === 'custom' && (
                            <div>
                                <label className={labelClass}>Custom Fill Value</label>
                                <input value={imputeCustomValue} onChange={e => setImputeCustomValue(e.target.value)} className={inputClass} placeholder="Enter value..." />
                            </div>
                        )}
                        <button
                            disabled={!imputeColumn}
                            onClick={() => {
                                if (!imputeColumn) return;
                                const result = imputeMissing(dataset.rows, imputeColumn, imputeStrategy, imputeCustomValue || undefined);
                                if (result.changes > 0) applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${!imputeColumn ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <Droplets className="w-4 h-4" /> Fill Missing Values
                        </button>
                    </div>
                )}

                {/* ═══ STRING NORMALIZATION ═══ */}
                {activeTool === 'strings' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Column</label>
                            <select value={normColumn} onChange={e => setNormColumn(e.target.value)} className={selectClass}>
                                <option value="">Select column...</option>
                                {dimCols.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                            </select>
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={normTrim} onChange={e => setNormTrim(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <span className="text-sm text-slate-700">Trim whitespace</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={normDedup} onChange={e => setNormDedup(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <span className="text-sm text-slate-700">Remove extra spaces</span>
                            </label>
                        </div>
                        <div>
                            <label className={labelClass}>Case Standardization</label>
                            <select value={normCase} onChange={e => setNormCase(e.target.value as CaseMode | '')} className={selectClass}>
                                <option value="">No change</option>
                                <option value="lower">lowercase</option>
                                <option value="upper">UPPERCASE</option>
                                <option value="title">Title Case</option>
                                <option value="sentence">Sentence case</option>
                            </select>
                        </div>
                        <button
                            disabled={!normColumn}
                            onClick={() => {
                                if (!normColumn) return;
                                const result = normalizeStrings(dataset.rows, normColumn, {
                                    trim: normTrim,
                                    caseMode: normCase || undefined,
                                    deduplicateSpaces: normDedup,
                                });
                                if (result.changes > 0) applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${!normColumn ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <Type className="w-4 h-4" /> Normalize Strings
                        </button>
                    </div>
                )}

                {/* ═══ OUTLIER DETECTION ═══ */}
                {activeTool === 'outliers' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Numeric Column</label>
                            <select value={outlierColumn} onChange={e => setOutlierColumn(e.target.value)} className={selectClass}>
                                <option value="">Select column...</option>
                                {metricCols.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                            </select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>Method</label>
                                <select value={outlierMethod} onChange={e => setOutlierMethod(e.target.value as OutlierMethod)} className={selectClass}>
                                    <option value="iqr">IQR (Interquartile Range)</option>
                                    <option value="zscore">Z-Score (Standard Deviations)</option>
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Threshold</label>
                                <input type="number" step="0.1" min="0.5" max="5" value={outlierThreshold} onChange={e => setOutlierThreshold(Number(e.target.value))} className={inputClass} />
                            </div>
                        </div>
                        <div>
                            <label className={labelClass}>Action</label>
                            <select value={outlierAction} onChange={e => setOutlierAction(e.target.value as OutlierAction)} className={selectClass}>
                                <option value="cap">Cap/Winsorize (clamp to bounds)</option>
                                <option value="remove">Remove outlier rows</option>
                                <option value="nullify">Set to null</option>
                                <option value="flag">Flag with new column</option>
                            </select>
                        </div>
                        {outlierColumn && (() => {
                            const det = detectOutliers(dataset.rows, outlierColumn, outlierMethod, outlierThreshold);
                            return det.outlierCount > 0 ? (
                                <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
                                    Found <strong>{det.outlierCount}</strong> outliers in "{outlierColumn}" — bounds: [{det.lowerBound.toFixed(2)}, {det.upperBound.toFixed(2)}]
                                </div>
                            ) : (
                                <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-xl p-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4" /> No outliers detected
                                </div>
                            );
                        })()}
                        <button
                            disabled={!outlierColumn}
                            onClick={() => {
                                if (!outlierColumn) return;
                                const result = handleOutliers(dataset.rows, outlierColumn, outlierMethod, outlierAction, outlierThreshold);
                                if (result.changes > 0) applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${!outlierColumn ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <TrendingDown className="w-4 h-4" /> Handle Outliers
                        </button>
                    </div>
                )}

                {/* ═══ FIND & REPLACE ═══ */}
                {activeTool === 'findreplace' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Column</label>
                            <select value={frColumn} onChange={e => setFrColumn(e.target.value)} className={selectClass}>
                                <option value="">Select column...</option>
                                {allColNames.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                            </select>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>Find</label>
                                <input value={frFind} onChange={e => setFrFind(e.target.value)} className={inputClass} placeholder="Text to find..." />
                            </div>
                            <div>
                                <label className={labelClass}>Replace With</label>
                                <input value={frReplace} onChange={e => setFrReplace(e.target.value)} className={inputClass} placeholder="Replacement text..." />
                            </div>
                        </div>
                        <div className="flex gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={frRegex} onChange={e => setFrRegex(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <span className="text-sm text-slate-700">Use Regex</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={frCaseSensitive} onChange={e => setFrCaseSensitive(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <span className="text-sm text-slate-700">Case sensitive</span>
                            </label>
                        </div>
                        <button
                            disabled={!frColumn || !frFind}
                            onClick={() => {
                                if (!frColumn || !frFind) return;
                                const result = findAndReplace(dataset.rows, frColumn, frFind, frReplace, { useRegex: frRegex, caseSensitive: frCaseSensitive });
                                if (result.changes > 0) applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${!frColumn || !frFind ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <Search className="w-4 h-4" /> Find & Replace
                        </button>
                    </div>
                )}

                {/* ═══ SPLIT COLUMN ═══ */}
                {activeTool === 'split' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Column to Split</label>
                            <select value={splitCol} onChange={e => setSplitCol(e.target.value)} className={selectClass}>
                                <option value="">Select column...</option>
                                {dimCols.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>Delimiter</label>
                            <select value={splitDelimiter} onChange={e => setSplitDelimiter(e.target.value)} className={selectClass}>
                                <option value=",">Comma (,)</option>
                                <option value=" ">Space ( )</option>
                                <option value="-">Dash (-)</option>
                                <option value="_">Underscore (_)</option>
                                <option value="/">Slash (/)</option>
                                <option value="|">Pipe (|)</option>
                            </select>
                        </div>
                        <button
                            disabled={!splitCol}
                            onClick={() => {
                                if (!splitCol) return;
                                const result = splitColumn(dataset.rows, splitCol, splitDelimiter);
                                applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${!splitCol ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <Scissors className="w-4 h-4" /> Split Column
                        </button>
                    </div>
                )}

                {/* ═══ MERGE COLUMNS ═══ */}
                {activeTool === 'merge' && (
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass}>Columns to Merge (select 2+)</label>
                            <div className="flex flex-wrap gap-2 mb-2">
                                {allColNames.map(col => (
                                    <button
                                        key={col}
                                        onClick={() => setMergeCols(prev =>
                                            prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
                                        )}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                                            mergeCols.includes(col)
                                                ? 'bg-cyan-100 text-cyan-700 border-cyan-300'
                                                : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                                        }`}
                                    >
                                        {col.replace(/_/g, ' ')}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className={labelClass}>New Column Name</label>
                                <input value={mergeNewName} onChange={e => setMergeNewName(e.target.value)} className={inputClass} placeholder="e.g. full_name" />
                            </div>
                            <div>
                                <label className={labelClass}>Separator</label>
                                <select value={mergeSeparator} onChange={e => setMergeSeparator(e.target.value)} className={selectClass}>
                                    <option value=" ">Space</option>
                                    <option value=", ">Comma + Space</option>
                                    <option value="-">Dash</option>
                                    <option value="_">Underscore</option>
                                    <option value="">None</option>
                                </select>
                            </div>
                        </div>
                        <button
                            disabled={mergeCols.length < 2 || !mergeNewName.trim()}
                            onClick={() => {
                                if (mergeCols.length < 2 || !mergeNewName.trim()) return;
                                const result = mergeColumns(dataset.rows, mergeCols, mergeNewName.trim(), mergeSeparator);
                                applyCleaning(result);
                            }}
                            className={`${btnPrimary} ${mergeCols.length < 2 || !mergeNewName.trim() ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <Merge className="w-4 h-4" /> Merge Columns
                        </button>
                    </div>
                )}
            </div>

            {/* ── Cleaning Log ── */}
            {cleaningLogs.length > 0 && (
                <div className="border-t border-slate-100 dark:border-white/10 px-6 py-4 bg-slate-50/50 dark:bg-white/[0.02]">
                    <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Cleaning History ({cleaningLogs.length} operations)</h4>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {cleaningLogs.map((log, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900/50 px-3 py-2 rounded-lg border border-slate-100 dark:border-white/10">
                                <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                <span className="font-bold text-slate-700 dark:text-slate-200">{log.operation}</span>
                                <span className="text-slate-400">—</span>
                                <span className="flex-1 truncate">{log.details}</span>
                                <span className="text-slate-400 shrink-0">{log.rowsAffected} affected</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
