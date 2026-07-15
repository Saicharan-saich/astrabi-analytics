// ═══════════════════════════════════════════════════════════════════
// TransparencyPanel — "How was this calculated?"
//
// A self-contained, additive trust component. Given an AnalysisResult it
// reveals HOW a number was produced: the aggregation, the grouping, the
// filters applied, how many rows were processed, a confidence signal, any
// warnings, and the exact SQL that ran against the user's data.
//
// It renders NOTHING when there is no meaningful transparency data, so it
// is safe to drop next to any chart without affecting existing layouts.
// All data comes from fields that already exist on AnalysisResult — this
// component invents nothing.
// ═══════════════════════════════════════════════════════════════════

import React, { useMemo, useState } from 'react';
import {
    Info, ChevronDown, Copy, Check, ShieldCheck, AlertTriangle,
    Sigma, Layers, Filter as FilterIcon, Database
} from 'lucide-react';
import { AnalysisResult } from '../types';

interface TransparencyPanelProps {
    result: AnalysisResult;
    /** Optional dataset name shown as the data source. */
    datasetName?: string;
    /** Extra classes for the outer wrapper. */
    className?: string;
    /** Start expanded (default: collapsed). */
    defaultOpen?: boolean;
}

/** Human-readable filter descriptions derived from the query config. */
function deriveFilters(result: AnalysisResult): string[] {
    // Prefer the engine's own explainability if present.
    if (result.explainability?.filtersApplied?.length) {
        return result.explainability.filtersApplied;
    }

    const out: string[] = [];
    const cfg = result.config;
    if (!cfg) return out;

    // Dimension filters: { region: ['North', 'South'] }
    if (cfg.filters) {
        for (const [col, values] of Object.entries(cfg.filters)) {
            if (Array.isArray(values) && values.length > 0) {
                const shown = values.slice(0, 4).join(', ');
                const more = values.length > 4 ? ` +${values.length - 4} more` : '';
                out.push(`${col} in (${shown}${more})`);
            }
        }
    }

    // Numeric measure filters: quantity > 100
    if (Array.isArray(cfg.measureFilters)) {
        for (const f of cfg.measureFilters) {
            if (f?.column) out.push(`${f.column} ${f.operator} ${f.value}`);
        }
    }

    // Date filters (hierarchical) — describe them compactly.
    if (Array.isArray(cfg.dateFilters)) {
        for (const df of cfg.dateFilters as any[]) {
            if (!df) continue;
            const parts = [df.year, df.quarter, df.month, df.week, df.day]
                .filter((p) => p !== undefined && p !== null && p !== '');
            if (parts.length) out.push(`date = ${parts.join(' / ')}`);
        }
    }

    return out;
}

/** Confidence → { label, tone } for the badge. */
function confidenceMeta(confidence: number): { label: string; tone: 'high' | 'medium' | 'low' } {
    const pct = Math.round(confidence * 100);
    if (confidence >= 0.85) return { label: `High confidence · ${pct}%`, tone: 'high' };
    if (confidence >= 0.6) return { label: `Medium confidence · ${pct}%`, tone: 'medium' };
    return { label: `Low confidence · ${pct}%`, tone: 'low' };
}

