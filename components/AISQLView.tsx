import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Play, AlertTriangle, X, Loader2, Lock, Clock, Shield, ShieldCheck, LayoutDashboard, Table2, Target } from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { MODEL_LADDER_LABEL } from '../services/ai-sql/modelConfig';
import {
    getPrivacyMode, setPrivacyMode, PrivacyMode,
    hasEnhancedConsent, grantEnhancedConsent, revokeEnhancedConsent,
} from '../services/ai-sql/privacyMode';
import { buildPrivacyDisclosure } from '../services/ai-sql/privacyDisclosure';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { PrivacyConsentDialog } from './PrivacyConsentDialog';
import {
    getSelection, setSelection, applySelection, countSharedValues,
    type PrivacySelection, EMPTY_SELECTION,
} from '../services/ai-sql/privacySelection';
import { collectSafeDomains } from '../services/ai-sql/schemaSerializer';
import { Tooltip } from './Tooltip';
import { checkAiSqlLimit, formatResetTime, AI_SQL_LIMITS } from '../services/aiSqlRateLimiter';
import { useAuthStore } from '../store/useAuthStore';
import { buildFocusedQuestionSuggestion, buildQuestionExamples, detectBroadScopeQuestion } from '../services/ai-sql/scopeIntent';

interface AISQLViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
    initialQuery?: string | null;
    onViewFullPage?: (result: AnalysisResult, pipelineResult: AISQLPipelineResult, query: string, formatting: FormattingConfig) => void;
    onOpenDatasetOverview?: () => void;
    onOpenAllRecords?: () => void;
}

