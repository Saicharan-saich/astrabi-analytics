import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, ArrowRight, CheckCircle2, Database, Info, LayoutDashboard, Loader2, Maximize2,
    MessageSquare, Pin, RotateCcw, Search, Send, Sparkles, TrendingDown, TrendingUp,
} from 'lucide-react';
import type { AnalysisResult, Dataset, FormattingConfig } from '../types';
import { buildAutoReport, cardTitle, type AutoFinding, type AutoReport } from '../services/autoAnalysis';
import { ChartVisualization } from './ChartVisualization';
import { ErrorBoundary } from './ErrorBoundary';

interface QuickInsightsViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult, note?: string) => void;
    onOpenInBuilder?: (config: any) => void;
    /** Route a natural-language follow-up into the AI SQL pipeline. */
    onAskQuestion?: (question: string) => void;
    /** Build a dashboard from this report. */
    onBuildDashboard?: () => void;
    isBuildingDashboard?: boolean;
}

const TONE: Record<AutoFinding['tone'], { label: string; className: string; Icon: any }> = {
    good: { label: 'Good news', className: 'is-good', Icon: TrendingUp },
    bad: { label: 'Needs attention', className: 'is-bad', Icon: TrendingDown },
    attention: { label: 'Worth watching', className: 'is-attention', Icon: AlertTriangle },
    neutral: { label: 'Worth knowing', className: 'is-neutral', Icon: Info },
};

function formattingFor(finding: AutoFinding): FormattingConfig {
    return {
        colorMode: 'vibrant',
        numberFormat: finding.card.numberFormat,
        fontSize: 'md',
        headerSize: 'md',
        headerBold: true,
        showLabels: true,
        showDataLabels: finding.card.showDataLabels,
        dataLabelMode: finding.card.showDataLabels ? 'all' : 'off',
        showAxis: true,
        showXAxis: true,
        showYAxis: true,
        axisLabelSize: 'sm',
        dataLabelSize: 'sm',
        tableCalculations: [],
    } as FormattingConfig;
}

/** The same result a dashboard card uses, so a pinned finding recomputes on refresh. */
function resultFor(finding: AutoFinding): AnalysisResult {
    const { card } = finding;
    return {
        data: card.data,
        xKey: card.xKey,
        yKey: card.yKey,
        yLabel: card.yLabel,
        insight: cardTitle(finding),
        sql: '',
        config: { ...(card.builder || {}), questionLabel: cardTitle(finding) } as any,
        ...(card.builder ? { queryConfig: { ...card.builder, questionLabel: cardTitle(finding) } } : {}),
        vis: card.chartType as any,
        kpi: card.chartType === 'kpiCard' ? card.data[0]?.value : undefined,
        formatting: formattingFor(finding),
        autoAnalysis: finding.spec,
    };
}

const FindingChart: React.FC<{ finding: AutoFinding; height: number }> = ({ finding, height }) => {
    const result = useMemo(() => resultFor(finding), [finding]);
    return (
        <div style={{ height }} className="w-full">
            <ErrorBoundary compact label={finding.title}>
                <ChartVisualization
                    data={result.data}
                    xKey={result.xKey}
                    yKey={result.yKey}
                    yLabel={result.yLabel}
                    config={result.config}
                    chartType={result.vis as any}
                    onChartTypeChange={() => {}}
                    formatting={result.formatting}
                    hideControls
                    disableAutoSeries
                />
            </ErrorBoundary>
        </div>
    );
};

