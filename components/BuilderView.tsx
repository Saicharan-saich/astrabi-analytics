import React, { useState, useMemo, useCallback, useRef } from 'react';
import { QuestionBuilder } from './QuestionBuilder';
import { ChartVisualization } from './ChartVisualization';
import { AnalysisResult, Dataset, QueryConfig, FormattingConfig, AggregationType, TimeGrain, AnalysisType, ColumnType } from '../types';
import { runAnalysis } from '../services/analysisEngine';
import { getCalculationDisplayName, applyMultipleCalculations, type TableCalculation, type CalculatedColumn } from '../utils/tableCalculations';
import { Tooltip } from './Tooltip';
import { useAppStore } from '../store/useAppStore';
import { AIInsightPanel } from './AIInsightPanel';

import { AlertTriangle, Code, Play, Palette, X, Pin, CheckCircle2, Activity, TrendingUp, BarChart3, BarChart2, Download, Loader2, Clock, Trash2, Save, FolderOpen, Eye, EyeOff, Table2, PanelTopClose, RotateCcw, RefreshCw } from 'lucide-react';

interface BuilderViewProps {
    dataset: Dataset;
    formatting?: FormattingConfig;
    onUpdateFormatting?: (config: FormattingConfig) => void;
    onPin?: (title: string, result: AnalysisResult) => void;
}

