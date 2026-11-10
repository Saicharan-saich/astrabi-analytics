import React from 'react';
import {
    ChevronDown, Check, SkipForward, Edit3, Eye, Table,
} from 'lucide-react';
import { ETLLog } from '../types';
import { getStepGuide } from './etlStepGuide';
import type { StepDecision } from '../utils/cleaningReview';

/**
 * ETLStepCard — one ETL step rendered as a sleek, self-explanatory card.
 * Presentation only: it takes a log entry and shows a non-technical explanation
 * (what / why / what-if-skipped / example) plus the real technical details in a
 * collapsible footer. All cleaning logic lives in the pipeline, untouched.
 */

type Status = 'applied' | 'skipped' | 'info';

const STATUS: Record<Status, {
    label: string; pill: string; rail: string; tile: string; ring: string;
}> = {
    applied: {
        label: 'Applied',
        pill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        rail: 'before:bg-emerald-500',
        tile: 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200/70 dark:border-emerald-500/20',
        ring: 'hover:border-emerald-300/70 dark:hover:border-emerald-500/40',
    },
    info: {
        label: 'Flagged',
        pill: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        rail: 'before:bg-amber-500',
        tile: 'bg-amber-50 dark:bg-amber-500/10 border-amber-200/70 dark:border-amber-500/20',
        ring: 'hover:border-amber-300/70 dark:hover:border-amber-500/40',
    },
    skipped: {
        label: 'Not needed',
        pill: 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-400',
        rail: 'before:bg-slate-300 dark:before:bg-slate-600',
        tile: 'bg-slate-50 dark:bg-white/5 border-slate-200/70 dark:border-white/10',
        ring: 'hover:border-slate-300 dark:hover:border-white/20',
    },
};