export const QuickInsightsView: React.FC<QuickInsightsViewProps> = ({
    dataset, onPin, onOpenInBuilder, onAskQuestion, onBuildDashboard, isBuildingDashboard,
}) => {
    const [report, setReport] = useState<AutoReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const [questionDraft, setQuestionDraft] = useState('');
    const [runKey, setRunKey] = useState(0);

    useEffect(() => {
        if (!dataset) { setReport(null); return; }
        let cancelled = false;
        setLoading(true);
        setError(null);
        // Yield so the loading state paints before the analysis runs.
        const timer = window.setTimeout(() => {
            const start = performance.now();
            try {
                const next = buildAutoReport(dataset);
                if (!cancelled) setReport(next);
            } catch (err) {
                console.error('[Discover] analysis failed:', err);
                if (!cancelled) { setReport(null); setError('The automatic analysis could not run on this dataset.'); }
            } finally {
                if (!cancelled) { setElapsed((performance.now() - start) / 1000); setLoading(false); }
            }
        }, 30);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [dataset?.id, dataset?.version, dataset?.rows?.length, runKey]);

    const submitQuestion = () => {
        const question = questionDraft.trim();
        if (!question || !onAskQuestion) return;
        onAskQuestion(question);
        setQuestionDraft('');
    };

    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 qi-report-muted">
                <Database className="w-12 h-12" />
                <h3 className="text-lg font-semibold qi-report-heading">No dataset loaded</h3>
                <p className="text-sm">Upload a dataset to get an automatic analysis.</p>
            </div>
        );
    }

    const findings = report?.findings || [];
    const full = findings.filter(f => f.card.width === 'full');
    const attentionCount = findings.filter(f => f.tone === 'bad' || f.tone === 'attention').length;

    return (
        <div className="qi-report flex flex-col h-full overflow-y-auto">
            <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
                {/* ── Header ── */}
                <header className="flex flex-wrap items-start justify-between gap-4 mb-5">
                    <div className="min-w-0">
                        <h2 className="qi-report-heading text-[22px] font-semibold tracking-tight">Discover</h2>
                        <p className="qi-report-muted text-[13px] mt-0.5">
                            {report ? `${report.scope} · analysed in ${elapsed.toFixed(1)}s` : 'Reading your data…'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setRunKey(k => k + 1)} className="qi-dash-button inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium" disabled={loading}>
                            <RotateCcw className="w-3.5 h-3.5" /> Re-run
                        </button>
                        {onBuildDashboard && (
                            <button onClick={onBuildDashboard} disabled={isBuildingDashboard || !report || findings.length === 0} className="qi-report-primary inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold disabled:opacity-50">
                                {isBuildingDashboard ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LayoutDashboard className="w-3.5 h-3.5" />}
                                {isBuildingDashboard ? 'Building…' : 'Build dashboard from this'}
                            </button>
                        )}
                    </div>
                </header>

                {/* ── Ask ── */}
                <form
                    onSubmit={event => { event.preventDefault(); submitQuestion(); }}
                    className="qi-report-ask mb-6 flex items-center gap-2 rounded-xl px-3 py-1.5"
                >
                    <Search className="w-4 h-4 shrink-0 qi-report-muted" />
                    <input
                        value={questionDraft}
                        onChange={event => setQuestionDraft(event.target.value)}
                        placeholder="Ask a follow-up about this dataset…"
                        className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
                        disabled={!onAskQuestion}
                        aria-label="Ask a follow-up question"
                    />
                    <button type="submit" disabled={!questionDraft.trim() || !onAskQuestion} className="qi-report-primary inline-flex items-center justify-center w-8 h-8 rounded-lg disabled:opacity-40" aria-label="Ask">
                        <Send className="w-3.5 h-3.5" />
                    </button>
                </form>

                {loading && (
                    <div className="flex flex-col items-center justify-center py-24 gap-3 qi-report-muted">
                        <Loader2 className="w-7 h-7 animate-spin" />
                        <p className="text-sm">Analysing trends, drivers and segments…</p>
                    </div>
                )}

                {!loading && error && (
                    <div className="qi-report-card rounded-xl p-6 text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {error}</div>
                )}

                {!loading && report && (
                    <>
                        {/* ── Summary ── */}
                        <section className="qi-report-summary rounded-xl px-5 py-4 mb-6" aria-label="Summary">
                            <div className="flex items-center gap-2 mb-2">
                                <Sparkles className="w-4 h-4 qi-report-accent" />
                                <h3 className="qi-report-heading text-[15px] font-semibold">What the data says</h3>
                                {attentionCount > 0 && <span className="qi-report-chip is-attention ml-auto">{attentionCount} need{attentionCount === 1 ? 's' : ''} attention</span>}
                            </div>
                            <ul className="space-y-1.5">
                                {report.summary.map((sentence, index) => (
                                    <li key={index} className="qi-report-body text-[14px] leading-relaxed flex gap-2">
                                        <span className="qi-report-bullet mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden="true" />
                                        <span>{sentence}</span>
                                    </li>
                                ))}
                            </ul>
                            {report.notes.length > 0 && (
                                <div className="qi-report-notes mt-3 pt-3 text-[12.5px] space-y-1">
                                    {report.notes.map((note, index) => <p key={index} className="flex gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {note}</p>)}
                                </div>
                            )}
                        </section>

                        {/* ── KPIs ── */}
                        {report.kpis.length > 0 && (
                            <div className={`grid gap-4 mb-6 grid-cols-1 sm:grid-cols-2 ${report.kpis.length >= 4 ? 'lg:grid-cols-4' : report.kpis.length === 3 ? 'lg:grid-cols-3' : ''}`}>
                                {report.kpis.map(kpi => (
                                    <div key={kpi.id} className="qi-report-card rounded-xl overflow-hidden group relative">
                                        <FindingChart finding={kpi} height={150} />
                                        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                            {onPin && <button onClick={() => onPin(cardTitle(kpi), resultFor(kpi))} className="qi-dash-icon-button p-1.5" title="Pin to dashboard" aria-label={`Pin ${kpi.title}`}><Pin className="w-3.5 h-3.5" /></button>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* ── Findings ── */}
                        {findings.length > 0 ? (
                            <>
                                <div className="flex items-baseline justify-between mb-3">
                                    <h3 className="qi-report-heading text-[15px] font-semibold">Findings</h3>
                                    <span className="qi-report-muted text-xs">{findings.length} ranked by how much they matter</span>
                                </div>
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                    {findings.map(finding => {
                                        const tone = TONE[finding.tone];
                                        const wide = finding.card.width === 'full' || (full.length === 0 && findings.length === 1);
                                        return (
                                            <article key={finding.id} className={`qi-report-card rounded-xl p-4 flex flex-col ${wide ? 'lg:col-span-2' : ''}`}>
                                                <div className="flex items-center gap-2 mb-1.5">
                                                    <span className={`qi-report-chip ${tone.className}`}><tone.Icon className="w-3 h-3" /> {tone.label}</span>
                                                    <span className="qi-report-muted text-[11.5px] truncate">{cardTitle(finding)}</span>
                                                </div>
                                                <h4 className="qi-report-heading text-[15px] font-semibold leading-snug">{finding.title}</h4>
                                                <p className="qi-report-body text-[13px] leading-relaxed mt-1">{finding.detail}</p>
                                                <div className="mt-3">
                                                    <FindingChart finding={finding} height={wide ? 280 : 240} />
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2 mt-3">
                                                    {onPin && (
                                                        <button onClick={() => onPin(cardTitle(finding), resultFor(finding), finding.title)} className="qi-chip-button inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium">
                                                            <Pin className="w-3.5 h-3.5" /> Pin
                                                        </button>
                                                    )}
                                                    {onOpenInBuilder && finding.card.builder && (
                                                        <button onClick={() => onOpenInBuilder(finding.card.builder)} className="qi-chip-button inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium">
                                                            <Maximize2 className="w-3.5 h-3.5" /> Explore in Builder
                                                        </button>
                                                    )}
                                                    {onAskQuestion && finding.question && (
                                                        <button onClick={() => onAskQuestion(finding.question!)} className="qi-report-link inline-flex items-center gap-1 text-[12px] font-medium ml-auto">
                                                            <MessageSquare className="w-3.5 h-3.5" /> {finding.question} <ArrowRight className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <div className="qi-report-card rounded-xl p-8 text-center">
                                <CheckCircle2 className="w-6 h-6 mx-auto mb-2 qi-report-accent" />
                                <p className="qi-report-heading text-sm font-semibold">No strong patterns stood out</p>
                                <p className="qi-report-muted text-[13px] mt-1">This dataset may need a date or numeric column for trend and driver analysis. Try asking a question above.</p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