export const BuilderView: React.FC<BuilderViewProps> = ({ dataset, formatting, onUpdateFormatting, onPin }) => {
    const [result, setResult] = useState<AnalysisResult | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [chartType, setChartType] = useState<any>('bar');
    const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
    const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
    const [showGrowthChart, setShowGrowthChart] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [lastRunConfig, setLastRunConfig] = useState<any>(null);
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [showSavedDrawer, setShowSavedDrawer] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
    const [isBuilderCollapsed, setIsBuilderCollapsed] = useState(false);
    const [contentTab, setContentTab] = useState<'visual' | 'sql' | 'data'>('visual');
    const chartContainerRef = useRef<HTMLDivElement>(null);

    const { queryHistory, addToHistory, clearHistory, savedQuestions, saveQuestion, deleteQuestion } = useAppStore();

    // Export CSV helper
    const exportToCSV = () => {
        if (!result) return;
        const data = tableData.data;
        if (!data.length) return;
        const keys = Object.keys(data[0]);
        const csvRows = [
            keys.join(','),
            ...data.map(row => keys.map(k => {
                const val = row[k];
                const str = String(val ?? '');
                return str.includes(',') ? `"${str}"` : str;
            }).join(','))
        ];
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.yLabel || 'export'}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // anchor_date: defaults to MAX of the anchor date column (defaultAnchorDate)
    const [anchorColumn, setAnchorColumn] = useState<string>(
        dataset.timeContext?.anchorDateColumn || ''
    );
    const [asOfDate, setAsOfDate] = useState<string>(
        dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0]
    );
    const [isUserOverride, setIsUserOverride] = useState(false);

    // Recompute when dataset changes
    React.useEffect(() => {
        const tc = dataset.timeContext;
        if (tc) {
            setAnchorColumn(tc.anchorDateColumn || '');
            if (!isUserOverride) {
                setAsOfDate(tc.defaultAnchorDate || tc.maxDate);
            }
        }
    }, [dataset.id]);

    // User manually changes AS OF date
    const handleAsOfDateChange = (date: string) => {
        setAsOfDate(date);
        setIsUserOverride(true);
    };

    // When user changes anchor column, recompute AS OF date (not a user override)
    const handleAnchorColumnChange = (col: string) => {
        setAnchorColumn(col);
        const maxForCol = dataset.timeContext?.dateColumnMaxDates?.[col];
        if (maxForCol && !isUserOverride) setAsOfDate(maxForCol);
    };

    const handleRun = (config: any) => {
        try {
            setError(null);
            setIsLoading(true);
            setIsAIInsightOpen(false); // Reset AI insight on new question

            const query: QueryConfig = {
                questionId: 'custom_builder',
                metric: config.metric,
                dimension: config.dimension,
                aggregation: config.aggregation || AggregationType.SUM,
                timeGrain: TimeGrain.RAW,
                analysisType: AnalysisType.STANDARD,
                timeFilter: config.timeFilter,
                filters: config.filters,
                measureFilters: config.measureFilters,
                dateFilters: config.dateFilters,
                limit: config.limit,
                sort: config.sort,
                chartType: chartType,
                asOfDate: asOfDate,
                comparison: config.comparison || result?.config?.comparison
            };

            const res = runAnalysis(dataset, query);

            // Apply the recommended chart type from the question/registry
            if (res.vis) {
                setChartType(res.vis);
            }

            setResult(res);
            setLastRunConfig(config);
            setIsLoading(false);

            // Push to query history
            addToHistory({
                label: res.yLabel || `${config.metric} by ${config.dimension || 'Total'}`,
                config: config,
                timestamp: Date.now()
            });
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'An error occurred during analysis');
            setResult(undefined);
            setIsLoading(false);
        }
    };

    // --- Save Question ---
    const handleSaveQuestion = useCallback(() => {
        if (!saveName.trim() || !lastRunConfig) return;
        const id = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36);
        saveQuestion({ id, name: saveName.trim(), config: lastRunConfig, createdAt: Date.now() });
        setSaveName('');
        setShowSaveModal(false);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
    }, [saveName, lastRunConfig, saveQuestion]);

    // --- Click-to-Drill ---
    const handleDrillDown = useCallback((dimensionValue: string) => {
        if (!result || !lastRunConfig) return;
        const dimCol = result.xKey;
        const currentFilters = lastRunConfig.filters || {};
        const updatedFilters = { ...currentFilters, [dimCol]: [dimensionValue] };
        const drillConfig = { ...lastRunConfig, filters: updatedFilters };
        handleRun(drillConfig);
    }, [result, lastRunConfig]);

    const tableData = useMemo(() => {
        if (!result) return { data: [], columns: [] as CalculatedColumn[] };

        // Build active calcs: comparison auto-adds pct_diff_from_prev
        let activeCalcs: TableCalculation[] = [];
        if (result?.config?.comparison === 'previous_period') {
            activeCalcs.push('pct_diff_from_prev');
        }
        // Add user-selected calculations
        const userCalcs = (formatting?.tableCalculations || []).filter(c => c !== 'none');
        for (const c of userCalcs) {
            if (!activeCalcs.includes(c)) activeCalcs.push(c);
        }

        if (activeCalcs.length === 0) {
            return { data: result.data || [], columns: [] as CalculatedColumn[] };
        }

        const { transformedData, columns } = applyMultipleCalculations(
            result.data,
            result.yKey,
            activeCalcs,
            result.yLabel,
            formatting?.numberFormat || 'raw',
            formatting?.movingAvgWindow || 3
        );
        return { data: transformedData, columns };
    }, [result, formatting?.tableCalculations, formatting?.numberFormat, formatting?.movingAvgWindow]);

    return (
        <div className="flex flex-col h-full bg-slate-50 overflow-hidden">

            {/* â”€â”€â”€ COLLAPSIBLE BUILDER â”€â”€â”€ */}
            <div className={`bg-white border-b border-slate-200 shadow-sm z-10 shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isBuilderCollapsed ? 'max-h-0 border-b-0' : 'max-h-[500px]'}`}>
                <QuestionBuilder
                    dataset={dataset}
                    onRun={handleRun}
                    asOfDate={asOfDate}
                    onDateChange={handleAsOfDateChange}
                    anchorColumn={anchorColumn}
                    onAnchorColumnChange={handleAnchorColumnChange}
                />
            </div>

            {/* â”€â”€â”€ TOOLBAR â”€â”€â”€ */}
            <div className="flex items-center gap-2 bg-white border-b border-slate-200 px-3 py-1.5 shrink-0 shadow-sm z-10">
                {/* Builder Toggle */}
                <button
                    onClick={() => setIsBuilderCollapsed(!isBuilderCollapsed)}
                    className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 bg-slate-100 hover:bg-indigo-50 px-2.5 py-1.5 rounded-lg transition-all border border-slate-200"
                    title={isBuilderCollapsed ? 'Show Builder' : 'Hide Builder'}
                >
                    {isBuilderCollapsed ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    {isBuilderCollapsed ? 'Show Builder' : 'Hide Builder'}
                </button>

                {/* Content Tabs */}
                {result && !error && (
                    <>
                        <div className="w-px h-5 bg-slate-200 mx-1" />
                        {(['visual', 'sql', 'data'] as const).map(tab => (
                            <button
                                key={tab}
                                onClick={() => setContentTab(tab)}
                                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all ${contentTab === tab
                                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                                    : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                    }`}
                            >
                                {tab === 'visual' ? <><BarChart2 className="w-3 h-3" /> Visual</> :
                                    tab === 'sql' ? <><Code className="w-3 h-3" /> SQL</> :
                                        <><Table2 className="w-3 h-3" /> Data</>}
                            </button>
                        ))}
                    </>
                )}

                {/* X/Y Axis Toggles */}
                {result && !error && contentTab === 'visual' && formatting && onUpdateFormatting && (
                    <div className="flex items-center gap-1 ml-1">
                        <span className="text-[10px] text-slate-400 font-medium mr-0.5">Axis:</span>
                        <button
                            onClick={() => onUpdateFormatting({ ...formatting, showXAxis: !(formatting.showXAxis ?? formatting.showAxis ?? false) })}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all border ${(formatting.showXAxis ?? formatting.showAxis ?? false)
                                ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                                : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100'
                                }`}
                            title="Toggle X-Axis visibility"
                        >X</button>
                        <button
                            onClick={() => onUpdateFormatting({ ...formatting, showYAxis: !(formatting.showYAxis ?? formatting.showAxis ?? false) })}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all border ${(formatting.showYAxis ?? formatting.showAxis ?? false)
                                ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                                : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100'
                                }`}
                            title="Toggle Y-Axis visibility"
                        >Y</button>
                    </div>
                )}

                <div className="flex-1" />

                {/* Compact KPI + Actions */}
                {result && !error && (
                    <div className="flex items-center gap-2">
                        {/* KPI Summary */}
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-slate-400 font-medium">{result.yLabel}</span>
                            <span className="font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-teal-500 text-lg">
                                {result.kpi
                                    ? (typeof result.kpi === 'number' ? result.kpi.toLocaleString() : result.kpi)
                                    : (result.data.reduce((a: number, b: any) => a + (Number(b[result.yKey]) || 0), 0)).toLocaleString(undefined, { maximumFractionDigits: 1 })}
                            </span>
                            <span className="bg-indigo-100 text-indigo-800 text-[10px] px-1.5 py-0.5 rounded-full font-medium">
                                {result.data.length} rows
                            </span>
                        </div>

                        {/* Export */}
                        <button onClick={exportToCSV} className="flex items-center text-[11px] font-bold text-slate-500 hover:text-indigo-700 bg-slate-100 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-all border border-slate-200" title="Export CSV">
                            <Download className="w-3 h-3 mr-1" /> Export
                        </button>

                        {/* Save */}
                        <div className="relative">
                            <button
                                onClick={() => { setShowSaveModal(!showSaveModal); setShowSavedDrawer(false); setShowHistory(false); }}
                                className={`flex items-center text-[11px] font-bold px-2 py-1 rounded-lg transition-all border ${saveSuccess
                                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                    : showSaveModal
                                        ? 'text-indigo-700 bg-indigo-50 border-indigo-200'
                                        : 'text-slate-500 bg-slate-100 hover:text-indigo-700 hover:bg-indigo-50 border-slate-200'
                                    }`}
                                disabled={!lastRunConfig}
                            >
                                {saveSuccess ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                                {saveSuccess ? 'Saved!' : 'Save'}
                            </button>
                            {showSaveModal && (
                                <div className="absolute right-0 top-full mt-2 w-72 bg-white border border-slate-200 rounded-xl shadow-xl z-30 p-4">
                                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Save Question</h4>
                                    <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSaveQuestion()} placeholder="Enter a name..." className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" autoFocus />
                                    <div className="flex justify-end gap-2">
                                        <button onClick={() => setShowSaveModal(false)} className="text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg">Cancel</button>
                                        <button onClick={handleSaveQuestion} disabled={!saveName.trim()} className="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 px-3 py-1.5 rounded-lg transition-colors">Save</button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Saved Queries */}
                        <div className="relative">
                            <button onClick={() => { setShowSavedDrawer(!showSavedDrawer); setShowHistory(false); setShowSaveModal(false); }} className={`flex items-center text-[11px] font-bold px-2 py-1 rounded-lg transition-all border ${showSavedDrawer ? 'text-indigo-700 bg-indigo-50 border-indigo-200' : 'text-slate-500 bg-slate-100 hover:text-indigo-700 hover:bg-indigo-50 border-slate-200'}`}>
                                <FolderOpen className="w-3 h-3 mr-1" /> Saved
                                {savedQuestions.length > 0 && (<span className="ml-1 bg-indigo-100 text-indigo-700 text-[9px] font-bold px-1 py-0.5 rounded-full">{savedQuestions.length}</span>)}
                            </button>
                            {showSavedDrawer && (
                                <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden">
                                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
                                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Saved Questions</span>
                                    </div>
                                    {savedQuestions.length === 0 ? (
                                        <div className="px-4 py-6 text-center text-sm text-slate-400">No saved questions yet</div>
                                    ) : (
                                        <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                                            {savedQuestions.map(sq => (
                                                <div key={sq.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-indigo-50 transition-colors group">
                                                    <button onClick={() => { handleRun(sq.config); setShowSavedDrawer(false); }} className="flex-1 text-left truncate">
                                                        <span className="text-sm text-slate-700 font-medium">{sq.name}</span>
                                                        <span className="block text-[10px] text-slate-400">{new Date(sq.createdAt).toLocaleDateString()}</span>
                                                    </button>
                                                    <button onClick={(e) => { e.stopPropagation(); deleteQuestion(sq.id); }} className="p-1 rounded text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all" title="Delete">
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* History */}
                        <div className="relative">
                            <button onClick={() => { setShowHistory(!showHistory); setShowSavedDrawer(false); setShowSaveModal(false); }} className={`flex items-center text-[11px] font-bold px-2 py-1 rounded-lg transition-all border ${showHistory ? 'text-indigo-700 bg-indigo-50 border-indigo-200' : 'text-slate-500 bg-slate-100 hover:text-indigo-700 hover:bg-indigo-50 border-slate-200'}`}>
                                <Clock className="w-3 h-3 mr-1" /> History
                            </button>
                            {showHistory && queryHistory.length > 0 && (
                                <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-30 overflow-hidden">
                                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50">
                                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Recent Queries</span>
                                        <button onClick={() => { clearHistory(); setShowHistory(false); }} className="text-xs text-red-400 hover:text-red-600 flex items-center gap-1"><Trash2 className="w-3 h-3" /> Clear</button>
                                    </div>
                                    <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                                        {queryHistory.map((entry, i) => (
                                            <button key={i} onClick={() => { handleRun(entry.config); setShowHistory(false); }} className="w-full text-left px-4 py-2.5 hover:bg-indigo-50 transition-colors flex justify-between items-center">
                                                <span className="text-sm text-slate-700 font-medium truncate">{entry.label}</span>
                                                <span className="text-[10px] text-slate-400 shrink-0 ml-2">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {onPin && (
                            <button onClick={() => onPin(result.yLabel, { ...result, vis: chartType })} className="flex items-center text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg shadow-sm transition-all active:scale-95">
                                <Pin className="w-3 h-3 mr-1.5" /> Pin to Dashboard
                            </button>
                        )}
                        <button
                            onClick={() => { if (lastRunConfig) handleRun(lastRunConfig); }}
                            className="flex items-center text-[11px] font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 px-2.5 py-1.5 rounded-lg transition-all active:scale-95"
                            title="Refresh — re-run current query"
                        >
                            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
                        </button>
                        <button
                            onClick={() => { setResult(null); setError(null); setLastRunConfig(null); }}
                            className="flex items-center text-[11px] font-bold text-red-500 hover:text-red-600 bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 px-2.5 py-1.5 rounded-lg transition-all active:scale-95"
                            title="Reset — clear all results and start fresh"
                        >
                            <RotateCcw className="w-3 h-3 mr-1" /> Reset
                        </button>
                    </div>
                )}
            </div>

            {/* â”€â”€â”€ CONTENT AREA â€” Tabbed â”€â”€â”€ */}
            <div className="flex-1 flex flex-col overflow-auto p-4">

                {error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg mb-4 flex items-start">
                        <AlertTriangle className="w-5 h-5 mr-3 mt-0.5 shrink-0" />
                        <div>
                            <h4 className="font-bold">Analysis Failed</h4>
                            <p className="text-sm mt-1">{error}</p>
                        </div>
                    </div>
                )}

                {isLoading && (
                    <div className="space-y-6 max-w-7xl mx-auto animate-pulse">
                        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
                            <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
                            <span className="text-sm font-medium text-slate-600">Running analysis...</span>
                        </div>
                        <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-[500px] flex items-center justify-center">
                            <div className="space-y-4 w-3/4">
                                <div className="h-4 bg-slate-200 rounded w-1/3 mx-auto" />
                                <div className="flex items-end gap-2 justify-center h-48">
                                    {[40, 70, 55, 85, 65, 90, 45, 75].map((h, i) => (
                                        <div key={i} className="bg-slate-200 rounded-t w-10" style={{ height: `${h}%` }} />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {!result && !error && !isLoading && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400">
                        <Play className="w-12 h-12 mb-4 opacity-20" />
                        <p className="text-lg font-medium">Configure your question above to see results</p>
                        <p className="text-sm mt-1 text-slate-300">Press <kbd className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-xs font-mono border border-slate-200">Ctrl+Enter</kbd> to run</p>

                        {queryHistory.length > 0 && (
                            <div className="mt-8 w-full max-w-md">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1">
                                    <Clock className="w-3.5 h-3.5" /> Recent Queries
                                </h4>
                                <div className="space-y-1">
                                    {queryHistory.slice(0, 5).map((entry, i) => (
                                        <button key={i} onClick={() => handleRun(entry.config)} className="w-full text-left px-3 py-2 bg-white hover:bg-indigo-50 border border-slate-200 rounded-lg text-sm text-slate-700 font-medium transition-colors flex justify-between items-center">
                                            <span className="truncate">{entry.label}</span>
                                            <span className="text-[10px] text-slate-400 shrink-0 ml-2">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {result && !error && !isLoading && (
                    <>
                        {/* â”€â”€â”€ VISUAL TAB â”€â”€â”€ */}
                        {contentTab === 'visual' && (
                            <div className="relative bg-white flex-1 min-h-[350px] rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                                {/* Growth toggle */}
                                {tableData.columns.length > 0 && (
                                    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex bg-slate-100 rounded-lg p-0.5 border border-slate-200 shadow-sm">
                                        <button onClick={() => setShowGrowthChart(false)} className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-md transition-all ${!showGrowthChart ? 'bg-white text-indigo-700 shadow-sm border border-indigo-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                                            <BarChart3 className="w-3.5 h-3.5" /> Original
                                        </button>
                                        <button onClick={() => setShowGrowthChart(true)} className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-md transition-all ${showGrowthChart ? 'bg-white text-emerald-700 shadow-sm border border-emerald-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                                            <TrendingUp className="w-3.5 h-3.5" /> Calculated
                                        </button>
                                    </div>
                                )}

                                {(() => {
                                    const firstCol = tableData.columns[0];
                                    if (firstCol && showGrowthChart) {
                                        return (
                                            <ChartVisualization
                                                key={`growth-${firstCol.key}`}
                                                data={tableData.data}
                                                xKey={result.xKey}
                                                yKey={firstCol.key}
                                                yLabel={firstCol.label}
                                                chartType={firstCol.calculation === 'percent_of_total' ? 'pie' : chartType}
                                                onChartTypeChange={setChartType}
                                                formatting={{ ...formatting, tableCalculations: [], numberFormat: (firstCol.format || formatting?.numberFormat) as FormattingConfig['numberFormat'], showDataLabels: true }}
                                                onToggleFormat={onUpdateFormatting ? () => setIsFormatPanelOpen(!isFormatPanelOpen) : undefined}
                                                isFormatOpen={isFormatPanelOpen}
                                                onToggleAnalytics={onUpdateFormatting ? () => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen) : undefined}
                                                isAnalyticsOpen={isAnalyticsPanelOpen}
                                                onToggleLabels={undefined}
                                                onDrillDown={handleDrillDown}
                                                onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                                isAIInsightOpen={isAIInsightOpen}
                                                chartContainerRef={chartContainerRef}
                                            />
                                        );
                                    }
                                    return (
                                        <ChartVisualization
                                            data={result.data}
                                            xKey={result.xKey}
                                            yKey={result.yKey}
                                            yLabel={result.yLabel}
                                            chartType={chartType}
                                            onChartTypeChange={setChartType}
                                            formatting={formatting}
                                            onToggleFormat={onUpdateFormatting ? () => setIsFormatPanelOpen(!isFormatPanelOpen) : undefined}
                                            isFormatOpen={isFormatPanelOpen}
                                            onToggleAnalytics={onUpdateFormatting ? () => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen) : undefined}
                                            isAnalyticsOpen={isAnalyticsPanelOpen}
                                            onToggleLabels={onUpdateFormatting && formatting ? () => onUpdateFormatting({ ...formatting, showDataLabels: !formatting.showDataLabels }) : undefined}
                                            onDrillDown={handleDrillDown}
                                            onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                            isAIInsightOpen={isAIInsightOpen}
                                            chartContainerRef={chartContainerRef}
                                        />
                                    );
                                })()}

                                {/* AI Insight Panel */}
                                <AIInsightPanel isOpen={isAIInsightOpen} onClose={() => setIsAIInsightOpen(false)} chartContainerRef={chartContainerRef} chartTitle={result?.yLabel} />

                                {/* FLOATING FORMAT PANEL */}
                                {isFormatPanelOpen && formatting && onUpdateFormatting && (
                                    <div className="absolute top-4 right-4 w-72 bg-white shadow-2xl border border-slate-200 rounded-xl p-5 z-20 animate-in fade-in slide-in-from-right-4 ring-1 ring-black/5">
                                        <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-100">
                                            <h3 className="font-bold text-slate-800 flex items-center gap-2 text-sm"><Palette className="w-4 h-4 text-indigo-600" /> Chart Appearance</h3>
                                            <button onClick={() => setIsFormatPanelOpen(false)} className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-1 rounded-full transition-colors"><X className="w-4 h-4" /></button>
                                        </div>
                                        <div className="space-y-5">
                                            <div>
                                                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 block">Color Palette</label>
                                                <div className="grid grid-cols-5 gap-2">
                                                    {['vibrant', 'electric', 'neon', 'sunset', 'ocean'].map(mode => (
                                                        <button key={mode} onClick={() => onUpdateFormatting({ ...formatting, colorMode: mode as any })} className={`h-8 rounded-lg border-2 transition-all ${formatting.colorMode === mode ? 'ring-2 ring-indigo-500 ring-offset-1 border-transparent scale-110 shadow-md' : 'border-transparent hover:scale-105 hover:shadow-sm'}`} style={{ background: mode === 'vibrant' ? '#3b82f6' : mode === 'electric' ? '#6366f1' : mode === 'neon' ? '#22c55e' : mode === 'sunset' ? '#f97316' : '#0ea5e9' }} title={mode} />
                                                    ))}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 block">Number Format</label>
                                                <select value={formatting.numberFormat} onChange={e => onUpdateFormatting({ ...formatting, numberFormat: e.target.value as any })} className="w-full text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg py-2.5 px-3 shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-medium appearance-none cursor-pointer hover:bg-white hover:border-indigo-300 transition-all">
                                                    <option value="raw">Raw Number (1200)</option>
                                                    <option value="currency_usd">Currency ($ USD)</option>
                                                    <option value="currency_eur">Currency (â‚¬ EUR)</option>
                                                    <option value="percent">Percentage (%)</option>
                                                    <option value="compact">Compact (1k, 1M)</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 block">Decimal Places</label>
                                                <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
                                                    {[{ label: 'Auto', val: undefined }, { label: '0', val: 0 }, { label: '1', val: 1 }, { label: '2', val: 2 }].map(opt => (
                                                        <button key={opt.label} onClick={() => onUpdateFormatting({ ...formatting, decimals: opt.val })} className={`flex-1 text-xs py-2 rounded-md font-bold transition-all ${formatting.decimals === opt.val ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{opt.label}</button>
                                                    ))}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 block">Font Size</label>
                                                <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
                                                    {['sm', 'md', 'lg'].map(size => (
                                                        <button key={size} onClick={() => onUpdateFormatting({ ...formatting, fontSize: size as any })} className={`flex-1 text-xs py-2 rounded-md font-bold transition-all ${formatting.fontSize === size ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{size.toUpperCase()}</button>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="flex flex-col gap-3 pt-3 border-t border-slate-100">
                                                <label className="flex items-center gap-3 cursor-pointer group">
                                                    <div className="relative flex items-center">
                                                        <input type="checkbox" checked={formatting.headerBold} onChange={e => onUpdateFormatting({ ...formatting, headerBold: e.target.checked })} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 shadow-sm checked:border-indigo-500 checked:bg-indigo-500 hover:border-indigo-400 transition-all" />
                                                        <CheckCircle2 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                                                    </div>
                                                    <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">Bold Chart Title</span>
                                                </label>
                                                <label className="flex items-center gap-3 cursor-pointer group">
                                                    <div className="relative flex items-center">
                                                        <input type="checkbox" checked={formatting.axisBold ?? false} onChange={e => onUpdateFormatting({ ...formatting, axisBold: e.target.checked })} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 shadow-sm checked:border-indigo-500 checked:bg-indigo-500 hover:border-indigo-400 transition-all" />
                                                        <CheckCircle2 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                                                    </div>
                                                    <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">Bold Axis Labels</span>
                                                </label>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Axis Color</span>
                                                    <input type="color" value={formatting.axisColor || '#475569'} onChange={e => onUpdateFormatting({ ...formatting, axisColor: e.target.value })} className="w-6 h-6 rounded border border-slate-200 cursor-pointer p-0" />
                                                    {formatting.axisColor && (<button onClick={() => onUpdateFormatting({ ...formatting, axisColor: undefined })} className="text-[10px] text-slate-400 hover:text-indigo-500 transition-colors">Reset</button>)}
                                                </div>
                                                <label className="flex items-center gap-3 cursor-pointer group">
                                                    <div className="relative flex items-center">
                                                        <input type="checkbox" checked={formatting.showLabels} onChange={e => onUpdateFormatting({ ...formatting, showLabels: e.target.checked })} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 shadow-sm checked:border-indigo-500 checked:bg-indigo-500 hover:border-indigo-400 transition-all" />
                                                        <CheckCircle2 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                                                    </div>
                                                    <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">Show Legend</span>
                                                </label>
                                                <label className="flex items-center gap-3 cursor-pointer group">
                                                    <div className="relative flex items-center">
                                                        <input type="checkbox" checked={formatting.showDataLabels} onChange={e => onUpdateFormatting({ ...formatting, showDataLabels: e.target.checked })} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-300 shadow-sm checked:border-indigo-500 checked:bg-indigo-500 hover:border-indigo-400 transition-all" />
                                                        <CheckCircle2 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity" strokeWidth={3} />
                                                    </div>
                                                    <span className="text-sm font-medium text-slate-700 group-hover:text-indigo-600 transition-colors">Show Data Labels</span>
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* FLOATING ANALYTICS PANEL */}
                                {isAnalyticsPanelOpen && formatting && onUpdateFormatting && (
                                    <div className="absolute top-4 left-4 w-72 bg-white shadow-2xl border border-emerald-200 rounded-xl p-5 z-20 animate-in fade-in slide-in-from-left-4 ring-1 ring-black/5">
                                        <div className="flex justify-between items-center mb-4 pb-3 border-b border-emerald-100">
                                            <h3 className="font-bold text-slate-800 flex items-center gap-2"><Activity className="w-5 h-5 text-emerald-600" /> Analytics</h3>
                                            <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5" /></button>
                                        </div>
                                        <div className="space-y-4">
                                            <div className="pb-4 border-b border-emerald-100">
                                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Data Comparison</label>
                                                <label className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${result?.config?.comparison === 'previous_period' ? 'bg-emerald-100 border border-emerald-500 ring-1 ring-emerald-500 shadow-sm' : 'hover:bg-slate-50 border border-transparent hover:border-slate-200'}`}>
                                                    <div className="relative flex items-center shrink-0">
                                                        <input type="checkbox" checked={result?.config?.comparison === 'previous_period'} onChange={(e) => { if (result) { const newConfig = { ...result.config, comparison: e.target.checked ? 'previous_period' : 'none' }; handleRun(newConfig); } }} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-400 checked:border-emerald-700 checked:bg-emerald-600 transition-all" />
                                                        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-0 peer-checked:opacity-100 transition-opacity"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg></div>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className={`text-sm ${result?.config?.comparison === 'previous_period' ? 'font-bold text-emerald-900' : 'text-slate-700 font-medium'}`}>Compare Previous Period</span>
                                                        <span className="text-[10px] text-slate-500 leading-tight">vs Same Period (Last N)</span>
                                                    </div>
                                                </label>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Table Calculation</label>
                                                <div className="space-y-1 max-h-[300px] overflow-y-auto pr-2">
                                                    {(['percent_of_total', 'rank_desc', 'rank_asc', 'running_total', 'moving_avg', 'pct_diff_from_prev', 'diff_from_prev', 'percentile'] as TableCalculation[]).map(calc => {
                                                        const isSelected = (formatting.tableCalculations || []).includes(calc);
                                                        return (
                                                            <label key={calc} className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? 'bg-emerald-100 border border-emerald-500 ring-1 ring-emerald-500 shadow-sm' : 'hover:bg-slate-50 border border-transparent hover:border-slate-200'}`}>
                                                                <div className="relative flex items-center shrink-0">
                                                                    <input type="checkbox" checked={isSelected} onChange={() => { const current = formatting.tableCalculations || []; const updated = isSelected ? current.filter(c => c !== calc) : [...current, calc]; onUpdateFormatting({ ...formatting, tableCalculations: updated }); }} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-400 checked:border-emerald-700 checked:bg-emerald-600 transition-all" />
                                                                    <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 peer-checked:opacity-100 transition-opacity"><svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg></div>
                                                                </div>
                                                                <span className={`text-sm ${isSelected ? 'font-bold text-emerald-900' : 'text-slate-700 font-medium'}`}>{getCalculationDisplayName(calc)}</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                                {(formatting.tableCalculations || []).length > 0 && (
                                                    <button onClick={() => onUpdateFormatting({ ...formatting, tableCalculations: [] })} className="mt-1 text-[11px] text-slate-400 hover:text-red-500 transition-colors cursor-pointer">Clear all calculations</button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* â”€â”€â”€ SQL TAB â”€â”€â”€ */}
                        {contentTab === 'sql' && (
                            <div className="space-y-4">
                                <div className="bg-gray-100 dark:bg-slate-900 rounded-xl p-4 shadow-inner overflow-hidden relative">
                                    <div className="absolute top-2 right-2 text-[10px] text-gray-500 dark:text-slate-500 font-mono uppercase flex items-center bg-gray-200 dark:bg-slate-800 px-2 py-1 rounded"><Code className="w-3 h-3 mr-1" /> Generated SQL</div>
                                    <pre className="text-sm text-green-400 font-mono overflow-auto whitespace-pre-wrap p-2 min-h-[200px]">{result.sql}</pre>
                                </div>
                                <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Query Config</h4>
                                    <pre className="text-xs text-slate-600 font-mono whitespace-pre-wrap">{JSON.stringify(result.config, null, 2)}</pre>
                                </div>
                            </div>
                        )}

                        {/* â”€â”€â”€ DATA TAB â”€â”€â”€ */}
                        {contentTab === 'data' && (
                            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                                <div className="overflow-auto max-h-[calc(100vh-200px)]">
                                    <table className="min-w-full divide-y divide-slate-200">
                                        <thead className="bg-slate-50 sticky top-0 z-10">
                                            <tr>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{result.xKey.replace(/_/g, ' ')}</th>
                                                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">{result.yKey.replace(/_/g, ' ')}</th>
                                                {tableData.columns.map(col => (
                                                    <th key={col.key} className="px-6 py-3 text-right text-xs font-bold text-emerald-600 uppercase tracking-wider bg-emerald-50/50 border-l border-emerald-100">{col.label}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-slate-200">
                                            {tableData.data.map((row, i) => (
                                                <tr key={i} className="hover:bg-indigo-50/30 transition-colors">
                                                    <td className="px-6 py-3 text-sm font-medium text-slate-900 whitespace-nowrap">{String(row[result.xKey])}</td>
                                                    <td className="px-6 py-3 text-sm text-slate-600 text-right whitespace-nowrap font-mono">{Number(row[result.yKey]).toLocaleString(undefined, { maximumFractionDigits: formatting?.decimals ?? 2 })}</td>
                                                    {tableData.columns.map(col => {
                                                        const val = Number(row[col.key]) || 0;
                                                        const isNeg = val < 0;
                                                        const isZero = val === 0;
                                                        const colorClass = isZero ? 'text-slate-500 bg-slate-50/30' : isNeg ? 'text-red-600 bg-red-50/40' : 'text-emerald-600 bg-emerald-50/40';
                                                        return (
                                                            <td key={col.key} className={`px-6 py-3 text-sm font-bold text-right whitespace-nowrap font-mono border-l border-emerald-100 ${colorClass}`}>
                                                                {col.format === 'percent' ? val.toFixed(formatting?.decimals ?? 2) + '%' : val.toLocaleString(undefined, { maximumFractionDigits: formatting?.decimals ?? 2 })}
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
                    </>
                )}
            </div>
        </div>
    );
};

