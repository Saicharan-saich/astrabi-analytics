import React, { useState } from 'react';
import { Sparkles, Play, AlertTriangle, X, Loader2, Lock, Clock } from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { MODEL } from '../services/ai-sql/intentPlanner';
import { Tooltip } from './Tooltip';
import { checkAiSqlLimit, formatResetTime, AI_SQL_LIMITS } from '../services/aiSqlRateLimiter';
import { useAuthStore } from '../store/useAuthStore';

interface AISQLViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
    initialQuery?: string | null;
    onViewFullPage?: (result: AnalysisResult, pipelineResult: AISQLPipelineResult, query: string, formatting: FormattingConfig) => void;
}

export const AISQLView: React.FC<AISQLViewProps> = ({ dataset, onPin, initialQuery, onViewFullPage }) => {
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [noDataMsg, setNoDataMsg] = useState<string | null>(null);
    const [noDataSQL, setNoDataSQL] = useState<string | null>(null);

    // Rate limiting
    const currentUser = useAuthStore(s => s.currentUser);
    const incrementAiSqlUsage = useAuthStore(s => s.incrementAiSqlUsage);
    const limitStatus = checkAiSqlLimit(currentUser);

    const defaultFormatting: FormattingConfig = {
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
    };

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

    const examples = [
        "Total revenue by category",
        "Top 10 products by profit",
        "Monthly sales trend",
        "Average order value by region",
        "Count of orders this year",
        "Revenue breakdown by segment"
    ];

    const chartTypeMap: Record<string, string> = {
        kpiCard: 'kpiCard', line: 'line', bar: 'bar', horizontalBar: 'horizontalBar',
        groupedBar: 'groupedBar', stackedBar: 'stackedBar', area: 'area',
        dualAxisCombo: 'comboChart', multiLine: 'line', donut: 'donut', heatmap: 'heatmap', table: 'table',
    };

    const handleSubmit = async () => {
        if (!query.trim() || !dataset || isLoading) return;

        // ── Rate limit check ──
        const currentStatus = checkAiSqlLimit(currentUser);
        if (!currentStatus.allowed) {
            if (currentStatus.blocked) {
                setError('Your account role does not have access to AI SQL.');
            } else {
                setError(`You've used all ${currentStatus.limit} AI SQL queries. Your limit resets in ${formatResetTime(currentStatus.resetsInMs)}.`);
            }
            return;
        }

        setIsLoading(true);
        setError(null);
        setNoDataMsg(null);
        setNoDataSQL(null);

        try {
            const timeoutMs = 60000;
            const result = await Promise.race([
                runAISQLPipeline(query, dataset),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timed out after 60 seconds. Please try again.')), timeoutMs))
            ]);

            // Empty-result handling — show banner, don't navigate
            if (result.rawData.length === 0 && result.explanation) {
                setNoDataMsg(result.explanation);
                setNoDataSQL(result.sql);
                setIsLoading(false);
                return;
            }

            // Auto-detect axis format
            const axisFormatMap: Record<string, FormattingConfig['numberFormat']> = {
                percent: 'percent', currency_usd: 'currency_usd', compact: 'compact',
            };
            const detectedFormat = result.chart.leftAxisFormat
                ? (axisFormatMap[result.chart.leftAxisFormat] ?? 'auto') : 'auto';

            const fmt: FormattingConfig = {
                ...defaultFormatting,
                numberFormat: detectedFormat,
                showDataLabels: result.chartData.length <= 8,
            };

            // Build the analysis result
            const finalResult: AnalysisResult = {
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
                    limit: result.plan.limit || 0,
                    sort: result.plan.sort?.[0]?.dir || 'desc',
                },
                vis: (chartTypeMap[result.chart.chartType] || 'bar') as any,
                kpi: result.chart.chartType === 'kpiCard' && result.chartData.length > 0
                    ? result.chartData[0][result.chart.yKey] : undefined,
                growth: result.chart.growth
                    ? { diff: result.chart.growth.diff, pct: result.chart.growth.pct } : undefined,
                secondaryYKeys: result.chart.secondaryYKeys,
            };

            // Navigate to Visual Preview immediately
            if (onViewFullPage) {
                onViewFullPage(finalResult, result, query, fmt);
            }

            // ── Increment usage AFTER successful query ──
            incrementAiSqlUsage();

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
    }, [query, dataset, isLoading]);

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
            <div className="max-w-3xl mx-auto w-full flex flex-col h-full gap-5">

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
                    <p className="text-gray-500 dark:text-slate-400 text-sm">
                        Ask any question about your data — AI generates SQL, executes it, and takes you to a full visual result.
                    </p>
                </div>

                {/* Usage Badge — only for limited roles */}
                {!limitStatus.blocked && limitStatus.limit !== Infinity && (
                    <div className="shrink-0 flex items-center gap-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5">
                        <div className="relative w-9 h-9">
                            <svg className="w-9 h-9 -rotate-90" viewBox="0 0 36 36">
                                <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" className="text-gray-100 dark:text-slate-700" strokeWidth="3" />
                                <circle cx="18" cy="18" r="15" fill="none"
                                    stroke={limitStatus.remaining > 3 ? '#22c55e' : limitStatus.remaining > 0 ? '#f59e0b' : '#ef4444'}
                                    strokeWidth="3" strokeLinecap="round"
                                    strokeDasharray={`${(limitStatus.used / limitStatus.limit) * 94.2} 94.2`}
                                />
                            </svg>
                            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-gray-700 dark:text-slate-200">
                                {limitStatus.remaining}
                            </span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-sm font-semibold text-gray-800 dark:text-white">
                                {limitStatus.used}/{limitStatus.limit} queries used
                            </span>
                            <span className="text-xs text-gray-400 dark:text-slate-500 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                Resets in {formatResetTime(limitStatus.resetsInMs)}
                            </span>
                        </div>
                    </div>
                )}

                {/* Early Access Banner */}
                <div className="shrink-0 bg-gradient-to-r from-indigo-500/10 via-purple-500/10 to-pink-500/10 dark:from-indigo-500/15 dark:via-purple-500/15 dark:to-pink-500/15 border border-indigo-200/60 dark:border-indigo-500/20 rounded-xl px-4 py-2.5 flex items-center gap-3">
                    <span className="text-lg shrink-0">🚀</span>
                    <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-semibold text-indigo-700 dark:text-indigo-300">
                            Early Access Preview
                        </span>
                        <span className="text-[12px] text-indigo-600/70 dark:text-indigo-400/70 ml-1.5">
                            — AI-powered analytics is actively evolving. Results improve continuously as the engine learns your data patterns.
                        </span>
                    </div>
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-300/40 dark:border-indigo-500/30">
                        Beta
                    </span>
                </div>

                {/* Text Input */}
                <div className="relative group shrink-0">
                    <div className="absolute inset-0 bg-gradient-to-r from-amber-500/30 to-orange-500/30 rounded-2xl blur-lg opacity-0 group-hover:opacity-40 transition-opacity pointer-events-none" />
                    <div className={`relative bg-white dark:bg-slate-800 border-2 rounded-2xl shadow-lg dark:shadow-2xl transition-all duration-300 ${query.trim() ? 'border-amber-400/50 dark:border-amber-500/40' : 'border-gray-200 dark:border-white/10 hover:border-amber-400/30 dark:hover:border-amber-500/30'}`}>
                        <textarea
                            className="w-full bg-transparent border-none outline-none text-gray-900 dark:text-white px-5 pt-4 pb-2 placeholder:text-gray-400 dark:placeholder:text-slate-500 font-medium resize-none min-h-[56px] max-h-[160px]"
                            placeholder='Ask a question about your data... e.g. "Show top 10 products by total revenue"'
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
                                disabled={!query.trim() || isLoading || (!limitStatus.allowed && !limitStatus.blocked)}
                                className="bg-amber-600 hover:bg-amber-500 text-white px-5 py-2 rounded-xl font-bold flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-md hover:shadow-lg active:scale-95"
                            >
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : !limitStatus.allowed ? <Lock className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                                {isLoading ? 'Generating...' : !limitStatus.allowed ? 'Limit Reached' : 'Send'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Loading State */}
                {isLoading && (
                    <div className="flex-1 flex flex-col items-center justify-center">
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

                {/* No-data explanation banner */}
                {noDataMsg && !isLoading && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-500/40 rounded-xl p-5 flex items-start gap-4">
                        <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
                            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1">
                            <div className="font-bold text-amber-800 dark:text-amber-300 mb-1 text-sm">No data found for this query</div>
                            <p className="text-sm text-amber-700 dark:text-amber-200/80 leading-relaxed">{noDataMsg}</p>
                            {noDataSQL && (
                                <pre className="mt-3 text-[11px] text-emerald-700 dark:text-emerald-300 font-mono bg-white/60 dark:bg-slate-900/60 rounded-lg p-3 border border-amber-200 dark:border-white/5 overflow-x-auto">{noDataSQL}</pre>
                            )}
                        </div>
                        <button onClick={() => { setNoDataMsg(null); setNoDataSQL(null); }} className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 shrink-0"><X className="w-4 h-4" /></button>
                    </div>
                )}

                {/* Rate Limit Reached Banner */}
                {!limitStatus.allowed && !limitStatus.blocked && !isLoading && (
                    <div className="shrink-0 bg-gradient-to-r from-red-500/10 via-amber-500/10 to-orange-500/10 dark:from-red-500/15 dark:via-amber-500/15 dark:to-orange-500/15 border border-red-300/60 dark:border-red-500/30 rounded-xl px-5 py-4 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-100 to-amber-100 dark:from-red-500/20 dark:to-amber-500/20 flex items-center justify-center shrink-0">
                            <Lock className="w-5 h-5 text-red-600 dark:text-red-400" />
                        </div>
                        <div className="flex-1">
                            <div className="font-bold text-red-800 dark:text-red-300 mb-1 text-sm">Query Limit Reached</div>
                            <p className="text-sm text-red-700 dark:text-red-200/80 leading-relaxed">
                                You've used all <strong>{limitStatus.limit}</strong> AI SQL queries on your Contributor license.
                                Your limit resets in <strong>{formatResetTime(limitStatus.resetsInMs)}</strong>.
                            </p>
                            <div className="mt-2 flex items-center gap-2">
                                <div className="h-1.5 flex-1 bg-red-200 dark:bg-red-500/20 rounded-full overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-red-500 to-amber-500 rounded-full" style={{ width: '100%' }} />
                                </div>
                                <span className="text-[10px] font-bold text-red-600 dark:text-red-400">{limitStatus.used}/{limitStatus.limit}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Error */}
                {error && !isLoading && (
                    <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-5 flex items-start gap-3 text-red-700 dark:text-red-200 text-sm">
                        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                        <div className="flex-1">
                            <div className="font-bold mb-1">Query Failed</div>
                            {error}
                        </div>
                        <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-200 shrink-0"><X className="w-4 h-4" /></button>
                    </div>
                )}

                {/* Example Suggestions — show when idle */}
                {!isLoading && !error && !noDataMsg && (
                    <div className="flex-1 flex flex-col items-center justify-center opacity-60">
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
        </div>
    );
};