export const TransparencyPanel: React.FC<TransparencyPanelProps> = ({
    result,
    datasetName,
    className = '',
    defaultOpen = false,
}) => {
    const [open, setOpen] = useState(defaultOpen);
    const [copied, setCopied] = useState(false);
    const panelId = useMemo(() => `transparency-${Math.random().toString(36).slice(2, 9)}`, []);

    const sql = (result.calculatedSql?.trim() || result.sql?.trim() || '');
    const exp = result.explainability;
    const filters = useMemo(() => deriveFilters(result), [result]);
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    const hasConfidence = typeof result.confidence === 'number' && !isNaN(result.confidence);

    const aggregation = exp?.aggregation || result.config?.aggregation;
    const sourceColumn = exp?.sourceColumn || result.config?.metric;
    const dimension = exp?.dimension || result.config?.dimension;
    const rowsProcessed = exp?.rowsProcessed;
    const resultRows = Array.isArray(result.data) ? result.data.length : undefined;

    // Nothing worth showing → render nothing (keeps layouts untouched).
    const hasContent = !!sql || !!exp || warnings.length > 0 || hasConfidence || filters.length > 0;
    if (!hasContent) return null;

    const handleCopy = async () => {
        if (!sql) return;
        try {
            await navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard blocked (e.g. insecure context) — fail silently.
        }
    };

    const conf = hasConfidence ? confidenceMeta(result.confidence as number) : null;
    const confToneClasses =
        conf?.tone === 'high'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20'
            : conf?.tone === 'medium'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20'
                : 'bg-rose-500/10 text-rose-600 dark:text-rose-300 border-rose-500/20';

    return (
        <div className={`mt-3 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-slate-900/40 no-export ${className}`}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={panelId}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-gray-600 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
                <Info className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" aria-hidden="true" />
                <span>How was this calculated?</span>
                {conf && (
                    <span className={`ml-1 hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-semibold ${confToneClasses}`}>
                        {conf.label}
                    </span>
                )}
                <ChevronDown
                    className={`w-4 h-4 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                    aria-hidden="true"
                />
            </button>

            {open && (
                <div id={panelId} className="px-3 pb-3 space-y-3 text-xs max-h-[40vh] overflow-y-auto">
                    {/* Summary chips */}
                    <div className="flex flex-wrap gap-2 pt-1">
                        {aggregation && sourceColumn && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-slate-200">
                                <Sigma className="w-3 h-3 text-indigo-500 dark:text-indigo-400" aria-hidden="true" />
                                <span className="font-mono">{String(aggregation).toUpperCase()}</span>
                                <span className="text-gray-400 dark:text-slate-500">of</span>
                                <span className="font-mono">{sourceColumn}</span>
                            </span>
                        )}
                        {dimension && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-slate-200">
                                <Layers className="w-3 h-3 text-indigo-500 dark:text-indigo-400" aria-hidden="true" />
                                <span className="text-gray-400 dark:text-slate-500">grouped by</span>
                                <span className="font-mono">{dimension}</span>
                            </span>
                        )}
                        {typeof rowsProcessed === 'number' && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-slate-200">
                                <Database className="w-3 h-3 text-indigo-500 dark:text-indigo-400" aria-hidden="true" />
                                <span>{rowsProcessed.toLocaleString()} rows processed</span>
                            </span>
                        )}
                        {typeof resultRows === 'number' && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-white/10 text-gray-700 dark:text-slate-200">
                                <span>{resultRows.toLocaleString()} result {resultRows === 1 ? 'row' : 'rows'}</span>
                            </span>
                        )}
                        {/* Confidence badge (mobile / when hidden in header) */}
                        {conf && (
                            <span className={`sm:hidden inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold ${confToneClasses}`}>
                                <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                                {conf.label}
                            </span>
                        )}
                    </div>

                    {/* Filters applied */}
                    {filters.length > 0 && (
                        <div className="flex items-start gap-2">
                            <FilterIcon className="w-3.5 h-3.5 mt-0.5 text-gray-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
                            <div className="flex flex-wrap gap-1.5">
                                {filters.map((f, i) => (
                                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 font-mono text-[11px]">
                                        {f}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Warnings */}
                    {warnings.length > 0 && (
                        <ul className="space-y-1">
                            {warnings.map((w, i) => (
                                <li key={i} className="flex items-start gap-2 text-amber-600 dark:text-amber-300">
                                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                                    <span>{w}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* SQL */}
                    {sql && (
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
                                    Query executed
                                </span>
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    aria-label="Copy SQL to clipboard"
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                                >
                                    {copied ? (
                                        <><Check className="w-3 h-3 text-emerald-500" aria-hidden="true" /> Copied</>
                                    ) : (
                                        <><Copy className="w-3 h-3" aria-hidden="true" /> Copy</>
                                    )}
                                </button>
                            </div>
                            <pre className="text-[11px] leading-relaxed text-gray-700 dark:text-slate-300 font-mono bg-white dark:bg-slate-950/60 rounded-lg p-2.5 border border-gray-200 dark:border-white/5 overflow-x-auto whitespace-pre-wrap break-words">
                                {sql}
                            </pre>
                        </div>
                    )}

                    {/* Trust footer */}
                    <p className="text-[11px] text-gray-400 dark:text-slate-500 pt-0.5">
                        Computed by running the query above against
                        {datasetName ? <> your dataset <span className="font-medium text-gray-500 dark:text-slate-400">{datasetName}</span></> : <> your data</>}.
                    </p>
                </div>
            )}
        </div>
    );
};

export default TransparencyPanel;
