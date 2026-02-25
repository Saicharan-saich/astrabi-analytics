import React, { useState, useRef } from 'react';
import { MessageSquare, Play, RefreshCw, Search, CheckCircle2, AlertTriangle, BarChart2, Table, Code, Pin, Eye, EyeOff, Lightbulb, ArrowRight, Palette, Activity, X, RotateCcw } from 'lucide-react';
import { Dataset, QueryConfig, AnalysisResult, AnalysisType, AggregationType, TimeGrain, ColumnType, FormattingConfig } from '../types';
import { parseNLQ, NLQParseResult } from '../services/nlqParser';
import { matchQuestion, isGibberish, QuestionMatch, NLQMatchResult } from '../services/nlqDictionary';
import { QUESTION_REGISTRY } from '../services/questionRegistry';
import { runAnalysis } from '../services/analysisEngine';
import { ChartVisualization } from './ChartVisualization';
import { Tooltip } from './Tooltip';
import { AIInsightPanel } from './AIInsightPanel';
import { getCalculationDisplayName, type TableCalculation } from '../utils/tableCalculations';

interface NLQViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
}

export const NLQView: React.FC<NLQViewProps> = ({ dataset, onPin }) => {
    const [query, setQuery] = useState('');
    const [isParsing, setIsParsing] = useState(false);
    const [parseResult, setParseResult] = useState<NLQParseResult | null>(null);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [activeResultTab, setActiveResultTab] = useState<'chart' | 'table' | 'sql'>('chart');
    const [isInputCollapsed, setIsInputCollapsed] = useState(false);
    const [isLogicTraceOpen, setIsLogicTraceOpen] = useState(false);
    const [suggestions, setSuggestions] = useState<QuestionMatch[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [matchedQuestion, setMatchedQuestion] = useState<string | null>(null);
    const [matchConfidence, setMatchConfidence] = useState<number>(0);
    const [formatting, setFormatting] = useState<FormattingConfig>({
        colorMode: 'vibrant',
        numberFormat: 'auto',
        fontSize: 'md',
        headerSize: 'md',
        headerBold: true,
        showLabels: true,
        showDataLabels: true,
        tableCalculations: [],
        showXAxis: true,
        showYAxis: true
    });
    const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
    const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
    const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
    const chartContainerRef = useRef<HTMLDivElement>(null);

    const updateFormatting = (f: FormattingConfig) => setFormatting(f);

    const examples = [
        "Show total sales by region",
        "Average profit by category",
        "Sales this week vs last week",
        "Count of orders by month",
        "Top 5 products by revenue",
        "Total profit this year"
    ];

    // Run a question from the registry by ID
    const runRegistryQuestion = (questionId: string, label?: string) => {
        if (!dataset) return;
        setIsParsing(true);
        setError(null);
        setAnalysisResult(null);
        setShowSuggestions(false);
        setSuggestions([]);
        setActiveResultTab('chart');

        try {
            const question = QUESTION_REGISTRY.find(q => q.id === questionId);
            if (!question) {
                setError(`Question "${questionId}" not found in registry.`);
                setIsParsing(false);
                return;
            }

            // Use parseNLQ with the question's canonical text for best column matching
            const parsed = parseNLQ(label || question.question, dataset);
            setParseResult(parsed);
            setMatchedQuestion(question.question);

            const config: QueryConfig = {
                metric: parsed.metric,
                dimension: parsed.dimension,
                aggregation: parsed.aggregation,
                timeGrain: parsed.timeGrain,
                timeFilter: parsed.timeFilter,
                analysisType: AnalysisType.STANDARD,
                filters: parsed.filters,
                measureFilters: parsed.measureFilters,
                dateFilters: parsed.dateFilters.map(df => ({
                    column: df.column,
                    timeGrain: df.timeGrain as any,
                    values: df.values
                })),
                limit: parsed.limit || 20,
                sort: parsed.sort,
                questionId: question.id,
                questionLabel: question.question,
                asOfDate: dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0],
            };

            const res = runAnalysis(dataset, config);
            if (res.error) {
                setError(res.error);
            } else {
                setAnalysisResult(res);
            }
        } catch (err: any) {
            setError(err.message || 'Failed to run question.');
        } finally {
            setIsParsing(false);
        }
    };

    const handleParseAndRun = () => {
        if (!dataset || !query.trim()) return;

        setIsParsing(true);
        setError(null);
        setAnalysisResult(null);
        setSuggestions([]);
        setShowSuggestions(false);
        setMatchedQuestion(null);
        setMatchConfidence(0);
        setActiveResultTab('chart');

        try {
            // ─── ALWAYS RUN NLQ PARSER FIRST ─────────────────────
            // The parser maps user words directly to dataset columns
            // using synonym expansion + fuzzy matching. This handles
            // ANY freeform question like "show me region wise sales".
            const parsed = parseNLQ(query, dataset);
            setParseResult(parsed);

            // Apply detected table calculations to formatting
            if (parsed.tableCalculations && parsed.tableCalculations.length > 0) {
                setFormatting(f => ({
                    ...f,
                    tableCalculations: parsed.tableCalculations as any,
                    ...(parsed.movingAvgWindow ? { movingAvgWindow: parsed.movingAvgWindow } : {}),
                }));
            } else {
                // Reset table calculations for plain queries
                setFormatting(f => ({
                    ...f,
                    tableCalculations: [],
                }));
            }
            const config: QueryConfig = {
                metric: parsed.metric,
                dimension: parsed.dimension,
                aggregation: parsed.aggregation,
                timeGrain: parsed.timeGrain,
                timeFilter: parsed.timeFilter,
                analysisType: AnalysisType.STANDARD,
                filters: parsed.filters,
                measureFilters: parsed.measureFilters,
                dateFilters: parsed.dateFilters.map(df => ({
                    column: df.column,
                    timeGrain: df.timeGrain as any,
                    values: df.values
                })),
                limit: parsed.limit || 20,
                sort: parsed.sort,
                questionId: 'nlq_generated_' + Date.now(),
                questionLabel: query,
                asOfDate: dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0],
            };

            // ─── COMPARISON: Dual-period analysis ─────────────────
            if (parsed.comparison && parsed.comparison.type === 'period_vs_period') {
                const baseConfig = { ...config, dimension: '', limit: 0 };
                const configA: QueryConfig = { ...baseConfig, timeFilter: parsed.comparison.periodA, questionId: 'nlq_cmp_a_' + Date.now() };
                const configB: QueryConfig = { ...baseConfig, timeFilter: parsed.comparison.periodB, questionId: 'nlq_cmp_b_' + Date.now() };

                const resA = runAnalysis(dataset, configA);
                const resB = runAnalysis(dataset, configB);

                if (resA.error && resB.error) {
                    setError(`Comparison failed: ${resA.error}`);
                } else {
                    // Extract the aggregate value from each period
                    const valA = resA.data?.[0] ? Number(Object.values(resA.data[0]).find(v => typeof v === 'number') || 0) : 0;
                    const valB = resB.data?.[0] ? Number(Object.values(resB.data[0]).find(v => typeof v === 'number') || 0) : 0;

                    const diff = valA - valB;
                    const pct = valB !== 0 ? ((valA - valB) / Math.abs(valB)) * 100 : (valA > 0 ? 100 : 0);

                    const metricKey = parsed.metric || resA.yKey || 'value';
                    const combinedResult: AnalysisResult = {
                        data: [
                            { period: parsed.comparison.labelA, [metricKey]: valA },
                            { period: parsed.comparison.labelB, [metricKey]: valB },
                        ],
                        xKey: 'period',
                        yKey: metricKey,
                        yLabel: `${parsed.comparison.labelA} vs ${parsed.comparison.labelB}: ${metricKey}`,
                        vis: 'groupedBar',
                        sql: `-- Period A: ${parsed.comparison.labelA}\n${resA.sql || ''}\n\n-- Period B: ${parsed.comparison.labelB}\n${resB.sql || ''}`,
                        config: config,
                        kpi: valA,
                        growth: { diff, pct },
                        insight: `${parsed.comparison.labelA}: ${valA.toLocaleString(undefined, { maximumFractionDigits: 2 })} | ${parsed.comparison.labelB}: ${valB.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Change: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
                    };
                    setAnalysisResult(combinedResult);
                }
            } else {
                // ─── STANDARD: Single analysis ────────────────────────
                const res = runAnalysis(dataset, config);

                if (res.error) {
                    setError(res.error);
                    const match = matchQuestion(query);
                    if (match.suggestions.length > 0 && match.suggestions[0].score > 0.15) {
                        setSuggestions(match.suggestions);
                        setShowSuggestions(true);
                    }
                } else if (res.data && res.data.length > 0) {
                    // Auto-switch to pie chart when percent_of_total calculation is detected
                    if (parsed.tableCalculations && parsed.tableCalculations.some((tc: any) => tc.calc === 'percent_of_total')) {
                        setAnalysisResult({ ...res, vis: 'pie' });
                    } else {
                        setAnalysisResult(res);
                    }
                    if (parsed.confidence < 0.6) {
                        const match = matchQuestion(query);
                        if (match.suggestions.length > 0 && match.suggestions[0].score > 0.15) {
                            setSuggestions(match.suggestions);
                            setShowSuggestions(true);
                        }
                    }
                }
            }
        } catch (err: any) {
            setError(err.message || "Failed to parse query.");
            // On crash, try to show suggestions
            try {
                const match = matchQuestion(query);
                if (match.suggestions.length > 0) {
                    setSuggestions(match.suggestions);
                    setShowSuggestions(true);
                }
            } catch { /* ignore */ }
        } finally {
            setIsParsing(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleParseAndRun();
    };

    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
                <MessageSquare className="w-16 h-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Please load a dataset to ask questions.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-gray-50 dark:bg-slate-900 p-6 overflow-hidden">
            <div className="max-w-5xl mx-auto w-full flex flex-col h-full gap-5">

                {/* Header */}
                <div className="flex flex-col gap-1 shrink-0">
                    <Tooltip text="Ask Data lets you type questions in plain English and instantly get charts. Uses deterministic parsing based on your column names — fully predictable results." position="right">
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                            <MessageSquare className="w-6 h-6 text-indigo-500 dark:text-indigo-400" />
                            Ask Data
                        </h2>
                    </Tooltip>
                    <p className="text-gray-500 dark:text-slate-400 text-sm">
                        Type a question like "total revenue by region" or "profit by month for last 90 days".
                        Results are deterministic — powered by smart column-name matching.
                    </p>
                </div>

                {/* Collapsible Input + Suggestions */}
                <div className={`shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isInputCollapsed ? 'max-h-0' : 'max-h-[400px]'}`}>
                    {/* Input Area */}
                    <Tooltip text="Type a natural-language question like 'revenue by product last 30 days' or 'top 5 regions by profit'. Press Enter or click Run." position="bottom">
                        <div className="relative group">
                            <div className="absolute inset-0 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl blur opacity-25 group-hover:opacity-40 transition-opacity pointer-events-none" />
                            <div className={`relative bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-xl p-2 flex items-center shadow-lg dark:shadow-2xl transition-all duration-300 ${query.trim() ? 'nlq-input-active' : 'hover:border-indigo-500/30'}`}>
                                <Search className="w-5 h-5 text-gray-400 dark:text-slate-400 ml-3" />
                                <input
                                    className="flex-1 bg-transparent border-none outline-none text-gray-900 dark:text-white px-4 py-3 placeholder:text-gray-400 dark:placeholder:text-slate-500 font-medium"
                                    placeholder="e.g. Total sales by region for last 7 days..."
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                />
                                <button
                                    onClick={handleParseAndRun}
                                    disabled={!query.trim() || isParsing}
                                    className="btn-premium bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-bold flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isParsing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                                    Run
                                </button>
                            </div>
                        </div>
                    </Tooltip>

                    {/* Empty State / Suggestions */}
                    {!analysisResult && !parseResult && !error && !showSuggestions && (
                        <div className="flex-1 flex flex-col items-center justify-center opacity-60 mt-6">
                            <p className="text-gray-500 dark:text-slate-400 mb-6 uppercase tracking-wider text-xs font-bold">Try asking:</p>
                            <div className="flex flex-wrap justify-center gap-3 max-w-2xl">
                                {examples.map((ex, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setQuery(ex)}
                                        className="px-4 py-2 rounded-full border border-gray-200 dark:border-white/10 hover:border-indigo-500/50 hover:bg-indigo-500/10 text-gray-600 dark:text-slate-300 text-sm transition-all"
                                    >
                                        {ex}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ─── "Did you mean?" Suggestion Panel ─── */}
                    {showSuggestions && suggestions.length > 0 && (
                        <div className="mt-4 bg-gradient-to-b from-amber-900/20 to-slate-800/50 rounded-xl border border-amber-500/20 p-5 animate-in fade-in slide-in-from-top-2">
                            <div className="flex items-center gap-2 mb-4">
                                <Lightbulb className="w-5 h-5 text-amber-400" />
                                <h3 className="text-sm font-bold text-amber-300">Did you mean one of these?</h3>
                                <span className="text-xs text-slate-500 ml-auto">Click a suggestion to run it</span>
                            </div>
                            <div className="space-y-2">
                                {suggestions.map((s, i) => (
                                    <button
                                        key={s.questionId}
                                        onClick={() => {
                                            setQuery(s.question);
                                            setShowSuggestions(false);
                                            setSuggestions([]);
                                            setError(null);
                                            runRegistryQuestion(s.questionId, s.question);
                                        }}
                                        className={`w-full text-left bg-slate-800/80 hover:bg-indigo-500/15 border rounded-lg p-3 transition-all flex items-center gap-3 group ${i === 0 ? 'border-indigo-500/30 ring-1 ring-indigo-500/10' : 'border-white/5 hover:border-indigo-500/20'
                                            }`}
                                    >
                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${i === 0 ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-700 text-slate-400'
                                            }`}>
                                            {i + 1}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-white truncate">{s.question}</div>
                                            <div className="text-xs text-slate-500 mt-0.5">
                                                {s.category} · {Math.round(s.score * 100)}% match
                                                {s.matchedKeywords.length > 0 && (
                                                    <span className="text-slate-600"> · matched: {s.matchedKeywords.slice(0, 3).join(', ')}</span>
                                                )}
                                            </div>
                                        </div>
                                        <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-indigo-400 transition-colors shrink-0" />
                                    </button>
                                ))}
                            </div>
                            <div className="mt-3 flex items-center justify-between">
                                <button
                                    onClick={() => { setShowSuggestions(false); setSuggestions([]); }}
                                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    Dismiss suggestions
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Results Area */}
                {(parseResult || analysisResult || error) && (
                    <div className="flex-1 min-h-0 flex gap-0 overflow-hidden">

                        {/* Left: Collapsible Logic Trace */}
                        {parseResult && (
                            <div className={`shrink-0 flex flex-col transition-all duration-300 ease-in-out overflow-hidden ${isLogicTraceOpen ? 'w-72 mr-4' : 'w-0'}`}>
                                <div className="w-72 flex flex-col gap-4 overflow-y-auto pr-2 custom-scrollbar h-full">
                                    <div className="bg-slate-800/50 rounded-xl p-4 border border-white/5 space-y-4">
                                        <div className="flex items-center justify-between">
                                            <Tooltip text="Shows how your question was parsed: which metric, dimension, aggregation, and time filter were detected from your input." position="right">
                                                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                                                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                                    Logic Trace
                                                </h3>
                                            </Tooltip>
                                            <span className={`text-xs px-2 py-1 rounded bg-slate-700 ${parseResult.confidence > 0.8 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                                {Math.round(parseResult.confidence * 100)}%
                                            </span>
                                        </div>

                                        <div className="space-y-2">
                                            {parseResult.explanation.map((step, idx) => (
                                                <div key={idx} className="text-sm text-slate-300 flex gap-2 items-start">
                                                    <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                                                    <span dangerouslySetInnerHTML={{ __html: step.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white">$1</strong>') }} />
                                                </div>
                                            ))}
                                        </div>

                                        {/* Debug Summary */}
                                        <div className="pt-3 border-t border-white/5 grid grid-cols-2 gap-1.5 text-xs">
                                            <div className="text-slate-500">Metric</div>
                                            <div className="text-white font-mono">{parseResult.metric || 'None'}</div>
                                            <div className="text-slate-500">Dimension</div>
                                            <div className="text-white font-mono">{parseResult.dimension || 'None'}</div>
                                            <div className="text-slate-500">Aggregation</div>
                                            <div className="text-white font-mono">{parseResult.aggregation}</div>
                                            <div className="text-slate-500">Time Grain</div>
                                            <div className="text-white font-mono">{parseResult.timeGrain}</div>
                                            {parseResult.timeFilter && <>
                                                <div className="text-slate-500">Time Filter</div>
                                                <div className="text-emerald-400 font-mono">{parseResult.timeFilter.replace(/_/g, ' ')}</div>
                                            </>}
                                            {parseResult.dateFilters.length > 0 && <>
                                                <div className="text-slate-500">Date Filters</div>
                                                <div className="text-white font-mono">{parseResult.dateFilters.length} active</div>
                                            </>}
                                            {Object.keys(parseResult.filters).length > 0 && <>
                                                <div className="text-slate-500">Filters</div>
                                                <div className="text-white font-mono text-[10px]">{Object.entries(parseResult.filters).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ')}</div>
                                            </>}
                                            {parseResult.sort && <>
                                                <div className="text-slate-500">Sort</div>
                                                <div className="text-white font-mono">{parseResult.sort}</div>
                                            </>}
                                            {parseResult.limit && <>
                                                <div className="text-slate-500">Limit</div>
                                                <div className="text-white font-mono">{parseResult.limit}</div>
                                            </>}
                                        </div>
                                    </div>

                                    {error && (
                                        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 text-red-200 text-sm">
                                            <AlertTriangle className="w-5 h-5 shrink-0" />
                                            <div>
                                                <div className="font-bold mb-1">Analysis Failed</div>
                                                {error}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Error when no parse result */}
                        {!parseResult && error && (
                            <div className="w-72 shrink-0 mr-4">
                                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 text-red-200 text-sm">
                                    <AlertTriangle className="w-5 h-5 shrink-0" />
                                    <div>
                                        <div className="font-bold mb-1">Analysis Failed</div>
                                        {error}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Right: Visualization + Table + SQL */}
                        <div className="flex-1 flex flex-col min-h-0 bg-slate-800 rounded-xl border border-white/5 overflow-hidden shadow-2xl">

                            {/* Chart Loading Skeleton */}
                            {isParsing && !analysisResult && (
                                <div className="flex-1 flex flex-col items-center justify-center p-8">
                                    <div className="chart-skeleton w-full max-w-md h-48 mb-4">
                                        <div className="chart-skeleton-bars">
                                            <div className="chart-skeleton-bar" style={{ height: '60%' }} />
                                            <div className="chart-skeleton-bar" style={{ height: '85%' }} />
                                            <div className="chart-skeleton-bar" style={{ height: '45%' }} />
                                            <div className="chart-skeleton-bar" style={{ height: '92%' }} />
                                            <div className="chart-skeleton-bar" style={{ height: '70%' }} />
                                            <div className="chart-skeleton-bar" style={{ height: '55%' }} />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 text-slate-400 text-sm">
                                        <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                                        <span>Analyzing your question...</span>
                                    </div>
                                </div>
                            )}

                            {/* Tab Bar + Actions */}
                            {analysisResult && (
                                <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5 shrink-0 bg-slate-800/80">
                                    <div className="flex items-center gap-2">
                                        {/* Logic Trace Toggle */}
                                        {parseResult && (
                                            <button
                                                onClick={() => setIsLogicTraceOpen(!isLogicTraceOpen)}
                                                className={`flex items-center gap-1.5 text-[13px] font-bold px-3 py-2 rounded-lg transition-all mr-1 ${isLogicTraceOpen ? 'text-indigo-300 bg-indigo-500/20 ring-1 ring-indigo-500/30' : 'text-slate-400 hover:text-indigo-300 bg-slate-700/50 hover:bg-indigo-500/20'}`}
                                                title={isLogicTraceOpen ? 'Hide Logic Trace' : 'Show Logic Trace'}
                                            >
                                                <CheckCircle2 className="w-4 h-4" />
                                                Trace
                                            </button>
                                        )}
                                        {/* Input Toggle */}
                                        <button
                                            onClick={() => setIsInputCollapsed(!isInputCollapsed)}
                                            className="flex items-center gap-1.5 text-[13px] font-bold text-slate-400 hover:text-indigo-300 bg-slate-700/50 hover:bg-indigo-500/20 px-3 py-2 rounded-lg transition-all mr-1"
                                            title={isInputCollapsed ? 'Show Input' : 'Hide Input'}
                                        >
                                            {isInputCollapsed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                                            {isInputCollapsed ? 'Input' : 'Input'}
                                        </button>

                                        <div className="w-px h-5 bg-white/10 mx-1" />

                                        {([
                                            { id: 'chart' as const, icon: BarChart2, label: 'Chart' },
                                            { id: 'table' as const, icon: Table, label: 'Table' },
                                            { id: 'sql' as const, icon: Code, label: 'SQL' },
                                        ]).map(tab => (
                                            <button
                                                key={tab.id}
                                                onClick={() => setActiveResultTab(tab.id)}
                                                className={`px-3.5 py-2 rounded-lg flex items-center gap-2 text-[13px] font-bold transition-all ${activeResultTab === tab.id
                                                    ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-500/30'
                                                    : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                                                    }`}
                                            >
                                                <tab.icon className="w-4 h-4" />
                                                {tab.label}
                                            </button>
                                        ))}

                                        {/* X/Y Axis Toggles */}
                                        {activeResultTab === 'chart' && (
                                            <div className="flex items-center gap-1.5 ml-2">
                                                <span className="text-xs text-slate-500 font-semibold mr-0.5">Axis:</span>
                                                <button
                                                    onClick={() => setFormatting(f => ({ ...f, showXAxis: !f.showXAxis }))}
                                                    className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all border ${formatting.showXAxis ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-slate-700/50 text-slate-500 border-white/10 hover:bg-slate-700'}`}
                                                    title="Toggle X-Axis"
                                                >X</button>
                                                <button
                                                    onClick={() => setFormatting(f => ({ ...f, showYAxis: !f.showYAxis }))}
                                                    className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all border ${formatting.showYAxis ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' : 'bg-slate-700/50 text-slate-500 border-white/10 hover:bg-slate-700'}`}
                                                    title="Toggle Y-Axis"
                                                >Y</button>
                                            </div>
                                        )}

                                        {/* Top N / Bottom N Control — visible when query contains "top" or "bottom" */}
                                        {activeResultTab === 'chart' && /\b(top|bottom|best|worst)\b/i.test(query) && (
                                            <div className="flex items-center gap-1 ml-2 bg-gray-100 dark:bg-slate-700/60 rounded-lg px-2 py-1 border border-gray-200 dark:border-white/10">
                                                {/* Top / Bottom toggle */}
                                                <button
                                                    onClick={() => {
                                                        setQuery(q => q.replace(/\b(bottom|worst)\b/gi, 'top'));
                                                        setTimeout(() => handleParseAndRun(), 50);
                                                    }}
                                                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${/\b(top|best)\b/i.test(query) ? 'bg-indigo-500 text-white' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-600'}`}
                                                >Top</button>
                                                <button
                                                    onClick={() => {
                                                        setQuery(q => q.replace(/\b(top|best)\b/gi, 'bottom'));
                                                        setTimeout(() => handleParseAndRun(), 50);
                                                    }}
                                                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${/\b(bottom|worst)\b/i.test(query) ? 'bg-orange-500 text-white' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-600'}`}
                                                >Bottom</button>
                                                <div className="w-px h-4 bg-gray-300 dark:bg-white/10 mx-0.5" />
                                                {/* N stepper */}
                                                <button
                                                    onClick={() => {
                                                        const newLimit = Math.max(1, (analysisResult?.config?.limit || 10) - 1);
                                                        setQuery(q => q.replace(/\b\d+\b/, String(newLimit)));
                                                        if (analysisResult?.data && analysisResult.data.length > newLimit) {
                                                            setAnalysisResult(prev => prev ? { ...prev, data: prev.data.slice(0, newLimit), config: { ...prev.config!, limit: newLimit } } : null);
                                                        }
                                                    }}
                                                    className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-slate-600 hover:bg-gray-300 dark:hover:bg-slate-500 text-gray-700 dark:text-white rounded text-xs font-bold transition-all"
                                                >−</button>
                                                <span className="text-sm font-bold text-gray-900 dark:text-white min-w-[18px] text-center">{analysisResult?.config?.limit || analysisResult?.data?.length || 10}</span>
                                                <button
                                                    onClick={() => {
                                                        const newLimit = Math.min(50, (analysisResult?.config?.limit || 10) + 1);
                                                        setQuery(q => q.replace(/\b\d+\b/, String(newLimit)));
                                                        handleParseAndRun();
                                                    }}
                                                    className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-slate-600 hover:bg-gray-300 dark:hover:bg-slate-500 text-gray-700 dark:text-white rounded text-xs font-bold transition-all"
                                                >+</button>
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        onClick={() => onPin?.(query, analysisResult)}
                                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-[13px] font-bold transition-all flex items-center gap-2 shadow-lg"
                                    >
                                        <Pin className="w-4 h-4" />
                                        Pin to Dashboard
                                    </button>
                                    <button
                                        onClick={() => handleParseAndRun()}
                                        className="flex items-center text-[13px] font-bold text-gray-600 dark:text-slate-300 bg-gray-200 dark:bg-slate-700 hover:bg-gray-300 dark:hover:bg-slate-600 px-3.5 py-2 rounded-lg transition-all active:scale-95"
                                        title="Refresh — re-run current query"
                                    >
                                        <RefreshCw className="w-4 h-4 mr-1.5" /> Refresh
                                    </button>
                                    <button
                                        onClick={() => { setQuery(''); setAnalysisResult(null); setParseResult(null); setError(null); setSuggestions([]); setShowSuggestions(false); setMatchedQuestion(null); setMatchConfidence(0); setIsFormatPanelOpen(false); setIsAnalyticsPanelOpen(false); setIsAIInsightOpen(false); setFormatting(f => ({ ...f, tableCalculations: [] })); }}
                                        className="flex items-center text-[13px] font-bold text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 px-3.5 py-2 rounded-lg transition-all active:scale-95"
                                        title="Reset — clear all results and start fresh"
                                    >
                                        <RotateCcw className="w-4 h-4 mr-1.5" /> Reset
                                    </button>
                                </div>
                            )}

                            {/* Tab Content */}
                            <div className="flex-1 min-h-0 overflow-hidden">
                                {analysisResult ? (
                                    <>
                                        {/* Chart Tab */}
                                        {activeResultTab === 'chart' && analysisResult && (
                                            <div className="h-full p-4 overflow-hidden relative" ref={chartContainerRef}>
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
                                                    <div className="absolute top-4 right-4 w-64 bg-white/95 dark:bg-slate-800/95 backdrop-blur shadow-xl border border-slate-200 dark:border-white/10 rounded-xl p-4 z-20 animate-in fade-in slide-in-from-right-4">
                                                        <div className="flex justify-between items-center mb-3">
                                                            <h3 className="font-bold text-slate-700 dark:text-white flex items-center gap-2 text-sm">
                                                                <Palette className="w-4 h-4 text-indigo-500" />
                                                                Chart Style
                                                            </h3>
                                                            <button onClick={() => setIsFormatPanelOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"><X className="w-4 h-4" /></button>
                                                        </div>
                                                        <div className="space-y-4">
                                                            <div>
                                                                <label className="text-xs font-semibold text-slate-500 mb-1 block">Color Palette</label>
                                                                <div className="grid grid-cols-5 gap-1">
                                                                    {['vibrant', 'electric', 'neon', 'sunset', 'ocean'].map(mode => (
                                                                        <button key={mode} onClick={() => updateFormatting({ ...formatting, colorMode: mode as any })} className={`h-6 rounded border ${formatting.colorMode === mode ? 'ring-2 ring-indigo-500 border-transparent' : 'border-slate-200 hover:border-slate-300'}`} style={{ background: mode === 'vibrant' ? '#3b82f6' : mode === 'electric' ? '#6366f1' : mode === 'neon' ? '#22c55e' : mode === 'sunset' ? '#f97316' : '#0ea5e9' }} title={mode} />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-semibold text-slate-500 mb-1 block">Number Format</label>
                                                                <select value={formatting.numberFormat} onChange={e => updateFormatting({ ...formatting, numberFormat: e.target.value as any })} className="w-full text-sm border-slate-200 rounded-md py-1 text-slate-700 bg-white focus:ring-indigo-500 focus:border-indigo-500">
                                                                    <option value="auto">✨ Intelligent (Auto)</option>
                                                                    <option value="raw">Raw Number</option>
                                                                    <option value="currency_usd">Currency (USD)</option>
                                                                    <option value="currency_eur">Currency (EUR)</option>
                                                                    <option value="percent">Percentage (%)</option>
                                                                    <option value="compact">Compact (1k, 1M)</option>
                                                                </select>
                                                            </div>
                                                            <div>
                                                                <label className="text-xs font-semibold text-slate-500 mb-1 block">Decimals</label>
                                                                <div className="flex bg-slate-100 rounded p-1">
                                                                    {([0, 1, 2]).map(d => (
                                                                        <button key={d} onClick={() => updateFormatting({ ...formatting, decimals: d })} className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === d ? 'bg-white text-indigo-600 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}>{d}</button>
                                                                    ))}
                                                                    <button onClick={() => updateFormatting({ ...formatting, decimals: undefined })} className={`flex-1 text-xs py-1 rounded-md transition-all ${formatting.decimals === undefined ? 'bg-white text-indigo-600 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}>Auto</button>
                                                                </div>
                                                            </div>
                                                            <div className="flex flex-col gap-2 pt-2 border-t border-slate-100 mt-2">
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.headerBold} onChange={e => updateFormatting({ ...formatting, headerBold: e.target.checked })} className="rounded text-indigo-600 focus:ring-indigo-500" />
                                                                    <span className="text-sm text-slate-600 font-medium">Bold Chart Title</span>
                                                                </label>
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.axisBold ?? false} onChange={e => updateFormatting({ ...formatting, axisBold: e.target.checked })} className="rounded text-indigo-600 focus:ring-indigo-500" />
                                                                    <span className="text-sm text-slate-600 font-medium">Bold Axis Labels</span>
                                                                </label>
                                                                <div className="flex items-center gap-2">
                                                                    <label className="text-xs font-semibold text-slate-500">Axis Label Color</label>
                                                                    <input type="color" value={formatting.axisColor || '#475569'} onChange={e => updateFormatting({ ...formatting, axisColor: e.target.value })} className="w-6 h-6 rounded border border-slate-200 cursor-pointer p-0" />
                                                                    {formatting.axisColor && (<button onClick={() => updateFormatting({ ...formatting, axisColor: undefined })} className="text-[10px] text-slate-400 hover:text-slate-600">Reset</button>)}
                                                                </div>
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.showLabels} onChange={e => updateFormatting({ ...formatting, showLabels: e.target.checked })} className="rounded text-indigo-600 focus:ring-indigo-500" />
                                                                    <span className="text-sm text-slate-600">Show Legend</span>
                                                                </label>
                                                                <label className="flex items-center gap-2 cursor-pointer">
                                                                    <input type="checkbox" checked={formatting.showDataLabels} onChange={e => updateFormatting({ ...formatting, showDataLabels: e.target.checked })} className="rounded text-indigo-600 focus:ring-indigo-500" />
                                                                    <span className="text-sm text-slate-600 font-medium">Show Data Labels</span>
                                                                </label>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                                {/* FLOATING ANALYTICS PANEL */}
                                                {isAnalyticsPanelOpen && (
                                                    <div className="absolute top-4 left-4 w-72 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl shadow-2xl border border-slate-200 dark:border-white/10 rounded-xl p-0 z-20 animate-in fade-in slide-in-from-left-4 overflow-hidden">
                                                        <div className="p-4 border-b border-slate-100 dark:border-white/5 bg-gradient-to-r from-slate-50 dark:from-slate-800 to-white dark:to-transparent">
                                                            <div className="flex justify-between items-center">
                                                                <h3 className="font-bold text-slate-700 dark:text-white flex items-center gap-2 text-sm">
                                                                    <Activity className="w-4 h-4 text-emerald-500" />
                                                                    Analytics
                                                                </h3>
                                                                <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"><X className="w-4 h-4" /></button>
                                                            </div>
                                                        </div>
                                                        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
                                                            <div>
                                                                <div className="flex items-center gap-2 mb-2">
                                                                    <div className="w-5 h-5 rounded bg-emerald-100 flex items-center justify-center">
                                                                        <svg className="w-3 h-3 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                                        </svg>
                                                                    </div>
                                                                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Table Calculation</span>
                                                                </div>
                                                                <div className="space-y-1 max-h-[280px] overflow-y-auto pr-1">
                                                                    {([
                                                                        { id: 'percent_of_total', desc: 'Each value as % of column total' },
                                                                        { id: 'rank_desc', desc: 'Rank from highest to lowest' },
                                                                        { id: 'rank_asc', desc: 'Rank from lowest to highest' },
                                                                        { id: 'running_total', desc: 'Cumulative sum across rows' },
                                                                        { id: 'moving_avg', desc: 'Smooth values with N-period average' },
                                                                        { id: 'pct_diff_from_prev', desc: 'Percentage change from previous row' },
                                                                        { id: 'diff_from_prev', desc: 'Absolute difference from previous row' },
                                                                        { id: 'percentile', desc: 'Percentile rank within data set' }
                                                                    ] as { id: TableCalculation; desc: string }[]).map(({ id: calc, desc }) => {
                                                                        const isSelected = (formatting.tableCalculations || []).includes(calc);
                                                                        return (
                                                                            <label key={calc} className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? 'bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-slate-50 dark:hover:bg-white/5 border border-transparent hover:border-slate-200'}`}>
                                                                                <input type="checkbox" checked={isSelected} onChange={() => { const current = formatting.tableCalculations || []; const updated = isSelected ? current.filter(c => c !== calc) : [...current, calc]; updateFormatting({ ...formatting, tableCalculations: updated }); }} className="rounded text-emerald-600 focus:ring-emerald-500" />
                                                                                <div className="flex-1 min-w-0">
                                                                                    <span className="text-xs font-bold text-slate-700 dark:text-white leading-tight block">{getCalculationDisplayName(calc)}</span>
                                                                                    <span className="text-[10px] text-slate-500 leading-tight">{desc}</span>
                                                                                </div>
                                                                            </label>
                                                                        );
                                                                    })}
                                                                </div>
                                                                {(formatting.tableCalculations || []).length > 0 && (
                                                                    <button onClick={() => updateFormatting({ ...formatting, tableCalculations: [] })} className="mt-1 text-[11px] text-slate-400 hover:text-red-500 transition-colors cursor-pointer">Clear all calculations</button>
                                                                )}
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
                                                        <tr className="border-b border-white/10">
                                                            {analysisResult.data.length > 0 && Object.keys(analysisResult.data[0]).map(col => (
                                                                <th key={col} className="text-left text-slate-400 font-bold text-xs uppercase tracking-wider px-3 py-2 bg-slate-700/30 sticky top-0">
                                                                    {col}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {analysisResult.data.map((row: any, i: number) => (
                                                            <tr key={i} className="border-b border-white/5 hover:bg-slate-700/20 transition-colors">
                                                                {Object.values(row).map((val: any, j: number) => (
                                                                    <td key={j} className="px-3 py-2 text-white font-mono text-xs">
                                                                        {typeof val === 'number'
                                                                            ? val.toLocaleString(undefined, { maximumFractionDigits: 2 })
                                                                            : String(val ?? '')}
                                                                    </td>
                                                                ))}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                                <div className="text-xs text-slate-500 mt-3 text-center">
                                                    {analysisResult.data.length} rows
                                                </div>
                                            </div>
                                        )}

                                        {/* SQL Tab */}
                                        {activeResultTab === 'sql' && (
                                            <div className="h-full overflow-auto p-4">
                                                <div className="bg-slate-900 rounded-lg p-4 border border-white/5">
                                                    <div className="flex items-center justify-between mb-3">
                                                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Generated SQL</span>
                                                        <button
                                                            onClick={() => navigator.clipboard.writeText(analysisResult.sql || '')}
                                                            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                                                        >
                                                            Copy
                                                        </button>
                                                    </div>
                                                    <pre className="text-sm text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed">
                                                        {analysisResult.sql || 'No SQL generated for this query.'}
                                                    </pre>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="flex-1 h-full flex items-center justify-center text-slate-500">
                                        <div className="flex flex-col items-center gap-2">
                                            <div className="w-12 h-12 rounded-full bg-slate-700/50 flex items-center justify-center">
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
