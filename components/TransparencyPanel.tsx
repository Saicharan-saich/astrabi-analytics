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
//
// Theming: this app is Tailwind v4 WITHOUT a `.dark`-class mapping, so the
// `dark:` variant follows the OS, not the app. We therefore read the real
// app theme via useTheme() and switch classes explicitly — the same
// pattern App.tsx uses — with solid backgrounds for crisp contrast.
// ═══════════════════════════════════════════════════════════════════

import React, { useMemo, useState } from 'react';
import {
    Info, ChevronDown, Copy, Check, ShieldCheck, AlertTriangle,
    Sigma, Layers, Filter as FilterIcon, Database
} from 'lucide-react';
import { AnalysisResult } from '../types';
import { useTheme } from './ThemeProvider';

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
    const { theme } = useTheme();
    const isDark = theme === 'dark';
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
            ? (isDark ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-emerald-50 text-emerald-700 border-emerald-200')
            : conf?.tone === 'medium'
                ? (isDark ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-amber-50 text-amber-700 border-amber-200')
                : (isDark ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-rose-50 text-rose-700 border-rose-200');

    // ── Theme-explicit class fragments (solid backgrounds, high contrast) ──
    const container = isDark ? 'bg-[#141825] border-white/10' : 'bg-white border-gray-200 shadow-sm';
    const headerText = isDark ? 'text-slate-200 hover:text-white' : 'text-gray-700 hover:text-gray-900';
    const accentIcon = isDark ? 'text-indigo-400' : 'text-indigo-600';
    const chip = isDark ? 'bg-slate-800 border-white/10 text-slate-200' : 'bg-gray-50 border-gray-200 text-gray-700';
    const chipMuted = isDark ? 'text-slate-500' : 'text-gray-400';
    const filterChip = isDark ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' : 'bg-indigo-50 text-indigo-700 border-indigo-200';
    const warnText = isDark ? 'text-amber-300' : 'text-amber-600';
    const sqlLabel = isDark ? 'text-slate-500' : 'text-gray-400';
    const copyBtn = isDark ? 'text-slate-400 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100';
    const footerText = isDark ? 'text-slate-500' : 'text-gray-400';
    const dividerBorder = isDark ? 'border-white/10' : 'border-gray-100';

    return (
        <div className={`mt-3 rounded-xl border overflow-hidden no-export ${container} ${className}`}>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={panelId}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs font-semibold transition-colors ${headerText}`}
            >
                <Info className={`w-3.5 h-3.5 shrink-0 ${accentIcon}`} aria-hidden="true" />
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
                <div id={panelId} className={`px-3 pb-3 pt-1 space-y-3 text-xs max-h-[40vh] overflow-y-auto border-t ${dividerBorder}`}>
                    {/* Summary chips */}
                    <div className="flex flex-wrap gap-2 pt-2">
                        {aggregation && sourceColumn && (
                            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${chip}`}>
                                <Sigma className={`w-3 h-3 ${accentIcon}`} aria-hidden="true" />
                                <span className="font-mono font-semibold">{String(aggregation).toUpperCase()}</span>
                                <span className={chipMuted}>of</span>
                                <span className="font-mono">{sourceColumn}</span>
                            </span>
                        )}
                        {dimension && (
                            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${chip}`}>
                                <Layers className={`w-3 h-3 ${accentIcon}`} aria-hidden="true" />
                                <span className={chipMuted}>grouped by</span>
                                <span className="font-mono">{dimension}</span>
                            </span>
                        )}
                        {typeof rowsProcessed === 'number' && (
                            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${chip}`}>
                                <Database className={`w-3 h-3 ${accentIcon}`} aria-hidden="true" />
                                <span>{rowsProcessed.toLocaleString()} rows processed</span>
                            </span>
                        )}
                        {typeof resultRows === 'number' && (
                            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${chip}`}>
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
                            <FilterIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${chipMuted}`} aria-hidden="true" />
                            <div className="flex flex-wrap gap-1.5">
                                {filters.map((f, i) => (
                                    <span key={i} className={`inline-flex items-center px-2 py-0.5 rounded-md border font-mono text-[11px] ${filterChip}`}>
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
                                <li key={i} className={`flex items-start gap-2 ${warnText}`}>
                                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                                    <span>{w}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* SQL — always a dark code panel for consistent legibility */}
                    {sql && (
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <span className={`text-[11px] font-semibold uppercase tracking-wide ${sqlLabel}`}>
                                    Query executed
                                </span>
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    aria-label="Copy SQL to clipboard"
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] transition-colors ${copyBtn}`}
                                >
                                    {copied ? (
                                        <><Check className="w-3 h-3 text-emerald-400" aria-hidden="true" /> Copied</>
                                    ) : (
                                        <><Copy className="w-3 h-3" aria-hidden="true" /> Copy</>
                                    )}
                                </button>
                            </div>
                            <pre className="text-[11px] leading-relaxed text-slate-200 font-mono bg-[#0b1020] rounded-lg p-2.5 border border-white/10 overflow-x-auto whitespace-pre-wrap break-words">
                                {sql}
                            </pre>
                        </div>
                    )}

                    {/* Trust footer */}
                    <p className={`text-[11px] pt-0.5 ${footerText}`}>
                        Computed by running the query above against
                        {datasetName ? <> your dataset <span className={`font-medium ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>{datasetName}</span></> : <> your data</>}.
                    </p>
                </div>
            )}
        </div>
    );
};

export default TransparencyPanel;