const typeColor = (t: string) => ({
    METRIC: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/20',
    DIMENSION: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/20',
    DATE: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20',
    ID: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:border-purple-500/20',
}[t] || 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-slate-300 dark:border-white/10');

const STEP_LABELS: Record<string, { label: string; icon: string }> = {
    TITLE_CASE: { label: 'Standardize casing', icon: '🔤' },
    'TITLE_CASE(normalize)': { label: 'Normalize casing', icon: '🔤' },
    SYNONYM_MAP: { label: 'Normalize category names', icon: '🔄' },
    IMPUTE_UNKNOWN: { label: 'Fill blanks with "Unknown"', icon: '⬜' },
    IMPUTE_NONE: { label: 'Fill blanks with "None" (there wasn\'t one)', icon: '⬜' },
    'PARSE_NUMBER(locale-aware)': { label: 'Convert to number', icon: '🔢' },
    PARSE_NUMBER: { label: 'Convert to number', icon: '🔢' },
    IMPUTE_NULL: { label: 'Handle missing values', icon: '⬜' },
    REMOVE_CURRENCY: { label: 'Remove currency symbols', icon: '💲' },
    REMOVE_PERCENTAGE: { label: 'Remove % symbols', icon: '📊' },
    CAST_ID: { label: 'Clean ID format', icon: '🔑' },
    NORMALIZE_BOOLEAN: { label: 'Standardize yes/no', icon: '✅' },
    WORD_TO_NUMBER: { label: 'Convert words to numbers', icon: '🔡' },
};

interface Props {
    entry: ETLLog & { _key: string };
    isExpanded: boolean;
    onToggle: (key: string) => void;
    etlMode: 'auto' | 'manual';
    isApproved: boolean;
    isSkipped: boolean;
    onApprove: (key: string) => void;
    onSkip: (key: string) => void;
    onEditRemoved: (key: string, rows: Record<string, any>[]) => void;
    /** The decision waiting for "Apply changes", if any. */
    decision?: StepDecision;
    onDecide?: (key: string, decision: StepDecision) => void;
    onClearDecision?: (key: string) => void;
}

const decisionLabel = (decision: StepDecision): string => {
    switch (decision.kind) {
        case 'keep': return 'Kept';
        case 'undo': return `Will undo — ${decision.revert.label}`;
        case 'outlier': return decision.choice === 'keep' ? 'Will keep as correct' : decision.choice === 'remove' ? 'Will remove these rows' : 'Will cap to the usual range';
        case 'typo': return decision.choice === 'merge' ? 'Will merge them' : 'Will keep them apart';
        case 'flag': return `Will: ${decision.label.charAt(0).toLowerCase()}${decision.label.slice(1)}`;
    }
};

export const ETLStepCard: React.FC<Props> = ({
    entry, isExpanded, onToggle, etlMode, onApprove, onSkip, onEditRemoved, decision, onDecide, onClearDecision,
}) => {
    const status = (entry.status as Status) in STATUS ? (entry.status as Status) : 'info';
    const s = STATUS[status];
    const guide = getStepGuide(entry.step);
    const isFlag = status === 'info';
    const isTransformPlans = entry.step === 'Transform Plans';

    const hasDetails = !!(
        entry.affectedColumns?.length || entry.rowsBefore !== undefined || entry.affectedRows !== undefined || (entry.sampleRows && entry.sampleRows.length > 0) ||
        (entry.removedRowSamples && entry.removedRowSamples.length > 0) ||
        (entry.transformSamples && entry.transformSamples.length > 0) || isTransformPlans
    );

    const open = isExpanded;
    const summary = isFlag && !isTransformPlans ? entry.details : guide.what;
    return (
        <div className={`qi-step is-${status}`}>
            <div className="flex items-start gap-3 px-4 py-3">
                <span className="qi-step-dot mt-[7px]" aria-hidden />
                <button type="button" onClick={() => onToggle(entry._key)} className="flex-1 min-w-0 text-left" aria-expanded={open}>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="qi-step-title text-[13px] font-semibold">{guide.title}</span>
                        <span className="qi-step-status text-[11px] font-semibold">{s.label}</span>
                    </div>
                    <p className={`qi-step-summary text-[12.5px] leading-5 mt-0.5 ${open ? '' : 'line-clamp-1'}`}>{summary}</p>
                </button>
                {etlMode === 'manual' && (decision || entry.decision || (status === 'applied' && entry.revert)) && (
                    <div className="qi-step-actions flex flex-wrap items-center justify-end gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                        {decision ? (
                            <>
                                <span className={`qi-step-chip inline-flex items-center gap-1 text-[11px] font-semibold ${decision.kind === 'keep' ? '' : 'is-pending'}`}>
                                    {decision.kind === 'undo' ? <SkipForward className="w-3 h-3" /> : <Check className="w-3 h-3" />} {decisionLabel(decision)}
                                </span>
                                <button type="button" onClick={() => onClearDecision?.(entry._key)} className="qi-step-link text-[11px] font-semibold">Change</button>
                            </>
                        ) : entry.decision?.kind === 'outlier' ? (
                            <>
                                <button type="button" onClick={() => onDecide?.(entry._key, { kind: 'outlier', column: entry.decision!.column, choice: 'keep' })} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold"><Check className="w-3 h-3" /> Values are correct</button>
                                <button type="button" onClick={() => onDecide?.(entry._key, { kind: 'outlier', column: entry.decision!.column, choice: 'remove' })} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold">Remove these rows</button>
                                <button type="button" onClick={() => onDecide?.(entry._key, { kind: 'outlier', column: entry.decision!.column, choice: 'cap' })} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold">Cap to usual range</button>
                            </>
                        ) : entry.decision?.kind === 'flag' && entry.decision.key && entry.decision.options?.length ? (
                            <>
                                {entry.decision.options.map((option, index) => (
                                    <button
                                        key={option.choice}
                                        type="button"
                                        onClick={() => onDecide?.(entry._key, { kind: 'flag', key: entry.decision!.key!, column: entry.decision!.column, choice: option.choice, label: option.label })}
                                        className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold"
                                    >
                                        {index === 0 && <Check className="w-3 h-3" />} {option.label}
                                    </button>
                                ))}
                            </>
                        ) : entry.decision?.kind === 'typo' ? (
                            <>
                                <button type="button" onClick={() => onDecide?.(entry._key, { kind: 'typo', column: entry.decision!.column, choice: 'merge' })} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold"><Check className="w-3 h-3" /> Merge them</button>
                                <button type="button" onClick={() => onDecide?.(entry._key, { kind: 'typo', column: entry.decision!.column, choice: 'keep' })} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold">Keep separate</button>
                            </>
                        ) : entry.revert ? (
                            <>
                                <button type="button" onClick={() => onApprove(entry._key)} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold"><Check className="w-3 h-3" /> Keep</button>
                                <button type="button" onClick={() => onSkip(entry._key)} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold" title={entry.revert.label}><SkipForward className="w-3 h-3" /> Undo</button>
                                {entry.removedRowSamples && entry.removedRowSamples.length > 0 && (
                                    <button type="button" onClick={() => onEditRemoved(entry._key, entry.removedRowSamples!)} className="qi-step-action inline-flex items-center gap-1 text-[11px] font-semibold"><Edit3 className="w-3 h-3" /> Edit rows</button>
                                )}
                            </>
                        ) : null}
                    </div>
                )}
                <button type="button" onClick={() => onToggle(entry._key)} className="qi-step-chevron shrink-0 mt-0.5" aria-label={open ? 'Hide details' : 'Show details'}>
                    <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
            </div>

            {open && (
                <div className="qi-step-body px-4 pb-4 pl-[38px] space-y-2 text-[12.5px] leading-5">
                    {isFlag && !isTransformPlans && <p className="qi-step-muted">{guide.what}</p>}
                    <p><span className="font-semibold">Why it matters: </span>{guide.why}</p>
                    <p className="qi-step-muted"><span className="font-semibold">Example: </span><span className="font-mono">{guide.example}</span></p>
                    {status === 'applied' && <p className="qi-step-muted"><span className="font-semibold">Without this: </span>{guide.ifSkipped}</p>}
                    <p className="qi-step-muted font-mono text-[11px]">{entry.step}{!isFlag && !isTransformPlans && entry.details ? ` — ${entry.details}` : ''}</p>
                </div>
            )}

            {/* Expanded technical panel */}
            {isExpanded && hasDetails && (
                <div className="px-4 pb-4 pl-[38px]">
                    <div className="qi-step-tech rounded-lg p-3 space-y-3">
                        {(entry.rowsBefore !== undefined && entry.rowsAfter !== undefined) && (
                            <div className="flex items-center gap-3 text-xs">
                                <span className="text-slate-500 dark:text-slate-400 font-medium">Rows</span>
                                <span className="font-mono font-bold text-slate-700 dark:text-slate-200">{entry.rowsBefore.toLocaleString()}</span>
                                <span className="text-slate-400">→</span>
                                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{entry.rowsAfter.toLocaleString()}</span>
                                {entry.rowsBefore !== entry.rowsAfter && (
                                    <span className="text-rose-500 font-semibold bg-rose-50 dark:bg-rose-500/10 px-2 py-0.5 rounded-full">−{(entry.rowsBefore - entry.rowsAfter).toLocaleString()}</span>
                                )}
                            </div>
                        )}
                        {entry.affectedRows !== undefined && entry.rowsBefore === undefined && (
                            <div className="text-xs"><span className="text-slate-500 dark:text-slate-400 font-medium mr-2">Cells affected</span><span className="font-mono font-bold text-indigo-600 dark:text-indigo-300">{entry.affectedRows.toLocaleString()}</span></div>
                        )}
                        {entry.affectedColumns && entry.affectedColumns.length > 0 && (
                            <div className="text-xs">
                                <span className="text-slate-500 dark:text-slate-400 font-medium">Columns</span>
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {entry.affectedColumns.slice(0, 15).map((col, i) => (
                                        <span key={i} className="inline-block px-2 py-0.5 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 rounded-md text-[11px] font-mono border border-indigo-200/70 dark:border-indigo-500/20">{col}</span>
                                    ))}
                                    {entry.affectedColumns.length > 15 && <span className="text-slate-400 text-[11px] self-center">+{entry.affectedColumns.length - 15} more</span>}
                                </div>
                            </div>
                        )}

                        {/* Transform Plans → per-column step chips */}
                        {isTransformPlans && (
                            <div className="overflow-auto max-h-64 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-800/60">
                                <table className="w-full text-[11px]">
                                    <thead className="bg-slate-50 dark:bg-white/5 sticky top-0">
                                        <tr>
                                            <th className="px-3 py-2 text-left font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider border-b border-slate-200 dark:border-white/10">Column</th>
                                            <th className="px-3 py-2 text-left font-bold text-indigo-600 dark:text-indigo-300 uppercase tracking-wider border-b border-slate-200 dark:border-white/10">Type</th>
                                            <th className="px-3 py-2 text-left font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider border-b border-slate-200 dark:border-white/10">Cleaning steps</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                                        {entry.details.split('\n').filter(line => line.includes(':')).slice(1).map((line, li) => {
                                            const match = line.match(/^(.+?)\s*\((\w+)\):\s*(.+)$/);
                                            if (!match) return null;
                                            const [, colName, colType, stepsRaw] = match;
                                            const steps = stepsRaw.split('→').map(x => x.trim());
                                            return (
                                                <tr key={li}>
                                                    <td className="px-3 py-1.5 font-mono font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">{colName.trim()}</td>
                                                    <td className="px-3 py-1.5"><span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${typeColor(colType)}`}>{colType}</span></td>
                                                    <td className="px-3 py-1.5">
                                                        <div className="flex flex-wrap gap-1">
                                                            {steps.map((st, si) => {
                                                                const dm = st.match(/^PARSE_DATE\((.+)\)$/);
                                                                const info = dm ? { label: `Parse date (${dm[1]})`, icon: '📅' } : STEP_LABELS[st] || { label: st, icon: '⚙️' };
                                                                return <span key={si} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 rounded text-[11px] border border-indigo-100 dark:border-indigo-500/20" title={st}><span>{info.icon}</span> {info.label}</span>;
                                                            })}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* Removed rows preview */}
                        {entry.removedRowSamples && entry.removedRowSamples.length > 0 && (
                            <div>
                                <div className="flex items-center gap-2 mb-2"><Eye className="w-3.5 h-3.5 text-rose-500" /><span className="text-xs font-semibold text-rose-600 dark:text-rose-300">Removed rows preview</span></div>
                                <div className="overflow-auto max-h-40 rounded-lg border border-rose-200/70 dark:border-rose-500/20 bg-white dark:bg-slate-800/60">
                                    <table className="w-full text-[11px]">
                                        <thead className="bg-rose-50 dark:bg-rose-500/10 sticky top-0"><tr>{Object.keys(entry.removedRowSamples[0]).map(col => <th key={col} className="px-2 py-1.5 text-left font-bold text-rose-600 dark:text-rose-300 uppercase border-b border-rose-200/70 dark:border-rose-500/20 whitespace-nowrap">{col}</th>)}</tr></thead>
                                        <tbody className="divide-y divide-rose-100 dark:divide-white/5">
                                            {entry.removedRowSamples.map((row, ri) => (
                                                <tr key={ri}>{Object.keys(entry.removedRowSamples![0]).map(col => {
                                                    const val = row[col]; const empty = val === null || val === undefined || val === '';
                                                    return <td key={col} className={`px-2 py-1 font-mono whitespace-nowrap ${empty ? 'text-rose-400 italic' : 'text-slate-700 dark:text-slate-300'}`}>{empty ? '∅' : String(val)}</td>;
                                                })}</tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Example rows a flag is about */}
                        {entry.sampleRows && entry.sampleRows.length > 0 && (
                            <div>
                                <div className="flex items-center gap-2 mb-2"><Eye className="w-3.5 h-3.5 text-amber-500" /><span className="text-xs font-semibold text-amber-700 dark:text-amber-300">Rows to check</span></div>
                                <div className="overflow-auto max-h-40 rounded-lg border border-amber-200/70 dark:border-amber-500/20 bg-white dark:bg-slate-800/60">
                                    <table className="w-full text-[11px]">
                                        <thead className="bg-amber-50 dark:bg-amber-500/10 sticky top-0"><tr>{Object.keys(entry.sampleRows[0]).slice(0, 8).map(col => <th key={col} className={`px-2 py-1.5 text-left font-bold uppercase border-b border-amber-200/70 dark:border-amber-500/20 whitespace-nowrap ${entry.affectedColumns?.includes(col) ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>{col}</th>)}</tr></thead>
                                        <tbody className="divide-y divide-amber-100 dark:divide-white/5">
                                            {entry.sampleRows.map((row, ri) => (
                                                <tr key={ri}>{Object.keys(entry.sampleRows![0]).slice(0, 8).map(col => {
                                                    const val = row[col]; const empty = val === null || val === undefined || val === '';
                                                    return <td key={col} className={`px-2 py-1 font-mono whitespace-nowrap ${entry.affectedColumns?.includes(col) ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-slate-700 dark:text-slate-300'}`}>{empty ? '∅' : String(val)}</td>;
                                                })}</tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Before → after samples */}
                        {entry.transformSamples && entry.transformSamples.length > 0 && (
                            <div>
                                <div className="flex items-center gap-2 mb-2"><Table className="w-3.5 h-3.5 text-indigo-500" /><span className="text-xs font-semibold text-indigo-600 dark:text-indigo-300">Before → after</span></div>
                                <div className="overflow-auto max-h-40 rounded-lg border border-indigo-200/70 dark:border-indigo-500/20 bg-white dark:bg-slate-800/60">
                                    <table className="w-full text-[11px]">
                                        <thead className="bg-indigo-50 dark:bg-indigo-500/10 sticky top-0"><tr>
                                            <th className="px-2 py-1.5 text-left font-bold text-indigo-700 dark:text-indigo-300 uppercase border-b border-indigo-200/70 dark:border-indigo-500/20">Column</th>
                                            <th className="px-2 py-1.5 text-left font-bold text-rose-500 uppercase border-b border-indigo-200/70 dark:border-indigo-500/20">Before</th>
                                            <th className="px-2 py-1.5 text-center text-slate-400 border-b border-indigo-200/70 dark:border-indigo-500/20">→</th>
                                            <th className="px-2 py-1.5 text-left font-bold text-emerald-600 uppercase border-b border-indigo-200/70 dark:border-indigo-500/20">After</th>
                                        </tr></thead>
                                        <tbody className="divide-y divide-indigo-100 dark:divide-white/5">
                                            {entry.transformSamples.map((sm, si) => (
                                                <tr key={si}>
                                                    <td className="px-2 py-1 font-mono text-indigo-700 dark:text-indigo-300 font-semibold whitespace-nowrap">{sm.column}</td>
                                                    <td className="px-2 py-1 font-mono text-rose-600 dark:text-rose-300 whitespace-nowrap bg-rose-50/40 dark:bg-rose-500/5">{sm.before === null || sm.before === undefined ? '∅' : String(sm.before)}</td>
                                                    <td className="px-2 py-1 text-center text-slate-300">→</td>
                                                    <td className="px-2 py-1 font-mono text-emerald-700 dark:text-emerald-300 font-semibold whitespace-nowrap bg-emerald-50/40 dark:bg-emerald-500/5">{sm.after === null || sm.after === undefined ? '∅' : String(sm.after)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
