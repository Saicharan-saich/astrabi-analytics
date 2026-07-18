import React, { useState } from 'react';
import {
    AlertTriangle, TrendingUp, TrendingDown, Info,
    Loader2, ArrowRight, GitBranch, Sparkles,
} from 'lucide-react';
import { Finding, FindingSeverity } from '../services/insightDiscoveryEngine';

/**
 * FindingsFeed — the "analyst sitting beside you" surface. Instead of asking the
 * user to type a question, it shows the handful of things that actually stand out
 * (drops, streaks, concentration, outliers, gaps), ranked by how much they
 * matter. Each finding opens a root-cause Investigation, or hands its follow-up
 * question straight to the AI SQL pipeline.
 *
 * Presentational — the findings are computed once by the parent (via
 * services/insightDiscoveryEngine) and shared with the Executive Summary.
 */

const SEVERITY_STYLE: Record<FindingSeverity, {
    ring: string; chip: string; iconColor: string; Icon: any; label: string;
}> = {
    critical: { ring: 'border-l-red-500', chip: 'bg-red-500/15 text-red-600 dark:text-red-400', iconColor: 'text-red-500', Icon: AlertTriangle, label: 'Critical' },
    warning: { ring: 'border-l-amber-500', chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', iconColor: 'text-amber-500', Icon: AlertTriangle, label: 'Watch' },
    positive: { ring: 'border-l-emerald-500', chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', iconColor: 'text-emerald-500', Icon: TrendingUp, label: 'Good news' },
    info: { ring: 'border-l-sky-500', chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', iconColor: 'text-sky-500', Icon: Info, label: 'FYI' },
};

function pickIcon(f: Finding) {
    if (f.type === 'decline_streak') return TrendingDown;
    if (f.type === 'growth_streak') return TrendingUp;
    return SEVERITY_STYLE[f.severity].Icon;
}

interface FindingsFeedProps {
    findings: Finding[];
    loading: boolean;
    /** Open the deterministic root-cause / investigation panel for a finding. */
    onInvestigate?: (finding: Finding) => void;
    /** Hand a natural-language follow-up to the AI SQL pipeline. */
    onAskQuestion?: (question: string) => void;
}

export const FindingsFeed: React.FC<FindingsFeedProps> = ({ findings, loading, onInvestigate, onAskQuestion }) => {
    const [collapsed, setCollapsed] = useState(false);

    if (loading) {
        return (
            <div className="mb-6 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-800/60 p-5">
                <div className="flex items-center gap-2.5 text-gray-600 dark:text-slate-300">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
                    <span className="text-sm font-medium">Scanning your data for what stands out…</span>
                </div>
            </div>
        );
    }

    if (!findings || findings.length === 0) return null;

    const counts = findings.reduce((acc, f) => {
        const k = f.severity === 'positive' ? 'good' : (f.severity === 'info' ? 'info' : 'attention');
        acc[k] = (acc[k] || 0) + 1; return acc;
    }, {} as Record<string, number>);

    return (
        <div className="mb-6 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-800/60 overflow-hidden">
            <button
                onClick={() => setCollapsed(c => !c)}
                className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                        <Sparkles className="w-4 h-4 text-white" />
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-gray-900 dark:text-white leading-tight">
                            We found {findings.length} {findings.length === 1 ? 'thing' : 'things'} worth a look
                        </h3>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                            {counts.attention ? `${counts.attention} need attention · ` : ''}
                            {counts.good ? `${counts.good} good news · ` : ''}
                            {counts.info ? `${counts.info} to note` : ''}
                            {!counts.attention && !counts.good && !counts.info ? 'Automatically detected from your data' : ''}
                        </p>
                    </div>
                </div>
                <span className="text-xs text-gray-400 dark:text-slate-500">{collapsed ? 'Show' : 'Hide'}</span>
            </button>

            {!collapsed && (
                <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                    {findings.map(f => {
                        const s = SEVERITY_STYLE[f.severity];
                        const Icon = pickIcon(f);
                        const canInvestigate = onInvestigate && f.type !== 'data_gap';
                        return (
                            <div key={f.id} className={`flex items-start gap-3.5 px-5 py-3.5 border-l-[3px] ${s.ring}`}>
                                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${s.iconColor}`} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-semibold text-gray-900 dark:text-white">{f.headline}</p>
                                        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.chip}`}>{s.label}</span>
                                    </div>
                                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 leading-relaxed">{f.detail}</p>

                                    <div className="flex items-center gap-3 mt-2">
                                        {canInvestigate && (
                                            <button
                                                onClick={() => onInvestigate!(f)}
                                                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 hover:gap-1.5 transition-all"
                                            >
                                                <GitBranch className="w-3 h-3" /> Investigate
                                            </button>
                                        )}
                                        {f.suggestedQuestion && onAskQuestion && (
                                            <button
                                                onClick={() => onAskQuestion(f.suggestedQuestion!)}
                                                className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors"
                                            >
                                                <ArrowRight className="w-3 h-3" /> {f.suggestedQuestion}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
