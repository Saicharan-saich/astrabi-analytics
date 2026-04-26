import React, { useState, useRef } from 'react';
import { Sparkles, Play, RefreshCw, Search, AlertTriangle, BarChart2, Table, Code, Pin, Eye, EyeOff, Palette, Activity, X, RotateCcw, Copy, Check, Database, Loader2 } from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { ChatMessage } from '../services/aiSQLService';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { MODEL } from '../services/ai-sql/intentPlanner';
import { ChartVisualization } from './ChartVisualization';
import { Tooltip } from './Tooltip';
import { AIInsightPanel } from './AIInsightPanel';
import { getCalculationDisplayName, type TableCalculation } from '../utils/tableCalculations';

interface AISQLViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
    initialQuery?: string | null;
}

export const AISQLView: React.FC<AISQLViewProps> = ({ dataset, onPin, initialQuery }) => {
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [noDataMsg, setNoDataMsg] = useState<string | null>(null);
    const [activeResultTab, setActiveResultTab] = useState<'chart' | 'table' | 'sql'>('chart');
    const [isInputCollapsed, setIsInputCollapsed] = useState(false);
    const [isExplanationCollapsed, setIsExplanationCollapsed] = useState(false);
    const [conversationHistory, setConversationHistory] = useState<ChatMessage[]>([]);
    const [aiExplanation, setAiExplanation] = useState<string | null>(null);
    const [columnsUsed, setColumnsUsed] = useState<string[]>([]);
    const [generatedSQL, setGeneratedSQL] = useState<string | null>(null);
    const [copiedSQL, setCopiedSQL] = useState(false);
    const [formatting, setFormatting] = useState<FormattingConfig>({
        colorMode: 'vibrant',
        numberFormat: 'auto',
        fontSize: 'md',
        headerSize: 'md',
        headerBold: true,
        showLabels: true,
        showDataLabels: false,
        tableCalculations: [],
        showXAxis: true,
        showYAxis: true
    });
    const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
    const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
    const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const [pipelineResult, setPipelineResult] = useState<AISQLPipelineResult | null>(null);
    const [showGrowthPct, setShowGrowthPct] = useState(false);
    const [timeGrain, setTimeGrain] = useState<'day' | 'week' | 'month' | 'quarter' | 'year'>('month');
    const [showConfidenceBreakdown, setShowConfidenceBreakdown] = useState(false);

    const updateFormatting = (f: FormattingConfig) => setFormatting(f);

    // Auto-fill and auto-submit when initialQuery is set
    const initialQueryProcessed = React.useRef<string | null>(null);
    const pendingAutoSubmit = React.useRef(false);
    React.useEffect(() => {
        if (initialQuery && initialQuery !== initialQueryProcessed.current && dataset && !isLoading) {
            initialQueryProcessed.current = initialQuery;
            setQuery(initialQuery);
            pendingAutoSubmit.current = true;
        }
    }, [initialQuery, dataset]);

    // Re-run pipeline when time grain changes (only if we already have results)
    // Use a ref to avoid stale closure — handleSubmit reads timeGrain from state,
    // but by the time useEffect fires the state is already updated.
    const grainInitialized = React.useRef(true);
    React.useEffect(() => {
        if (grainInitialized.current) {
            grainInitialized.current = false;
            return;
        }
        // Re-run only if we have an active query with results
        if (query.trim() && dataset && analysisResult) {
            // Use queueMicrotask so React state is settled before handleSubmit reads timeGrain
            queueMicrotask(() => {
                handleSubmit();
            });
        }
    }, [timeGrain]);

    const examples = [
        "Total revenue by category",
        "Top 10 products by profit",
        "Monthly sales trend",
        "Average order value by region",
        "Count of orders this year",
        "Revenue breakdown by segment"
    ];

    const handleSubmit = async () => {
        if (!query.trim() || !dataset || isLoading) return;
        setIsLoading(true);
        setError(null);
        setNoDataMsg(null);
        setIsInputCollapsed(true);

        try {
            // Run the full enterprise AI SQL pipeline
            const result = await runAISQLPipeline(query, dataset, undefined, undefined, timeGrain);

            // ── Graceful empty-result handling ─────────────────────────
            // When the pipeline finds 0 rows it now returns a result with
            // rawData:[] and an explanation instead of throwing. Show the
            // explanation as a friendly banner, not as a chart.
            if (result.rawData.length === 0 && result.explanation) {
                setPipelineResult(result);
                setGeneratedSQL(result.sql);
                setAiExplanation(result.explanation);
                setColumnsUsed(result.columnsUsed);
                setNoDataMsg(result.explanation);
                setIsLoading(false);
                return;
            }

            // Store the full pipeline result for the Trust UI
            setPipelineResult(result);

            // Set legacy state variables for existing UI components
            setGeneratedSQL(result.sql);
            setAiExplanation(result.explanation);
            setColumnsUsed(result.columnsUsed);

            // Build conversation history
            const userMsg: ChatMessage = {
                id: 'msg_' + Date.now(),
                role: 'user',
                content: query,
                timestamp: Date.now()
            };
            const aiMsg: ChatMessage = {
                id: 'msg_' + (Date.now() + 1),
                role: 'assistant',
                content: result.explanation,
                sql: result.sql,
                explanation: result.explanation,
                columnsUsed: result.columnsUsed,
                timestamp: Date.now()
            };
            setConversationHistory(prev => [...prev, userMsg, aiMsg]);

            // Map the chart recommendation to an AnalysisResult
            const chartTypeMap: Record<string, string> = {
                kpiCard: 'kpiCard',
                line: 'line',
                bar: 'bar',
                horizontalBar: 'horizontalBar',
                groupedBar: 'groupedBar',
                stackedBar: 'stackedBar',
                area: 'area',
                dualAxisCombo: 'comboChart',
                multiLine: 'line',
                donut: 'donut',
                heatmap: 'heatmap',
                table: 'table',
            };

            // ── Auto-apply axis format from chart recommender ──────────
            // leftAxisFormat tells us whether this metric is a percentage,
            // currency, or plain number — override numberFormat so labels
            // immediately show '%' for discounts, '$' for revenue, etc.
            const axisFormatMap: Record<string, FormattingConfig['numberFormat']> = {
                percent: 'percent',
                currency_usd: 'currency_usd',
                compact: 'compact',
            };
            const detectedFormat = result.chart.leftAxisFormat
                ? (axisFormatMap[result.chart.leftAxisFormat] ?? 'auto')
                : 'auto';
            setFormatting(prev => ({
                ...prev,
                numberFormat: detectedFormat,
                // Auto-enable labels only for small datasets (≤8 points)
                showDataLabels: result.chartData.length <= 8,
            }));

            // Set the analysis result for ChartVisualization
            setAnalysisResult({
                data: result.chartData,
                xKey: result.chart.xKey,
                yKey: result.chart.yKey,
                yLabel: query,
                insight: result.explanation,
                sql: result.sql,
                config: {
                    metric: result.plan.metrics[0]?.field || result.chart.yKey,
                    dimension: result.plan.dimensions[0]?.field || result.chart.xKey,
                    aggregation: AggregationType.SUM,
                    timeGrain: TimeGrain.RAW,
                    analysisType: AnalysisType.STANDARD,
                    questionId: 'ai_sql_' + Date.now(),
                    questionLabel: query,
                    secondaryMetrics: result.chart.secondaryYKeys,
                    axisMode: result.chart.useDualAxis ? 'dual' : 'auto',
                },
                vis: (chartTypeMap[result.chart.chartType] || 'bar') as any,
                kpi: result.chart.chartType === 'kpiCard' && result.chartData.length > 0
                    ? result.chartData[0][result.chart.yKey]
                    : undefined,
                growth: result.chart.growth
                    ? { diff: result.chart.growth.diff, pct: result.chart.growth.pct }
                    : undefined,
                secondaryYKeys: result.chart.secondaryYKeys,
            });

        } catch (err: any) {
            console.error('[AI SQL Pipeline] Error:', err);
            setError(err.message || 'An unexpected error occurred.');
        } finally {
            setIsLoading(false);
        }
    };

    // Auto-submit when pending (triggered by initialQuery)
    React.useEffect(() => {
        if (pendingAutoSubmit.current && query.trim() && dataset && !isLoading) {
            pendingAutoSubmit.current = false;
            handleSubmit();
        }
    }, [query]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) handleSubmit();
    };

    const handleCopySQL = () => {
        if (generatedSQL) {
            navigator.clipboard.writeText(generatedSQL);
            setCopiedSQL(true);
            setTimeout(() => setCopiedSQL(false), 2000);
        }
    };

    const handleReset = () => {
        setQuery('');
        setAnalysisResult(null);
        setError(null);
        setNoDataMsg(null);
        setAiExplanation(null);
        setColumnsUsed([]);
        setGeneratedSQL(null);
        setConversationHistory([]);
        setIsFormatPanelOpen(false);
        setIsAnalyticsPanelOpen(false);
        setIsAIInsightOpen(false);
        setIsInputCollapsed(false);
        setIsExplanationCollapsed(false);
        setPipelineResult(null);
    };

    // Regenerate: force bypass cache
    const handleRegenerate = async () => {
        if (!query.trim() || !dataset || isLoading) return;
        setIsLoading(true);
        setError(null);
        setNoDataMsg(null);
        try {
            const result = await runAISQLPipeline(query, dataset, undefined, undefined, timeGrain, true);
            if (result.rawData.length === 0 && result.explanation) {
                setPipelineResult(result);
                setGeneratedSQL(result.sql);
                setAiExplanation(result.explanation);
                setNoDataMsg(result.explanation);
                setIsLoading(false);
                return;
            }
            setPipelineResult(result);
            setGeneratedSQL(result.sql);
            setAiExplanation(result.explanation);
            setColumnsUsed(result.columnsUsed);

            const chartTypeMap: Record<string, string> = {
                kpiCard: 'kpiCard', line: 'line', bar: 'bar', horizontalBar: 'horizontalBar',
                groupedBar: 'groupedBar', stackedBar: 'stackedBar', area: 'area',
                dualAxisCombo: 'comboChart', multiLine: 'line', donut: 'donut', heatmap: 'heatmap', table: 'table',
            };
            const axisFormatMap: Record<string, FormattingConfig['numberFormat']> = {
                percent: 'percent', currency_usd: 'currency_usd', compact: 'compact',
            };
            const detectedFormat = result.chart.leftAxisFormat
                ? (axisFormatMap[result.chart.leftAxisFormat] ?? 'auto') : 'auto';
            setFormatting(prev => ({ ...prev, numberFormat: detectedFormat }));

            setAnalysisResult({
                data: result.chartData,
                xKey: result.chart.xKey,
                yKey: result.chart.yKey,
                yLabel: query,
                insight: result.explanation,
                sql: result.sql,
                config: {
                    metric: result.plan.metrics[0]?.field || result.chart.yKey,
                    dimension: result.plan.dimensions[0]?.field || result.chart.xKey,
                    aggregation: AggregationType.SUM,
                    timeGrain: TimeGrain.RAW,
                    analysisType: AnalysisType.STANDARD,
                    questionId: 'ai_sql_regen_' + Date.now(),
                    questionLabel: query,
                    secondaryMetrics: result.chart.secondaryYKeys,
                    axisMode: result.chart.useDualAxis ? 'dual' : 'auto',
                },
                vis: (chartTypeMap[result.chart.chartType] || 'bar') as any,
                kpi: result.chart.chartType === 'kpiCard' && result.chartData.length > 0
                    ? result.chartData[0][result.chart.yKey] : undefined,
                growth: result.chart.growth
                    ? { diff: result.chart.growth.diff, pct: result.chart.growth.pct } : undefined,
                secondaryYKeys: result.chart.secondaryYKeys,
            });
        } catch (err: any) {
            setError(err.message || 'Regeneration failed.');
        } finally {
            setIsLoading(false);
        }
    };

    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
                <Sparkles className="w-16 h-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Please load a dataset to use AI SQL.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-gray-50 dark:bg-slate-900 p-6 overflow-hidden">
            <div className="max-w-5xl mx-auto w-full flex flex-col h-full gap-5">

                {/* Header */}
                <div className="flex flex-col gap-1 shrink-0">
                    <Tooltip text="AI SQL uses advanced AI to generate and execute SQL queries on your dataset. Ask questions in plain English and get instant results." position="right">
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                            <img src="/ai-sql-logo.png" alt="AI SQL" className="w-7 h-7 rounded-lg object-cover" />
                            AI SQL
                            <span className="text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/20">
                                Intelligent Analytics
                            </span>
                            <span className="text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                {MODEL.includes('gpt') ? `⚡ ${MODEL.split('/').pop()?.toUpperCase()}` : MODEL.includes('gemini') ? `✨ ${MODEL.split('/').pop()}` : MODEL.split('/').pop()}
                            </span>
                        </h2>
                    </Tooltip>
                    <p className="text-gray-500 dark:text-slate-400 text-sm flex items-center justify-between">
                        <span>Ask any question — AI generates SQL, executes it on your data, and visualizes the results.</span>
                    </p>
                </div>

                {/* Collapsible Input */}
                <div className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isInputCollapsed ? 'max-h-0' : 'max-h-[400px]'}`}>
                    <div className="relative group">
                        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/30 to-orange-500/30 rounded-2xl blur-lg opacity-0 group-hover:opacity-40 transition-opacity pointer-events-none" />
                        <div className={`relative bg-white dark:bg-slate-800 border-2 rounded-2xl shadow-lg dark:shadow-2xl transition-all duration-300 ${query.trim() ? 'border-amber-400/50 dark:border-amber-500/40' : 'border-gray-200 dark:border-white/10 hover:border-amber-400/30 dark:hover:border-amber-500/30'}`}>
                            <textarea
                                className="w-full bg-transparent border-none outline-none text-gray-900 dark:text-white px-5 pt-4 pb-2 placeholder:text-gray-400 dark:placeholder:text-slate-500 font-medium resize-none min-h-[56px] max-h-[160px]"
                                placeholder="Ask a question about your data... e.g. &quot;Show top 10 products by total revenue&quot;"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSubmit();
                                    }
                                }}
                                rows={2}
                                disabled={isLoading}
                            />
                            <div className="flex items-center justify-between px-4 pb-3">
                                <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500">
                                    <img src="/ai-sql-logo.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
                                    <span>AI generates SQL &middot; Press <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-[10px] font-mono border border-gray-200 dark:border-white/10">Enter</kbd> to send</span>
                                </div>
                                <button
                                    onClick={handleSubmit}
                                    disabled={!query.trim() || isLoading}
                                    className="bg-amber-600 hover:bg-amber-500 text-white px-5 py-2 rounded-xl font-bold flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-md hover:shadow-lg active:scale-95"
                                >
                                    {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                                    {isLoading ? 'Generating...' : 'Send'}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Empty State / Examples */}
                    {!analysisResult && !error && !isLoading && (
                        <div className="flex-1 flex flex-col items-center justify-center opacity-60 mt-6">
                            <p className="text-gray-500 dark:text-slate-400 mb-6 uppercase tracking-wider text-xs font-bold">Try asking:</p>
                            <div className="flex flex-wrap justify-center gap-3 max-w-2xl">
                                {examples.map((ex, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setQuery(ex)}
                                        className="px-4 py-2 rounded-full border border-gray-200 dark:border-white/10 hover:border-amber-500/50 hover:bg-amber-500/10 text-gray-600 dark:text-slate-300 text-sm transition-all"
                                    >
                                        {ex}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Results Area */}
                {/* ── No-data explanation banner ──────────────────────── */}
                {noDataMsg && !isLoading && (
                    <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-500/40 rounded-xl p-5 flex items-start gap-4">
                        <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
                            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1">
                            <div className="font-bold text-amber-800 dark:text-amber-300 mb-1 text-sm">No data found for this query</div>
                            <p className="text-sm text-amber-700 dark:text-amber-200/80 leading-relaxed">{noDataMsg}</p>
                            {generatedSQL && (
                                <pre className="mt-3 text-[11px] text-emerald-700 dark:text-emerald-300 font-mono bg-white/60 dark:bg-slate-900/60 rounded-lg p-3 border border-amber-200 dark:border-white/5 overflow-x-auto">{generatedSQL}</pre>
                            )}
                        </div>
                        <button onClick={handleReset} className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 shrink-0"><X className="w-4 h-4" /></button>
                    </div>
                )}

                {(analysisResult || error || isLoading) && (
                    <div className="flex-1 min-h-0 flex gap-0 overflow-hidden">

                        {/* Left: AI Explanation Panel */}
                        {(aiExplanation || error) && !isLoading && !isExplanationCollapsed && (
                            <div className="w-72 shrink-0 mr-4 flex flex-col gap-4 overflow-y-auto pr-2 custom-scrollbar h-full">
                                {aiExplanation && (
                                    <div className="bg-white/80 dark:bg-slate-800/50 rounded-xl p-4 border border-gray-100 dark:border-white/5 space-y-4">
                                        <div className="flex items-center gap-2">
                                            <Sparkles className="w-4 h-4 text-amber-400" />
                                            <h3 className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider">AI Explanation</h3>
                                        </div>
                                        <p className="text-sm text-gray-700 dark:text-slate-300 leading-relaxed">{aiExplanation}</p>

                                        {columnsUsed.length > 0 && (
                                            <div className="pt-3 border-t border-gray-100 dark:border-white/5">
                                                <div className="text-xs font-bold text-gray-400 dark:text-slate-500 mb-2 uppercase tracking-wider">Columns Used</div>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {columnsUsed.map(col => (
                                                        <span key={col} className="text-xs px-2 py-1 rounded-md bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 font-mono border border-amber-200 dark:border-amber-500/20">
                                                            {col}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {generatedSQL && (
                                            <div className="pt-3 border-t border-gray-100 dark:border-white/5">
                                                <div className="flex items-center justify-between mb-2">
                                                    <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">SQL Preview</span>
                                                    <button onClick={handleCopySQL} className="text-xs text-amber-500 hover:text-amber-400 flex items-center gap-1 transition-colors">
                                                        {copiedSQL ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                                                    </button>
                                                </div>
                                                <pre className="text-[11px] text-emerald-600 dark:text-emerald-300 font-mono whitespace-pre-wrap bg-gray-50 dark:bg-slate-900/60 rounded-md p-2 border border-gray-100 dark:border-white/5 max-h-40 overflow-auto">
                                                    {generatedSQL}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {error && (
                                    <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-4 flex items-start gap-3 text-red-700 dark:text-red-200 text-sm">
                                        <AlertTriangle className="w-5 h-5 shrink-0" />
                                        <div>
                                            <div className="font-bold mb-1">Query Failed</div>
                                            {error}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Right: Visualization + Table + SQL */}
                        <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-white/5 overflow-hidden shadow-lg dark:shadow-2xl">

                            {/* Loading Skeleton */}
                            {isLoading && !analysisResult && (
                                <div className="flex-1 flex flex-col items-center justify-center p-8">
                                    <div className="relative mb-6">
                                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center">
                                            <Sparkles className="w-8 h-8 text-amber-400 animate-pulse" />
                                        </div>
                                        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 animate-ping" />
                                    </div>
                                    <div className="flex items-center gap-3 text-gray-500 dark:text-slate-400 text-sm">
                                        <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                                        <span>AI is generating SQL for your question...</span>
                                    </div>
                                    <div className="mt-4 flex gap-2">
                                        <div className="w-2 h-2 rounded-full bg-amber-400/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                                        <div className="w-2 h-2 rounded-full bg-amber-400/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                                        <div className="w-2 h-2 rounded-full bg-amber-400/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </div>
                                </div>
                            )}

                            {/* Tab Bar + Actions */}
                            {analysisResult && (
                                <div className="flex items-center justify-between border-b border-gray-200 dark:border-white/5 px-4 py-2.5 shrink-0 bg-gray-50/80 dark:bg-slate-800/80">
                                    <div className="flex items-center gap-2">
                                        {/* Input Toggle */}
                                        <button
                                            onClick={() => setIsInputCollapsed(!isInputCollapsed)}
                                            className="flex items-center gap-1.5 text-[13px] font-bold text-gray-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-300 bg-gray-100 dark:bg-slate-700/50 hover:bg-amber-50 dark:hover:bg-amber-500/20 px-3 py-2 rounded-lg transition-all mr-1"
                                            title={isInputCollapsed ? 'Show Input' : 'Hide Input'}
                                        >
                                            {isInputCollapsed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                                            Input
                                        </button>

                                        {/* Explanation Toggle */}
                                        {(aiExplanation || error) && (
                                            <button
                                                onClick={() => setIsExplanationCollapsed(!isExplanationCollapsed)}
                                                className={`flex items-center gap-1.5 text-[13px] font-bold px-3 py-2 rounded-lg transition-all mr-1 ${isExplanationCollapsed ? 'text-gray-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-300 bg-gray-100 dark:bg-slate-700/50 hover:bg-amber-50 dark:hover:bg-amber-500/20' : 'text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/20 ring-1 ring-amber-400/30'}`}
                                                title={isExplanationCollapsed ? 'Show AI Explanation' : 'Hide AI Explanation'}
                                            >
                                                <Sparkles className="w-4 h-4" />
                                                AI Details
                                            </button>
                                        )}

                                        <div className="w-px h-5 bg-gray-200 dark:bg-white/10 mx-1" />

                                        {([
                                            { id: 'chart' as const, icon: BarChart2, label: 'Chart' },
                                            { id: 'table' as const, icon: Table, label: 'Table' },
                                            { id: 'sql' as const, icon: Code, label: 'SQL' },
                                        ]).map(tab => (
                                            <button
                                                key={tab.id}
                                                onClick={() => setActiveResultTab(tab.id)}
                                                className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all ${activeResultTab === tab.id
                                                    ? 'bg-amber-50 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300 ring-1 ring-amber-400/30'
                                                    : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'
                                                    }`}
                                            >
                                                <tab.icon className="w-4 h-4" />
                                                {tab.label}
                                            </button>
                                        ))}

                                        {/* Axis + Grain — compact inline */}
                                        {activeResultTab === 'chart' && (
                                            <div className="flex items-center gap-1 ml-1.5">
                                                <button
                                                    onClick={() => setFormatting(f => ({ ...f, showXAxis: !f.showXAxis }))}
                                                    className={`px-1.5 py-1 rounded text-[11px] font-bold transition-all ${formatting.showXAxis ? 'text-amber-600 dark:text-amber-300 bg-amber-500/10' : 'text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-white'}`}
                                                    title="Toggle X-Axis"
                                                >X</button>
                                                <button
                                                    onClick={() => setFormatting(f => ({ ...f, showYAxis: !f.showYAxis }))}
                                                    className={`px-1.5 py-1 rounded text-[11px] font-bold transition-all ${formatting.showYAxis ? 'text-amber-600 dark:text-amber-300 bg-amber-500/10' : 'text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-white'}`}
                                                    title="Toggle Y-Axis"
                                                >Y</button>
                                                <div className="w-px h-3.5 bg-gray-200 dark:bg-white/10 mx-0.5" />
                                                {([
                                                    { value: 'day' as const, label: 'D' },
                                                    { value: 'week' as const, label: 'W' },
                                                    { value: 'month' as const, label: 'M' },
                                                    { value: 'quarter' as const, label: 'Q' },
                                                    { value: 'year' as const, label: 'Y' },
                                                ]).map(g => (
                                                    <button
                                                        key={g.value}
                                                        onClick={() => {
                                                            if (g.value !== timeGrain) {
                                                                setTimeGrain(g.value);
                                                            }
                                                        }}
                                                        className={`w-6 h-6 rounded text-[11px] font-bold transition-all ${timeGrain === g.value ? 'bg-blue-500/15 text-blue-500 dark:text-blue-300 ring-1 ring-blue-400/40' : 'text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                                                        title={`${g.value.charAt(0).toUpperCase() + g.value.slice(1)} grain`}
                                                    >{g.label}</button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={() => onPin?.(query, { ...analysisResult, formatting })}
                                            className="flex items-center gap-1.5 text-[12px] font-bold text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 px-3 py-1.5 rounded-lg transition-all active:scale-95 border border-amber-200 dark:border-amber-500/20"
                                            title="Pin to Dashboard"
                                        >
                                            <Pin className="w-3.5 h-3.5" />
                                            Pin
                                        </button>
                                        <button
                                            onClick={handleRegenerate}
                                            className="flex items-center gap-1 text-[12px] font-bold text-cyan-600 dark:text-cyan-300 bg-cyan-50 dark:bg-cyan-500/10 hover:bg-cyan-100 dark:hover:bg-cyan-500/20 px-2.5 py-1.5 rounded-lg transition-all active:scale-95 border border-cyan-200 dark:border-cyan-500/20"
                                            title="Regenerate — call AI fresh"
                                        >
                                            <RefreshCw className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={handleSubmit}
                                            className="flex items-center gap-1 text-[12px] font-bold text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-white bg-gray-100 dark:bg-slate-700/50 hover:bg-gray-200 dark:hover:bg-slate-600 px-2.5 py-1.5 rounded-lg transition-all active:scale-95"
                                            title="Refresh — re-run current query"
                                        >
                                            <Play className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={handleReset}
                                            className="flex items-center gap-1 text-[12px] font-bold text-red-400 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 px-2.5 py-1.5 rounded-lg transition-all active:scale-95"
                                            title="Reset — clear all results and start fresh"
                                        >
                                            <RotateCcw className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Tab Content */}
                            <div className="flex-1 min-h-0 overflow-hidden">
                                {analysisResult ? (
                                    <>
                                        {/* Chart Tab */}
                                        {activeResultTab === 'chart' && analysisResult && (
                                            <div className="h-full p-4 overflow-hidden relative" ref={chartContainerRef}>
                                                {/* Enterprise AI SQL — Growth Badge + Confidence */}
                                                {pipelineResult && (
                                                    <div className="flex items-center justify-between mb-3 px-1">
                                                        <div className="flex items-center gap-3">
                                                            {/* Growth Badge */}
                                                            {pipelineResult.chart.growth && (
                                                                <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${pipelineResult.chart.growth.pct >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400'}`}>
                                                                    <span>{pipelineResult.chart.growth.pct >= 0 ? '▲' : '▼'}</span>
                                                                    <span>{pipelineResult.chart.growth.pct >= 0 ? '+' : ''}{pipelineResult.chart.growth.pct.toFixed(1)}%</span>
                                                                </div>
                                                            )}
                                                            {/* KPI Value */}
                                                            {analysisResult?.kpi !== undefined && (
                                                                <span className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-600 to-orange-500">
                                                                    {typeof analysisResult.kpi === 'number'
                                                                        ? analysisResult.kpi.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                                                        : analysisResult.kpi}
                                                                </span>
                                                            )}
                                                            {/* Row count */}
                                                            <span className="text-[10px] bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full font-bold">
                                                                {pipelineResult.profile.rowCount} rows
                                                            </span>
                                                        </div>
                                                        {/* Confidence Badge — clickable to expand breakdown */}
                                                        <div className="relative">
                                                            <button
                                                                onClick={() => setShowConfidenceBreakdown(!showConfidenceBreakdown)}
                                                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border cursor-pointer transition-all hover:opacity-80 ${pipelineResult.confidence.level === 'high'
                                                                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/20'
                                                                    : pipelineResult.confidence.level === 'medium'
                                                                        ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-500/20'
                                                                        : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/20'
                                                                    }`}
                                                                title="Click to see confidence breakdown"
                                                            >
                                                                <span>{pipelineResult.confidence.level === 'high' ? '✓' : pipelineResult.confidence.level === 'medium' ? '⚠' : '✗'}</span>
                                                                <span>{pipelineResult.confidence.score}% confidence</span>
                                                                <span className="ml-0.5 opacity-60">{showConfidenceBreakdown ? '▲' : '▼'}</span>
                                                            </button>

                                                            {/* Expandable Confidence Breakdown */}
                                                            {showConfidenceBreakdown && (
                                                                <div className="absolute top-full right-0 mt-2 w-80 bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl z-30 overflow-hidden animate-in fade-in slide-in-from-top-2">
                                                                    <div className="p-3 border-b border-gray-100 dark:border-white/5">
                                                                        <div className="flex items-center justify-between">
                                                                            <span className="text-xs font-bold text-gray-700 dark:text-white">Confidence Breakdown</span>
                                                                            <span className={`text-lg font-black ${pipelineResult.confidence.level === 'high' ? 'text-emerald-500'
                                                                                : pipelineResult.confidence.level === 'medium' ? 'text-yellow-500' : 'text-red-500'
                                                                                }`}>{pipelineResult.confidence.score}/100</span>
                                                                        </div>
                                                                    </div>
                                                                    <div className="p-3 space-y-2">
                                                                        {/* Factor bars */}
                                                                        {[
                                                                            { label: 'Semantic Match', value: pipelineResult.confidence.factors.semanticMatch, max: 30 },
                                                                            { label: 'Filter Clarity', value: pipelineResult.confidence.factors.filterClarity, max: 20 },
                                                                            { label: 'Aggregation Certainty', value: pipelineResult.confidence.factors.aggregationCertainty, max: 20 },
                                                                            { label: 'Plan Complexity', value: pipelineResult.confidence.factors.planComplexity, max: 15 },
                                                                            { label: 'SQL Quality', value: pipelineResult.confidence.factors.repairAttempts, max: 15 },
                                                                        ].map(factor => (
                                                                            <div key={factor.label}>
                                                                                <div className="flex items-center justify-between mb-0.5">
                                                                                    <span className="text-[10px] font-medium text-gray-500 dark:text-slate-400">{factor.label}</span>
                                                                                    <span className={`text-[10px] font-bold ${factor.value >= factor.max * 0.8 ? 'text-emerald-500'
                                                                                        : factor.value >= factor.max * 0.5 ? 'text-yellow-500' : 'text-red-500'
                                                                                        }`}>{factor.value}/{factor.max}</span>
                                                                                </div>
                                                                                <div className="h-1.5 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden">
                                                                                    <div
                                                                                        className={`h-full rounded-full transition-all ${factor.value >= factor.max * 0.8 ? 'bg-emerald-500'
                                                                                            : factor.value >= factor.max * 0.5 ? 'bg-yellow-500' : 'bg-red-500'
                                                                                            }`}
                                                                                        style={{ width: `${(factor.value / factor.max) * 100}%` }}
                                                                                    />
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                    {/* Reasons */}
                                                                    {pipelineResult.confidence.reasons.length > 0 && (
                                                                        <div className="px-3 pb-3 border-t border-gray-100 dark:border-white/5 pt-2">
                                                                            <div className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-1.5">Why this score</div>
                                                                            <div className="space-y-1">
                                                                                {pipelineResult.confidence.reasons.map((reason: string, i: number) => (
                                                                                    <div key={i} className="flex items-start gap-1.5 text-[10px] text-gray-600 dark:text-slate-300">
                                                                                        <span className="mt-0.5 flex-shrink-0">{reason.includes('matched exactly') || reason.includes('Verified') ? '✅' : reason.includes('ambiguous') || reason.includes('fail') ? '❌' : '⚠️'}</span>
                                                                                        <span>{reason}</span>
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                                {/* Time Grain Toggle — shown for growth ranking queries */}
                                                {pipelineResult && pipelineResult.plan && (pipelineResult.plan as any)._growthRanking && (
                                                    <div className="flex items-center gap-2 mb-2 px-1">
                                                        <span className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">Compare by:</span>
                                                        <div className="flex gap-1 bg-gray-100 dark:bg-slate-700/50 rounded-lg p-0.5">
                                                            {(['day', 'week', 'month', 'quarter', 'year'] as const).map(g => (
                                                                <button
                                                                    key={g}
                                                                    onClick={async () => {
                                                                        if (isLoading || timeGrain === g) return;
                                                                        setTimeGrain(g);
                                                                        setIsLoading(true);
                                                                        try {
                                                                            const result = await runAISQLPipeline(query, dataset!, undefined, undefined, g);
                                                                            if (result.rawData.length === 0 && result.explanation) {
                                                                                setPipelineResult(result);
                                                                                setGeneratedSQL(result.sql);
                                                                                setAiExplanation(result.explanation);
                                                                                setNoDataMsg(result.explanation);
                                                                                setIsLoading(false);
                                                                                return;
                                                                            }
                                                                            setPipelineResult(result);
                                                                            setGeneratedSQL(result.sql);
                                                                            setAiExplanation(result.explanation);
                                                                            setColumnsUsed(result.columnsUsed);
                                                                            setAnalysisResult({
                                                                                data: result.chartData,
                                                                                xKey: result.chart.xKey,
                                                                                yKey: result.chart.yKey,
                                                                                yLabel: result.chart.yKey,
                                                                                insight: result.explanation,
                                                                                sql: result.sql,
                                                                                config: {
                                                                                    metric: result.plan.metrics[0]?.field || result.chart.yKey,
                                                                                    dimension: result.plan.dimensions[0]?.field || result.chart.xKey,
                                                                                    aggregation: AggregationType.SUM,
                                                                                    timeGrain: TimeGrain.RAW,
                                                                                    analysisType: AnalysisType.STANDARD,
                                                                                    questionId: 'ai_sql_grain_' + Date.now(),
                                                                                    questionLabel: query,
                                                                                },
                                                                                vis: result.chart.chartType as any,
                                                                            });
                                                                            setNoDataMsg(null);
                                                                            setError(null);
                                                                        } catch (err: any) {
                                                                            setError(err.message || 'Failed to re-run with new grain');
                                                                        } finally {
                                                                            setIsLoading(false);
                                                                        }
                                                                    }}
                                                                    className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${timeGrain === g
                                                                        ? 'bg-amber-500 text-white shadow-sm'
                                                                        : 'text-gray-500 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                                                                        }`}
                                                                >
                                                                    {g.charAt(0).toUpperCase() + g.slice(1)}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                <ChartVisualization
                                                    data={analysisResult.data}
                                                    xKey={analysisResult.xKey}
                                                    yKey={analysisResult.yKey}
                                                    yLabel={analysisResult.yLabel}
                                                    chartType={(analysisResult.vis as any) || 'bar'}
                                                    onChartTypeChange={(type) => setAnalysisResult(prev => prev ? { ...prev, vis: type } : null)}
                                                    formatting={formatting}
                                                    onToggleFormat={() => setIsFormatPanelOpen(!isFormatPanelOpen)}
                                                    isFormatOpen={isFormatPanelOpen}
                                                    onToggleAnalytics={() => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen)}
                                                    isAnalyticsOpen={isAnalyticsPanelOpen}
                                                    onToggleLabels={() => updateFormatting({ ...formatting, showDataLabels: !formatting.showDataLabels })}
                                                    onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                                    isAIInsightOpen={isAIInsightOpen}
                                                    chartContainerRef={chartContainerRef}
                                                />

                                                {/* AI Insight Panel */}
                                                <AIInsightPanel isOpen={isAIInsightOpen} onClose={() => setIsAIInsightOpen(false)} chartContainerRef={chartContainerRef} chartTitle={analysisResult?.yLabel} />

                                                {/* FLOATING FORMAT PANEL */}
                                                {isFormatPanelOpen && (
                                                    <div className="absolute top-4 right-4 w-64 bg-white/95 dark:bg-slate-800/95 backdrop-blur shadow-xl border border-gray-200 dark:border-white/10 rounded-xl p-4 z-20 animate-in fade-in slide-in-from-right-4">
                                                        <div className="flex justify-between items-center mb-3">
                                                            <h3 className="font-bold text-gray-700 dark:text-white flex items-center gap-2 text-sm">
                                                                <Palette className="w-4 h-4 text-amber-500" />
                                                                Chart Style
                                                            </h3>
                                                            <button onClick={() => setIsFormatPanelOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"><X className="w-4 h-4" /></button>
                                                        </div>
                                                        <div className="space-y-4">
                                                            <div>
                                                                <label className="text-xs font-semibold text-gray-500 dark:text-slate-500 mb-1 block">Color Palette</label>
                                                                <div className="grid grid-cols-5 gap-1">
                                                                    {['vibrant', 'electric', 'neon', 'sunset', 'ocean'].map(mode => (
                                                                        <button key={mode} onClick={() => updateFormatting({ ...formatting, colorMode: mode as any })} className={`h-6 rounded border ${formatting.colorMode === mode ? 'ring-2 ring-amber-500 border-transparent' : 'border-gray-200 dark:border-slate-600 hover:border-gray-300'}`} style={{ background: mode === 'vibrant' ? '#3b82f6' : mode === 'electric' ? '#6366f1' : mode === 'neon' ? '#22c55e' : mode === 'sunset' ? '#f97316' : '#0ea5e9' }} title={mode} />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-semibold text-gray-500 dark:text-slate-500 mb-1 block">Number Format</label>
                                                                <select value={formatting.numberFormat} onChange={e => updateFormatting({ ...formatting, numberFormat: e.target.value as any })} className="w-full text-sm border-gray-200 dark:border-slate-600 rounded-md py-1 text-gray-700 dark:text-white bg-white dark:bg-slate-700 focus:ring-amber-500 focus:border-amber-500">
                                                                    <option value="auto">✨ Intelligent (Auto)</option>
                                                                    <option value="raw">Raw Number</option>
                                                                    <option value="currency_usd">Currency (USD)</option>
                                                                    <option value="currency_eur">Currency (EUR)</option>
                                                                    <option value="percent">Percentage (%)</option>
                                                                    <option value="compact">Compact (1k, 1M)</option>
                                                                </select>
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-semibold text-gray-500 dark:text-slate-500 mb-1 block">Decimals</label>
                                                                <div className="flex bg-gray-100 dark:bg-slate-700 rounded p-1">
                                                                    {([0, 1, 2]).map(d => (
                                                                        <button key={d} onClick={() => updateFormatting({ ...formatting, decimals: d })} className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === d ? 'bg-white dark:bg-slate-600 text-amber-600 dark:text-amber-400 shadow-sm font-medium' : 'text-gray-500 dark:text-slate-400 hover:text-gray-700'}`}>{d}</button>
                                                                    ))}
                                                                    <button onClick={() => updateFormatting({ ...formatting, decimals: undefined })} className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === undefined ? 'bg-white dark:bg-slate-600 text-amber-600 dark:text-amber-400 shadow-sm font-medium' : 'text-gray-500 dark:text-slate-400 hover:text-gray-700'}`}>Auto</button>
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col gap-2 pt-2 border-t border-gray-100 dark:border-white/5 mt-2">
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.showDataLabels} onChange={e => updateFormatting({ ...formatting, showDataLabels: e.target.checked })} className="rounded text-amber-600 focus:ring-amber-500" />
                                                                    <span className="text-sm text-gray-600 dark:text-slate-300 font-medium">Show Data Labels</span>
                                                                </label>
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.showLabels} onChange={e => updateFormatting({ ...formatting, showLabels: e.target.checked })} className="rounded text-amber-600 focus:ring-amber-500" />
                                                                    <span className="text-sm text-gray-600 dark:text-slate-300">Show Legend</span>
                                                                </label>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                                {/* FLOATING ANALYTICS PANEL */}
                                                {isAnalyticsPanelOpen && (
                                                    <div className="absolute top-4 left-4 w-72 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl shadow-2xl border border-gray-200 dark:border-white/10 rounded-xl p-0 z-20 animate-in fade-in slide-in-from-left-4 overflow-hidden">
                                                        <div className="p-4 border-b border-gray-100 dark:border-white/5">
                                                            <div className="flex justify-between items-center">
                                                                <h3 className="font-bold text-gray-700 dark:text-white flex items-center gap-2 text-sm">
                                                                    <Activity className="w-4 h-4 text-emerald-500" />
                                                                    Analytics
                                                                </h3>
                                                                <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"><X className="w-4 h-4" /></button>
                                                            </div>
                                                        </div>
                                                        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
                                                            <div className="space-y-1">
                                                                {([
                                                                    { id: 'percent_of_total', desc: 'Each value as % of column total' },
                                                                    { id: 'rank_desc', desc: 'Rank from highest to lowest' },
                                                                    { id: 'rank_asc', desc: 'Rank from lowest to highest' },
                                                                    { id: 'running_total', desc: 'Cumulative sum across rows' },
                                                                    { id: 'moving_avg', desc: 'Smooth values with N-period average' },
                                                                    { id: 'pct_diff_from_prev', desc: '% change from previous row' },
                                                                    { id: 'diff_from_prev', desc: 'Absolute difference from previous row' },
                                                                ] as { id: TableCalculation; desc: string }[]).map(({ id: calc, desc }) => {
                                                                    const isSelected = (formatting.tableCalculations || []).includes(calc);
                                                                    return (
                                                                        <label key={calc} className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? 'bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-gray-50 dark:hover:bg-white/5 border border-transparent hover:border-gray-200 dark:hover:border-white/10'}`}>
                                                                            <input type="checkbox" checked={isSelected} onChange={() => { const current = formatting.tableCalculations || []; const updated = isSelected ? current.filter(c => c !== calc) : [...current, calc]; updateFormatting({ ...formatting, tableCalculations: updated }); }} className="rounded text-emerald-600 focus:ring-emerald-500" />
                                                                            <div className="flex-1 min-w-0">
                                                                                <span className="text-xs font-bold text-gray-700 dark:text-white leading-tight block">{getCalculationDisplayName(calc)}</span>
                                                                                <span className="text-[10px] text-gray-500 dark:text-slate-500 leading-tight">{desc}</span>
                                                                            </div>
                                                                        </label>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Table Tab */}
                                        {activeResultTab === 'table' && (
                                            <div className="h-full overflow-auto p-4">
                                                <table className="w-full text-sm border-collapse">
                                                    <thead>
                                                        <tr className="border-b border-gray-200 dark:border-white/10">
                                                            {analysisResult.data.length > 0 && Object.keys(analysisResult.data[0]).map(col => (
                                                                <th key={col} className="text-left text-gray-500 dark:text-slate-400 font-bold text-xs uppercase tracking-wider px-3 py-2 bg-gray-50 dark:bg-slate-700/30 sticky top-0">
                                                                    {col}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {analysisResult.data.map((row: any, i: number) => (
                                                            <tr key={i} className="border-b border-gray-100 dark:border-white/5 hover:bg-gray-50 dark:hover:bg-slate-700/20 transition-colors">
                                                                {Object.values(row).map((val: any, j: number) => (
                                                                    <td key={j} className="px-3 py-2 text-gray-900 dark:text-white font-mono text-xs">
                                                                        {typeof val === 'number'
                                                                            ? val.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                                                            : String(val ?? '')}
                                                                    </td>
                                                                ))}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                                <div className="text-xs text-gray-400 dark:text-slate-500 mt-3 text-center">
                                                    {analysisResult.data.length} rows
                                                </div>
                                            </div>
                                        )}

                                        {/* SQL Tab */}
                                        {activeResultTab === 'sql' && (
                                            <div className="h-full overflow-auto p-4">
                                                <div className="bg-gray-50 dark:bg-slate-900 rounded-lg p-4 border border-gray-200 dark:border-white/5">
                                                    <div className="flex items-center justify-between mb-3">
                                                        <span className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                                            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                                                            AI-Generated SQL
                                                        </span>
                                                        <button
                                                            onClick={handleCopySQL}
                                                            className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition-colors flex items-center gap-1"
                                                        >
                                                            {copiedSQL ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy</>}
                                                        </button>
                                                    </div>
                                                    <pre className="text-sm text-emerald-700 dark:text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed">
                                                        {analysisResult.sql || 'No SQL generated for this query.'}
                                                    </pre>
                                                </div>
                                                {aiExplanation && (
                                                    <div className="mt-4 bg-amber-50 dark:bg-amber-500/5 rounded-lg p-4 border border-amber-200 dark:border-amber-500/10">
                                                        <div className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                                                            <Database className="w-3.5 h-3.5" />
                                                            Explanation
                                                        </div>
                                                        <p className="text-sm text-amber-800 dark:text-amber-200/80 leading-relaxed">{aiExplanation}</p>
                                                    </div>
                                                )}
                                                {/* Enterprise Trust Panel */}
                                                {pipelineResult && (
                                                    <div className="mt-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-4 border border-slate-200 dark:border-white/5 space-y-3">
                                                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                                            🔍 Query Trace
                                                        </div>
                                                        <div className="grid grid-cols-2 gap-3 text-xs">
                                                            <div>
                                                                <span className="text-slate-400 dark:text-slate-500">Intent:</span>
                                                                <span className="ml-1.5 font-bold text-slate-700 dark:text-white">{pipelineResult.plan.intent}</span>
                                                            </div>
                                                            <div>
                                                                <span className="text-slate-400 dark:text-slate-500">Grain:</span>
                                                                <span className="ml-1.5 font-bold text-slate-700 dark:text-white">{pipelineResult.plan.resultGrain}</span>
                                                            </div>
                                                            <div>
                                                                <span className="text-slate-400 dark:text-slate-500">Chart:</span>
                                                                <span className="ml-1.5 font-bold text-slate-700 dark:text-white">{pipelineResult.chart.chartType}</span>
                                                            </div>
                                                            <div>
                                                                <span className="text-slate-400 dark:text-slate-500">Execution:</span>
                                                                <span className="ml-1.5 font-bold text-slate-700 dark:text-white">{pipelineResult.executionTimeMs}ms</span>
                                                            </div>
                                                            <div className="col-span-2">
                                                                <span className="text-slate-400 dark:text-slate-500">Chart Reason:</span>
                                                                <span className="ml-1.5 font-medium text-slate-600 dark:text-slate-300">{pipelineResult.chart.reason}</span>
                                                            </div>
                                                            {pipelineResult.repairAttempts > 0 && (
                                                                <div className="col-span-2">
                                                                    <span className="text-yellow-500">⚠ SQL required {pipelineResult.repairAttempts} repair attempt(s)</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {/* Validation Checks */}
                                                        <div className="pt-2 border-t border-slate-100 dark:border-white/5">
                                                            <div className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase mb-1.5">Validation</div>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                {pipelineResult.validation.checks.slice(0, 6).map((check, i) => (
                                                                    <span key={i} className={'text-[10px] px-2 py-0.5 rounded-full font-medium ' + (
                                                                        check.status === 'pass' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                                                                            : check.status === 'warn' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400'
                                                                                : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                                                                    )} title={check.message}>
                                                                        {check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗'} {check.name}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                ) : !isLoading && (
                                    <div className="flex-1 h-full flex items-center justify-center text-gray-400 dark:text-slate-500">
                                        <div className="flex flex-col items-center gap-2">
                                            <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-slate-700/50 flex items-center justify-center">
                                                <BarChart2 className="w-6 h-6 opacity-20" />
                                            </div>
                                            <p className="text-sm">Results will appear here</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
