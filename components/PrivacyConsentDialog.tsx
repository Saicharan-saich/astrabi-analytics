import React, { useEffect, useRef, useState, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { Shield, ShieldCheck, X, Check, Eye, EyeOff, Database, RotateCcw } from 'lucide-react';
import type { PrivacyDisclosure } from '../services/ai-sql/privacyDisclosure';
import { ALWAYS_SENT, NEVER_SENT } from '../services/ai-sql/privacyDisclosure';
import {
    type PrivacySelection, EMPTY_SELECTION,
    isColumnExcluded, isValueExcluded, toggleColumn, toggleValue, excludeAll,
} from '../services/ai-sql/privacySelection';

interface PrivacyConsentDialogProps {
    open: boolean;
    /** Null when no dataset is loaded — the dialog then shows the rules only. */
    disclosure: PrivacyDisclosure | null;
    /**
     * 'consent' — switching Better answers on; must agree before anything is sent.
     * 'review'  — already on; change what is shared, or turn it off.
     */
    mode: 'consent' | 'review';
    /** Choices already saved for this dataset. */
    selection: PrivacySelection;
    onAgree: (selection: PrivacySelection) => void;
    onDecline: () => void;
    onClose: () => void;
}

export const PrivacyConsentDialog: React.FC<PrivacyConsentDialogProps> = ({
    open, disclosure, mode, selection, onAgree, onDecline, onClose,
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState<PrivacySelection>(selection);

    // Reopening starts from what is actually saved, not the last unsaved edit.
    useEffect(() => { if (open) setDraft(selection); }, [open, selection]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        panelRef.current?.focus();
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const shared = disclosure?.shared ?? [];
    const withheld = disclosure?.withheld ?? [];

    // Live count of what the current choices would actually send.
    const sendingCount = useMemo(() => shared.reduce((n, col) => {
        if (isColumnExcluded(draft, col.name)) return n;
        return n + col.values.filter(v => !isValueExcluded(draft, col.name, v)).length;
    }, 0), [shared, draft]);

    const activeColumns = useMemo(() => shared.filter(col =>
        !isColumnExcluded(draft, col.name)
        && col.values.some(v => !isValueExcluded(draft, col.name, v))
    ).length, [shared, draft]);

    if (!open) return null;

    const allOff = shared.length > 0 && activeColumns === 0;

    return ReactDOM.createPortal(
        <div
            className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-consent-title"
        >
            <div
                ref={panelRef}
                tabIndex={-1}
                className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 shadow-2xl outline-none"
            >
                {/* Header */}
                <div className="shrink-0 flex items-start gap-3 p-5 border-b border-gray-200 dark:border-white/10">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center shrink-0">
                        <Shield className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 id="privacy-consent-title" className="text-lg font-bold text-gray-900 dark:text-white">
                            Choose what the AI can see
                        </h2>
                        <p className="text-sm text-gray-600 dark:text-slate-400 mt-0.5">
                            {disclosure
                                ? <>Switch off any column or any single value from <span className="font-semibold text-gray-800 dark:text-slate-200">{disclosure.datasetName}</span>. Nothing you switch off is ever sent.</>
                                : 'Load a file to choose exactly what is shared from your own data.'}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                        aria-label="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Live summary */}
                {disclosure && (
                    <div className={`shrink-0 px-5 py-3 border-b border-gray-200 dark:border-white/10 flex items-center justify-between gap-3 flex-wrap ${allOff ? 'bg-emerald-50 dark:bg-emerald-500/5' : 'bg-amber-50/60 dark:bg-amber-500/5'}`}>
                        <p className="text-sm font-semibold text-gray-800 dark:text-slate-200">
                            {allOff
                                ? 'Sending no values at all — same as Private mode'
                                : <>Sending <span className="text-amber-700 dark:text-amber-300">{sendingCount} value{sendingCount === 1 ? '' : 's'}</span> from {activeColumns} column{activeColumns === 1 ? '' : 's'}</>}
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setDraft(excludeAll(shared.map(c => c.name)))}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-gray-300 dark:border-white/15 text-gray-700 dark:text-slate-300 hover:bg-white dark:hover:bg-white/5 transition-colors"
                            >
                                Switch all off
                            </button>
                            <button
                                onClick={() => setDraft(EMPTY_SELECTION)}
                                className="px-2.5 py-1 rounded-lg text-xs font-semibold border border-gray-300 dark:border-white/15 text-gray-700 dark:text-slate-300 hover:bg-white dark:hover:bg-white/5 transition-colors flex items-center gap-1.5"
                            >
                                <RotateCcw className="w-3 h-3" /> Switch all on
                            </button>
                        </div>
                    </div>
                )}

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    <section>
                        <div className="flex items-center gap-2 mb-2">
                            <Eye className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                            <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                                Values you can share
                            </h3>
                            <span className="text-xs text-gray-500 dark:text-slate-400">
                                tap any value to switch it off
                            </span>
                        </div>

                        {shared.length === 0 ? (
                            <p className="text-sm text-gray-600 dark:text-slate-400 bg-gray-50 dark:bg-slate-800/60 rounded-xl p-3 border border-gray-200 dark:border-white/10">
                                {disclosure
                                    ? 'Nothing. No column in this file qualifies, so Better answers would send exactly the same as Private mode.'
                                    : 'This depends on your file. Nothing is shared from columns holding names, IDs, dates, numbers or anything sensitive.'}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {shared.map(col => {
                                    const colOff = isColumnExcluded(draft, col.name);
                                    const liveValues = col.values.filter(v => !isValueExcluded(draft, col.name, v)).length;
                                    return (
                                        <div
                                            key={col.name}
                                            className={`rounded-xl border p-3 transition-colors ${colOff
                                                ? 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-slate-800/40'
                                                : 'border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/5'}`}
                                        >
                                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                                                {/* Column switch */}
                                                <button
                                                    role="switch"
                                                    aria-checked={!colOff}
                                                    aria-label={`Share values from ${col.name}`}
                                                    onClick={() => setDraft(d => toggleColumn(d, col.name))}
                                                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${colOff
                                                        ? 'bg-gray-300 dark:bg-slate-600'
                                                        : 'bg-amber-500'}`}
                                                >
                                                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${colOff ? 'left-0.5' : 'left-4.5'}`}
                                                        style={{ left: colOff ? 2 : 18 }} />
                                                </button>
                                                <span className={`text-sm font-semibold ${colOff ? 'text-gray-500 dark:text-slate-500 line-through' : 'text-gray-900 dark:text-white'}`}>
                                                    {col.name}
                                                </span>
                                                <span className="text-[11px] text-gray-500 dark:text-slate-400">
                                                    {colOff
                                                        ? 'switched off — nothing sent'
                                                        : col.truncated
                                                            ? `sending ${liveValues} of ${col.totalDistinct}`
                                                            : `sending ${liveValues} of ${col.totalDistinct}`}
                                                </span>
                                            </div>

                                            {!colOff && (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {col.values.map(v => {
                                                        const off = isValueExcluded(draft, col.name, v);
                                                        return (
                                                            <button
                                                                key={v}
                                                                onClick={() => setDraft(d => toggleValue(d, col.name, v))}
                                                                aria-pressed={!off}
                                                                title={off ? `${v} — switched off` : `${v} — tap to switch off`}
                                                                className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${off
                                                                    ? 'bg-transparent text-gray-400 dark:text-slate-600 border-dashed border-gray-300 dark:border-white/10 line-through'
                                                                    : 'bg-gray-100 dark:bg-slate-700/60 text-gray-700 dark:text-slate-200 border-gray-200 dark:border-white/10 hover:border-amber-400'}`}
                                                            >
                                                                {v}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>

                    {/* Held back automatically */}
                    {withheld.length > 0 && (
                        <section>
                            <div className="flex items-center gap-2 mb-2">
                                <EyeOff className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                                    Already held back for you
                                </h3>
                                <span className="text-xs text-gray-500 dark:text-slate-400">
                                    {withheld.length} column{withheld.length === 1 ? '' : 's'} — values never sent
                                </span>
                            </div>
                            <div className="rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden">
                                {withheld.map((col, i) => (
                                    <div
                                        key={col.name}
                                        className={`flex items-baseline gap-3 px-3 py-2 text-sm ${i % 2 ? 'bg-gray-50 dark:bg-slate-800/40' : ''}`}
                                    >
                                        <span className="font-medium text-gray-800 dark:text-slate-200 shrink-0">{col.name}</span>
                                        <span className="text-xs text-gray-500 dark:text-slate-400">{col.explanation}</span>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="rounded-xl border border-gray-200 dark:border-white/10 p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <Database className="w-4 h-4 text-gray-500 dark:text-slate-400" />
                                <h4 className="text-xs font-bold uppercase tracking-wide text-gray-600 dark:text-slate-300">
                                    Sent in both modes
                                </h4>
                            </div>
                            <ul className="space-y-1.5">
                                {ALWAYS_SENT.map(line => (
                                    <li key={line} className="text-xs text-gray-600 dark:text-slate-400 leading-relaxed">• {line}</li>
                                ))}
                            </ul>
                        </div>
                        <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 dark:bg-emerald-500/5 p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                <h4 className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                                    Never sent, either mode
                                </h4>
                            </div>
                            <ul className="space-y-1.5">
                                {NEVER_SENT.map(line => (
                                    <li key={line} className="text-xs text-gray-700 dark:text-slate-300 leading-relaxed">• {line}</li>
                                ))}
                            </ul>
                        </div>
                    </section>

                    <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">
                        Whatever you leave switched on is sent to the AI provider that writes your SQL.
                        You can change this any time, or go back to Private mode where no values leave your device at all.
                    </p>
                </div>

                {/* Actions */}
                <div className="shrink-0 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 p-4 border-t border-gray-200 dark:border-white/10">
                    <button
                        onClick={onDecline}
                        className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-gray-300 dark:border-white/15 text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
                    >
                        <ShieldCheck className="w-4 h-4" />
                        {mode === 'consent' ? 'No, stay in Private mode' : 'Turn off — back to Private mode'}
                    </button>
                    <button
                        onClick={() => onAgree(draft)}
                        className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-amber-600 hover:bg-amber-700 transition-colors flex items-center justify-center gap-2"
                    >
                        <Check className="w-4 h-4" />
                        {mode === 'consent'
                            ? (allOff ? 'Send nothing, but turn it on' : `Send these ${sendingCount} values`)
                            : 'Save these choices'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default PrivacyConsentDialog;