export const AISQLView: React.FC<AISQLViewProps> = ({
    dataset, onPin, initialQuery, onViewFullPage, onOpenDatasetOverview, onOpenAllRecords,
}) => {
    const [query, setQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorTitle, setErrorTitle] = useState('Query could not be completed');
    const inputRef = React.useRef<HTMLTextAreaElement>(null);
    const errorRef = React.useRef<HTMLDivElement>(null);
    const [noDataMsg, setNoDataMsg] = useState<string | null>(null);
    const [noDataSQL, setNoDataSQL] = useState<string | null>(null);
    const [scopeClarification, setScopeClarification] = useState<string | null>(null);
    const [clarificationMessage, setClarificationMessage] = useState<string | null>(null);

    // ── AI SQL Privacy Mode ──
    // "Better answers" sends values from the user's data, so it is gated on
    // explicit consent. The stored preference alone is not permission: until
    // the user has agreed to the disclosure, the effective mode is strict.
    const [privacyMode, setPrivacyModeState] = useState<PrivacyMode>(getPrivacyMode());
    const [consented, setConsented] = useState<boolean>(hasEnhancedConsent());
    const [consentDialog, setConsentDialog] = useState<null | 'consent' | 'review'>(null);
    const datasetKey = dataset?.name || dataset?.id || '';
    const [selection, setSelectionState] = useState<PrivacySelection>(EMPTY_SELECTION);
    useEffect(() => { setSelectionState(datasetKey ? getSelection(datasetKey) : EMPTY_SELECTION); }, [datasetKey]);

    // Better answers is only genuinely on when it has been agreed to.
    const enhancedActive = privacyMode === 'enhanced' && consented;

    React.useEffect(() => {
        if (error) errorRef.current?.focus();
    }, [error]);

    // Built only while the dialog is open — profiling the dataset is not free,
    // and this is exactly the data the user is being asked to consent to.
    const disclosure = useMemo(() => {
        if (!consentDialog || !dataset?.rows?.length) return null;
        try {
            return buildPrivacyDisclosure(dataset.rows, resolveAISQLSemanticModel(dataset).model);
        } catch (e) {
            console.warn('[Privacy] Could not build disclosure:', e);
            return null;
        }
    }, [consentDialog, dataset]);

    // Same source as the pipeline, so the header line cannot disagree with it.
    const sharingSummary = useMemo(() => {
        if (!enhancedActive || !dataset?.rows?.length) return { values: 0, columns: 0 };
        try {
            const domains = collectSafeDomains(dataset.rows, resolveAISQLSemanticModel(dataset).model);
            const kept = applySelection(domains, selection);
            return { values: countSharedValues(domains, selection), columns: kept.size };
        } catch {
            return { values: 0, columns: 0 };
        }
    }, [enhancedActive, dataset, selection]);

    const togglePrivacyMode = () => {
        if (enhancedActive) {
            // Already on and agreed — open it read-only so they can review or revoke.
            setConsentDialog('review');
            return;
        }
        // Turning it on always asks first, and asks again if the disclosure changed.
        setConsentDialog('consent');
    };

    const acceptEnhanced = (chosen: PrivacySelection) => {
        if (datasetKey) setSelection(datasetKey, chosen);
        setSelectionState(chosen);
        grantEnhancedConsent();
        setPrivacyMode('enhanced');
        setConsented(true);
        setPrivacyModeState('enhanced');
        setConsentDialog(null);
    };

    const declineEnhanced = () => {
        revokeEnhancedConsent();
        setPrivacyMode('strict');
        setConsented(false);
        setPrivacyModeState('strict');
        setConsentDialog(null);
    };

    // Every question is answered STANDALONE — no conversation history is kept or
    // sent, so an answer can never inherit context from a previous question.

    // Rate limiting
    const currentUser = useAuthStore(s => s.currentUser);
    const incrementAiSqlUsage = useAuthStore(s => s.incrementAiSqlUsage);
    const limitStatus = checkAiSqlLimit(currentUser);

    const defaultFormatting: FormattingConfig = {
        colorMode: 'vibrant',
        numberFormat: 'auto',
        fontSize: 'md',
        headerSize: 'xl',
        headerBold: true,
        headerColor: '#000000',
        showLabels: true,
        showDataLabels: true,
        tableCalculations: [],
        showAxis: true,
        showXAxis: true,
        showYAxis: true,
        axisColor: '#000000',
        axisBold: true,
        axisLabelSize: 'md',
        dataLabelColor: '#000000',
        dataLabelBold: true,
        dataLabelSize: 'md'
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

    const examples = useMemo(() => dataset ? buildQuestionExamples(dataset) : [], [dataset]);
    const exampleQuestion = examples[0] || 'Show total sales by category';

    const chartTypeMap: Record<string, string> = {
        kpiCard: 'kpiCard', line: 'line', bar: 'bar', horizontalBar: 'horizontalBar',
        groupedBar: 'groupedBar', stackedBar: 'stackedBar', area: 'area',
        dualAxisCombo: 'combo', multiLine: 'line', donut: 'doughnut', pie: 'pie', heatmap: 'heatmap', table: 'table',
    };

    const handleSubmit = async () => {
        if (!query.trim() || !dataset || isLoading) return;

        // A dataset-wide request is not one well-defined SQL answer. Resolve it
        // locally before rate limiting or model invocation so non-technical
        // users choose the result they actually intended without spending AI
        // tokens on a guess.
        const scope = detectBroadScopeQuestion(query);
        if (scope.needsClarification) {
            setScopeClarification(scope.reason || 'Please choose the kind of result you want.');
            setClarificationMessage(null);
            setError(null);
            setNoDataMsg(null);
            setNoDataSQL(null);
            return;
        }

        // ── Rate limit check ──
        const currentStatus = checkAiSqlLimit(currentUser);
        if (!currentStatus.allowed) {
            setErrorTitle('AI SQL unavailable');
            if (currentStatus.blocked) {
                setError('Your account role does not have access to AI SQL.');
            } else {
                setError(`You've used all ${currentStatus.limit} AI SQL queries. Your limit resets in ${formatResetTime(currentStatus.resetsInMs)}.`);
            }
            return;
        }

        setIsLoading(true);
        setError(null);
        setScopeClarification(null);
        setClarificationMessage(null);
        setErrorTitle('Query could not be completed');
        setNoDataMsg(null);
        setNoDataSQL(null);

        try {
            const timeoutMs = 60000;
            const result = await Promise.race([
                runAISQLPipeline(query, dataset),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timed out after 60 seconds. Please try again.')), timeoutMs))
            ]);

            // Fail closed: a query that executed but failed its answer contract
            // must not navigate to the visual result as though it were verified.
            if (result.displaySafety?.allowed === false) {
                const reasons = result.displaySafety.reasons.length > 0
                    ? ` ${result.displaySafety.reasons.join(' ')}`
                    : '';
                const recovery = result.displaySafety.recoverySuggestions.length > 0
                    ? ` Try: ${result.displaySafety.recoverySuggestions.join(' ')}`
                    : ' Please retry or review the SQL before using this answer.';
                setErrorTitle('Answer withheld for your protection');
                setError(`The calculation was withheld because verification failed.${reasons}${recovery}`);
                setNoDataSQL(result.sql || null);
                return;
            }

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

            // Presentation defaults follow the recommended visual instead of
            // applying one label threshold to every chart. Ranked horizontal
            // bars can comfortably show more labels; dense/multi-series charts
            // remain uncluttered by default.
            const labelLimit = result.chart.chartType === 'horizontalBar' ? 15 : 8;
            const showRecommendedLabels = result.chart.chartType !== 'table'
                && result.chart.chartType !== 'heatmap'
                && result.chartData.length <= labelLimit;
            const fmt: FormattingConfig = {
                ...defaultFormatting,
                numberFormat: detectedFormat,
                showDataLabels: showRecommendedLabels,
                dataLabelMode: showRecommendedLabels ? 'all' : 'off',
                axisLabelSize: result.chart.chartType === 'horizontalBar' ? 'sm' : defaultFormatting.axisLabelSize,
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
                visualizationMode: result.chart.chartType === 'table' ? 'grid' : 'auto',
            };

            // Navigate to Visual Preview immediately
            if (onViewFullPage) {
                onViewFullPage(finalResult, result, query, fmt);
            }

            // ── Increment usage AFTER successful query ──
            incrementAiSqlUsage();

        } catch (err: any) {
            console.error('[AI SQL Pipeline] Error:', err);
            const message = err.message || 'An unexpected error occurred.';
            if (err?.kind === 'clarification_required') {
                setClarificationMessage(message);
                setError(null);
                return;
            } else if (/timed out|timeout/i.test(message)) setErrorTitle('Query timed out');
            else if (/network|failed to fetch|connect|offline/i.test(message)) setErrorTitle('Connection problem');
            else setErrorTitle('Query could not be completed');
            setError(message);
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
        <div className="qi-ai-workspace flex flex-col h-full bg-slate-50 dark:bg-[#07111f] p-6 overflow-hidden">
            <div className="qi-ai-frame max-w-3xl mx-auto w-full flex flex-col h-full gap-5">

                {/* Header */}
                <div className="flex flex-col gap-1 shrink-0">
                    <Tooltip text="Ask a focused question. QuickInsight builds a local semantic plan and a deterministic, read-only query first. If a question needs escalation, it uses the appropriate GPT-5.6 route and clearly shows that in the result." position="right">
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
                            <img src="/ai-sql-logo.png" alt="AI SQL" className="w-7 h-7 rounded-lg object-cover" />
                            AI SQL
                            <span className="text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/20">
                                Private, governed analytics
                            </span>
                            <span className="text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                {MODEL_LADDER_LABEL}
                            </span>
                        </h2>
                    </Tooltip>
                    <div className="flex items-center gap-2">
                        <p className="text-gray-500 dark:text-slate-400 text-sm flex-1">
                            Ask a focused question about a metric, category, comparison, or time period. QuickInsight calculates supported answers locally, validates every read-only query, and chooses a suitable visual or data table.
                            Broad requests such as “summarize everything” are clarified first. Each answer shows its calculation path; questions are independent, with no conversational memory.
                        </p>
                        <Tooltip
                            position="left"
                            text={!enhancedActive
                                ? "Private mode: AI SQL uses your question, query text and schema information without sharing category catalogues or dataset rows. Text you type can include values. Tap to review what Better answers would additionally share."
                                : "Better answers: AI SQL can additionally see selected category values, such as products or regions. Automated checks exclude likely personal and sensitive fields. Tap to review the exact selection or turn sharing off."}
                        >
                            <button
                                onClick={togglePrivacyMode}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${!enhancedActive
                                    ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30'
                                    : 'bg-cyan-50 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/30'}`}
                                title="See exactly what the AI is sent, and choose"
                            >
                                {!enhancedActive ? <ShieldCheck className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
                                {!enhancedActive ? 'Private mode' : 'Better answers'}
                            </button>
                        </Tooltip>
                    </div>
                </div>

                {/* Dataset-wide requests need an output choice, not a guessed SQL query. */}
                {scopeClarification && !isLoading && (
                    <div role="dialog" aria-labelledby="scope-clarification-title" className="shrink-0 rounded-xl border border-violet-200 bg-violet-50 p-5 dark:border-violet-500/30 dark:bg-violet-500/10">
                        <div className="flex items-start gap-3">
                            <Target className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                                <div id="scope-clarification-title" className="font-bold text-violet-900 dark:text-violet-200">What kind of complete view do you need?</div>
                                <p className="mt-1 text-sm leading-relaxed text-violet-700 dark:text-violet-200/80">{scopeClarification}</p>
                                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                                    <button type="button" onClick={() => { setScopeClarification(null); onOpenDatasetOverview?.(); }} className="rounded-xl border border-violet-300 bg-white p-3 text-left transition hover:border-violet-500 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-slate-900/60 dark:hover:bg-violet-500/15">
                                        <span className="flex items-center gap-2 font-semibold text-violet-900 dark:text-violet-100"><LayoutDashboard className="h-4 w-4" /> Dataset overview</span>
                                        <span className="mt-1 block text-xs text-violet-600 dark:text-violet-300/80">Recommended · tables, fields, quality, and coverage</span>
                                    </button>
                                    <button type="button" onClick={() => { setScopeClarification(null); onOpenAllRecords?.(); }} className="rounded-xl border border-violet-300 bg-white p-3 text-left transition hover:border-violet-500 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-slate-900/60 dark:hover:bg-violet-500/15">
                                        <span className="flex items-center gap-2 font-semibold text-violet-900 dark:text-violet-100"><Table2 className="h-4 w-4" /> Browse records</span>
                                        <span className="mt-1 block text-xs text-violet-600 dark:text-violet-300/80">Open the current table with all available columns</span>
                                    </button>
                                    <button type="button" onClick={() => { setQuery(buildFocusedQuestionSuggestion(dataset)); setScopeClarification(null); requestAnimationFrame(() => inputRef.current?.focus()); }} className="rounded-xl border border-violet-300 bg-white p-3 text-left transition hover:border-violet-500 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-slate-900/60 dark:hover:bg-violet-500/15">
                                        <span className="flex items-center gap-2 font-semibold text-violet-900 dark:text-violet-100"><Sparkles className="h-4 w-4" /> Focus the analysis</span>
                                        <span className="mt-1 block text-xs text-violet-600 dark:text-violet-300/80">Start from a dataset-specific example you can edit</span>
                                    </button>
                                </div>
                            </div>
                            <button aria-label="Dismiss clarification" onClick={() => { setScopeClarification(null); inputRef.current?.focus(); }} className="shrink-0 text-violet-400 hover:text-violet-700 dark:hover:text-violet-200"><X className="h-4 w-4" /></button>
                        </div>
                    </div>
                )}

                {clarificationMessage && !isLoading && (
                    <div role="status" aria-live="polite" className="shrink-0 rounded-xl border border-violet-200 bg-violet-50 p-5 text-sm dark:border-violet-500/30 dark:bg-violet-500/10">
                        <div className="flex items-start gap-3">
                            <Target className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                            <div className="flex-1">
                                <div className="font-bold text-violet-900 dark:text-violet-200">One detail is needed before calculating</div>
                                <p className="mt-1 leading-relaxed text-violet-700 dark:text-violet-200/80">{clarificationMessage}</p>
                                <button type="button" onClick={() => { setClarificationMessage(null); inputRef.current?.focus(); }} className="mt-3 rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-500">Edit question</button>
                            </div>
                            <button aria-label="Dismiss clarification" onClick={() => setClarificationMessage(null)} className="shrink-0 text-violet-400 hover:text-violet-700 dark:hover:text-violet-200"><X className="h-4 w-4" /></button>
                        </div>
                    </div>
                )}

                {/* Always visible: what the AI is being sent from this file, and a way in. */}
                {dataset && (
                    <button
                        onClick={() => setConsentDialog(enhancedActive ? 'review' : 'consent')}
                        className="mt-2 inline-flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200 transition-colors group"
                    >
                        {enhancedActive ? (
                            <Shield className="w-3.5 h-3.5 text-cyan-500" />
                        ) : (
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                        )}
                        <span>
                            If an AI fallback is needed, it receives:{' '}
                            <span className="font-semibold text-gray-700 dark:text-slate-200">
                                {enhancedActive
                                    ? sharingSummary.values === 0
                                        ? 'column names only'
                                        : `column names + ${sharingSummary.values} value${sharingSummary.values === 1 ? '' : 's'} from ${sharingSummary.columns} column${sharingSummary.columns === 1 ? '' : 's'}`
                                    : 'column names only — no data values or rows'}
                            </span>
                        </span>
                        <span className="underline decoration-dotted underline-offset-2 group-hover:decoration-solid">
                            {enhancedActive ? 'Choose what to share' : 'See what could be shared'}
                        </span>
                    </button>
                )}

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
                            — local-first answers, visible calculation paths, and a controlled GPT‑5.6 fallback only when needed.
                        </span>
                    </div>
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-300/40 dark:border-indigo-500/30">
                        Beta
                    </span>
                </div>

                {/* Text Input */}
                <div className="relative group shrink-0">
                    <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/30 to-blue-500/30 rounded-2xl blur-lg opacity-0 group-hover:opacity-40 transition-opacity pointer-events-none" />
                    <div className={`relative bg-white dark:bg-slate-800 border-2 rounded-2xl shadow-lg dark:shadow-2xl transition-all duration-300 ${query.trim() ? 'border-cyan-400/50 dark:border-cyan-500/40' : 'border-gray-200 dark:border-white/10 hover:border-cyan-400/30 dark:hover:border-cyan-500/30'}`}>
                        <textarea
                            ref={inputRef}
                            aria-label="Ask a question about your data"
                            aria-describedby="ai-sql-input-help"
                            className="w-full bg-transparent border-none outline-none text-gray-900 dark:text-white px-5 pt-4 pb-2 placeholder:text-gray-400 dark:placeholder:text-slate-500 font-medium resize-none min-h-[56px] max-h-[160px]"
                            placeholder={`Ask about a metric, comparison, trend, or ranking... e.g. "${exampleQuestion}"`}
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
                            <div id="ai-sql-input-help" className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500">
                                <img src="/ai-sql-logo.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
                                <span>AI reasoning → validate → local DuckDB → visualise &middot; Press <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-[10px] font-mono border border-gray-200 dark:border-white/10">Enter</kbd> to send</span>
                            </div>
                            <button
                                onClick={handleSubmit}
                                disabled={!query.trim() || isLoading || (!limitStatus.allowed && !limitStatus.blocked)}
                                className="bg-cyan-600 hover:bg-cyan-500 text-white px-5 py-2 rounded-xl font-bold flex items-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-md hover:shadow-lg active:scale-95"
                            >
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : !limitStatus.allowed ? <Lock className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                                {isLoading ? 'Generating...' : !limitStatus.allowed ? 'Limit Reached' : 'Send'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Loading State */}
                {isLoading && (
                    <div className="flex-1 flex flex-col items-center justify-center" role="status" aria-live="polite" aria-label="Building and validating your analysis">
                        <div className="relative mb-6">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center">
                                <Sparkles className="w-8 h-8 text-cyan-400 animate-pulse" />
                            </div>
                            <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-400 animate-ping" />
                        </div>
                        <div className="flex items-center gap-3 text-gray-500 dark:text-slate-400 text-sm">
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                            <span>Building and validating your local analysis...</span>
                        </div>
                        <div className="mt-4 flex gap-2">
                            <div className="w-2 h-2 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-2 h-2 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-2 h-2 rounded-full bg-cyan-400/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                    </div>
                )}

                {/* No-data explanation banner */}
                {noDataMsg && !isLoading && (
                    <div role="status" aria-live="polite" className="bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-300 dark:border-cyan-500/40 rounded-xl p-5 flex items-start gap-4">
                        <div className="w-9 h-9 rounded-xl bg-cyan-100 dark:bg-cyan-500/20 flex items-center justify-center shrink-0">
                            <AlertTriangle className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                        </div>
                        <div className="flex-1">
                            <div className="font-bold text-cyan-800 dark:text-cyan-300 mb-1 text-sm">No data found for this query</div>
                            <p className="text-sm text-cyan-700 dark:text-cyan-200/80 leading-relaxed">{noDataMsg}</p>
                            {noDataSQL && (
                                <pre className="mt-3 text-[11px] text-emerald-700 dark:text-emerald-300 font-mono bg-white/60 dark:bg-slate-900/60 rounded-lg p-3 border border-cyan-200 dark:border-white/5 overflow-x-auto">{noDataSQL}</pre>
                            )}
                        </div>
                        <button aria-label="Dismiss no-data message" onClick={() => { setNoDataMsg(null); setNoDataSQL(null); inputRef.current?.focus(); }} className="text-cyan-600 dark:text-cyan-400 hover:text-cyan-800 dark:hover:text-cyan-200 shrink-0"><X className="w-4 h-4" /></button>
                    </div>
                )}

                {/* Rate Limit Reached Banner */}
                {!limitStatus.allowed && !limitStatus.blocked && !isLoading && (
                    <div className="shrink-0 bg-gradient-to-r from-red-500/10 via-cyan-500/10 to-blue-500/10 dark:from-red-500/15 dark:via-cyan-500/15 dark:to-blue-500/15 border border-red-300/60 dark:border-red-500/30 rounded-xl px-5 py-4 flex items-start gap-4">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-100 to-cyan-100 dark:from-red-500/20 dark:to-cyan-500/20 flex items-center justify-center shrink-0">
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
                                    <div className="h-full bg-gradient-to-r from-red-500 to-cyan-500 rounded-full" style={{ width: '100%' }} />
                                </div>
                                <span className="text-[10px] font-bold text-red-600 dark:text-red-400">{limitStatus.used}/{limitStatus.limit}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Error */}
                {error && !isLoading && (
                    <div
                        ref={errorRef}
                        role="alert"
                        aria-live="assertive"
                        tabIndex={-1}
                        className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-5 flex items-start gap-3 text-red-700 dark:text-red-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                    >
                        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                        <div className="flex-1">
                            <div className="font-bold mb-1">{errorTitle}</div>
                            <p className="leading-relaxed">{error}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => { setError(null); inputRef.current?.focus(); }}
                                    className="px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-500/40 font-semibold hover:bg-red-100 dark:hover:bg-red-500/15"
                                >
                                    Edit question
                                </button>
                                {errorTitle !== 'AI SQL unavailable' && (
                                    <button
                                        type="button"
                                        onClick={() => { setError(null); handleSubmit(); }}
                                        className="px-3 py-1.5 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-500"
                                    >
                                        Try again
                                    </button>
                                )}
                            </div>
                        </div>
                        <button aria-label="Dismiss error" onClick={() => { setError(null); inputRef.current?.focus(); }} className="text-red-400 hover:text-red-600 dark:hover:text-red-200 shrink-0"><X className="w-4 h-4" /></button>
                    </div>
                )}


                {/* Example Suggestions */}
                {!isLoading && !error && !noDataMsg && !scopeClarification && !clarificationMessage && (
                    <div className="flex-1 flex flex-col items-center justify-center">
                        <div className="mb-5 max-w-2xl rounded-xl border border-cyan-200/70 bg-cyan-50/70 px-5 py-3 text-center dark:border-cyan-500/20 dark:bg-cyan-500/[0.07]">
                            <p className="text-xs font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">A useful question usually includes</p>
                            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                                what to measure <span className="text-gray-400">+</span> how to split or compare it <span className="text-gray-400">+</span> an optional time period or filter
                            </p>
                            <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">These are helpful patterns, not restrictions. You can still type any question supported by this dataset.</p>
                        </div>
                        <p className="mb-4 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Examples from your columns</p>
                        <div className="flex flex-wrap justify-center gap-3 max-w-2xl">
                            {examples.map((ex, i) => (
                                <button
                                    key={i}
                                    onClick={() => setQuery(ex)}
                                    className="px-4 py-2 rounded-full border border-gray-200 dark:border-white/10 hover:border-cyan-500/50 hover:bg-cyan-500/10 text-gray-600 dark:text-slate-300 text-sm transition-all"
                                >
                                    {ex}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            <PrivacyConsentDialog
                open={consentDialog !== null}
                mode={consentDialog ?? 'consent'}
                disclosure={disclosure}
                selection={selection}
                onAgree={acceptEnhanced}
                onDecline={declineEnhanced}
                onClose={() => setConsentDialog(null)}
            />
        </div>
    );
};
