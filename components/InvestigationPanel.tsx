import React, { useState, useEffect } from 'react';
import { X, Search, ArrowRight, GitBranch, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { Dataset } from '../types';
import { SemanticModel } from '../services/semanticModel';
import { Finding } from '../services/insightDiscoveryEngine';
import {
    buildInvestigation, buildContributionSQL, rankContributors, summarizeContributors,
    Investigation, Contributor,
} from '../services/investigationEngine';
import { executeSQLViaDuckDB } from '../services/duckdbEngine';

/**
 * InvestigationPanel — the "why" behind a finding. It shows the analyst reasoning
 * path (which angles to break the metric down by, in the right order for the
 * domain) and, for a period change, the deterministic root-cause: which
 * categories actually drove the change, computed from DuckDB aggregates.
 *
 * Each step is one click to run through the AI SQL pipeline.
 */
interface Props {
    finding: Finding;
    dataset: Dataset;
    onClose: () => void;
    onAskQuestion?: (question: string) => void;
}

export const InvestigationPanel: React.FC<Props> = ({ finding, dataset, onClose, onAskQuestion }) => {
    const model = dataset.semanticModel as SemanticModel | undefined;
    const domain = (dataset as any)?.domainProfile?.domain as string | undefined;
    const [investigation, setInvestigation] = useState<Investigation | null>(null);
    const [contributors, setContributors] = useState<Contributor[] | null>(null);
    const [loadingContrib, setLoadingContrib] = useState(false);

    useEffect(() => {
        if (!model) return;
        setInvestigation(buildInvestigation(finding, model, domain));
    }, [finding.id]);

    // For a period change, compute the deterministic root-cause contribution.
    useEffect(() => {
        const ev = finding.evidence || {};
        if (finding.type !== 'period_change' || !finding.metric || !finding.dimension || !ev.previousPeriod || !ev.latestPeriod || !model) {
            setContributors(null);
            return;
        }
        // Break the change down by the first reasoning-path dimension.
        const inv = buildInvestigation(finding, model, domain);
        const dim = inv.steps[0]?.dimension;
        if (!dim) { setContributors(null); return; }
        const measure = model.measures.find(m => m.column === finding.metric);
        const agg = measure?.aggregation;
        let cancelled = false;
        (async () => {
            setLoadingContrib(true);
            try {
                const sql = buildContributionSQL(finding.metric!, agg as any, finding.dimension!, dim, ev.previousPeriod, ev.latestPeriod);
                const res = await executeSQLViaDuckDB(dataset.rows, sql, dataset.timeContext as any);
                if (!cancelled) setContributors(res.error ? null : rankContributors((res.data || []) as any).filter(c => c.delta !== 0).slice(0, 6));
            } catch { if (!cancelled) setContributors(null); }
            finally { if (!cancelled) setLoadingContrib(false); }
        })();
        return () => { cancelled = true; };
    }, [finding.id]);

    if (!model) return null;
    const maxAbs = contributors && contributors.length ? Math.max(...contributors.map(c => Math.abs(c.delta))) : 1;
    const contribDim = investigation?.steps[0]?.dimension;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100 dark:border-white/10 bg-white dark:bg-slate-800">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0">
                            <GitBranch className="w-4 h-4 text-white" />
                        </div>
                        <div>
                            <h2 className="text-base font-bold text-gray-900 dark:text-white leading-tight">{investigation?.subject || 'Investigate'}</h2>
                            <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{finding.headline}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-white/10">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-6">
                    {/* Root-cause contribution (period changes only) */}
                    {(loadingContrib || (contributors && contributors.length > 0)) && (
                        <div>
                            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-3">
                                Root cause — what drove the change{contribDim ? `, by ${humanizeInline(contribDim)}` : ''}
                            </h3>
                            {loadingContrib ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
                                    <Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> Decomposing the change…
                                </div>
                            ) : contributors && (
                                <>
                                    <p className="text-sm text-gray-700 dark:text-slate-200 mb-3">{summarizeContributors(contributors, finding.metric || '')}</p>
                                    <div className="space-y-2">
                                        {contributors.map(c => {
                                            const down = c.delta < 0;
                                            return (
                                                <div key={c.label} className="flex items-center gap-3">
                                                    <div className="w-28 truncate text-xs text-gray-600 dark:text-slate-300" title={c.label}>{c.label}</div>
                                                    <div className="flex-1 h-5 rounded bg-gray-100 dark:bg-white/5 relative overflow-hidden">
                                                        <div
                                                            className={`absolute top-0 bottom-0 ${down ? 'right-1/2 bg-red-500/70' : 'left-1/2 bg-emerald-500/70'}`}
                                                            style={{ width: `${(Math.abs(c.delta) / maxAbs) * 50}%` }}
                                                        />
                                                        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 dark:bg-white/20" />
                                                    </div>
                                                    <div className={`w-20 text-right text-xs font-semibold tabular-nums flex items-center justify-end gap-1 ${down ? 'text-red-500' : 'text-emerald-500'}`}>
                                                        {down ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
                                                        {fmtDelta(c.delta)}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* Guided investigation path */}
                    <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-3">
                            Follow the trail — questions an analyst would ask next
                        </h3>
                        <div className="space-y-2">
                            {investigation?.steps.map((step, i) => (
                                <button
                                    key={step.id}
                                    onClick={() => onAskQuestion?.(step.question)}
                                    disabled={!onAskQuestion}
                                    className="w-full text-left flex items-start gap-3 p-3 rounded-xl border border-gray-200 dark:border-white/10 hover:border-indigo-400/60 dark:hover:border-indigo-400/40 hover:bg-indigo-50/50 dark:hover:bg-indigo-500/[0.06] transition-all group disabled:cursor-default"
                                >
                                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-slate-300 text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <p className="text-sm font-medium text-gray-900 dark:text-white">{step.question}</p>
                                            {onAskQuestion && <Search className="w-3 h-3 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />}
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{step.rationale}</p>
                                    </div>
                                    {onAskQuestion && <ArrowRight className="w-4 h-4 text-gray-300 dark:text-slate-600 group-hover:text-indigo-400 transition-colors flex-shrink-0 mt-1" />}
                                </button>
                            ))}
                            {investigation && investigation.steps.length === 0 && (
                                <p className="text-sm text-gray-500 dark:text-slate-400">No further breakdown dimensions are available for this dataset.</p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

function humanizeInline(col: string): string {
    return col.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function fmtDelta(v: number): string {
    const sign = v < 0 ? '−' : '+';
    const a = Math.abs(v);
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
    return `${sign}${Math.round(a).toLocaleString()}`;
}
