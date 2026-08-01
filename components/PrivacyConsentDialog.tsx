import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Shield, ShieldCheck, X, Check, Eye, EyeOff, Database } from 'lucide-react';
import type { PrivacyDisclosure } from '../services/ai-sql/privacyDisclosure';
import { ALWAYS_SENT, NEVER_SENT } from '../services/ai-sql/privacyDisclosure';

interface PrivacyConsentDialogProps {
    open: boolean;
    /** Null when no dataset is loaded — the dialog then shows the rules only. */
    disclosure: PrivacyDisclosure | null;
    /**
     * 'consent' — the user is switching on Better answers and must agree first.
     * 'review'  — Better answers is already on; this is a read-only look with
     *             the option to turn it back off.
     */
    mode: 'consent' | 'review';
    onAgree: () => void;
    onDecline: () => void;
    onClose: () => void;
}

const Pill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-100 dark:bg-slate-700/60 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-white/10">
        {children}
    </span>
);

export const PrivacyConsentDialog: React.FC<PrivacyConsentDialogProps> = ({
    open, disclosure, mode, onAgree, onDecline, onClose,
}) => {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        panelRef.current?.focus();
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const shared = disclosure?.shared ?? [];
    const withheld = disclosure?.withheld ?? [];

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
                className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-white/10 shadow-2xl outline-none"
            >
                {/* Header */}
                <div className="shrink-0 flex items-start gap-3 p-5 border-b border-gray-200 dark:border-white/10">
                    <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center shrink-0">
                        <Shield className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 id="privacy-consent-title" className="text-lg font-bold text-gray-900 dark:text-white">
                            {mode === 'consent'
                                ? 'Before you turn on Better answers'
                                : 'What Better answers sends'}
                        </h2>
                        <p className="text-sm text-gray-600 dark:text-slate-400 mt-0.5">
                            {disclosure
                                ? <>Here is exactly what would leave your device from <span className="font-semibold text-gray-800 dark:text-slate-200">{disclosure.datasetName}</span>.</>
                                : 'Load a file to see exactly what would be sent from your own data.'}
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

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* The actual values that would be shared */}
                    <section>
                        <div className="flex items-center gap-2 mb-2">
                            <Eye className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                            <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                                Values that would be sent
                            </h3>
                            {disclosure && (
                                <span className="text-xs text-gray-500 dark:text-slate-400">
                                    {disclosure.totalValuesShared} value{disclosure.totalValuesShared === 1 ? '' : 's'} from {shared.length} column{shared.length === 1 ? '' : 's'}
                                </span>
                            )}
                        </div>

                        {shared.length === 0 ? (
                            <p className="text-sm text-gray-600 dark:text-slate-400 bg-gray-50 dark:bg-slate-800/60 rounded-xl p-3 border border-gray-200 dark:border-white/10">
                                {disclosure
                                    ? 'Nothing. No column in this file qualifies, so Better answers would send exactly the same as Private mode.'
                                    : 'This depends on your file. Nothing is sent from columns holding names, IDs, dates, numbers or anything sensitive.'}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {shared.map(col => (
                                    <div
                                        key={col.name}
                                        className="rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/5 p-3"
                                    >
                                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                            <span className="text-sm font-semibold text-gray-900 dark:text-white">{col.name}</span>
                                            <span className="text-[11px] text-gray-500 dark:text-slate-400">
                                                {col.truncated
                                                    ? `${col.values.length} of ${col.totalDistinct} values`
                                                    : `all ${col.totalDistinct} value${col.totalDistinct === 1 ? '' : 's'}`}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {col.values.slice(0, 24).map(v => <Pill key={v}>{v}</Pill>)}
                                            {col.values.length > 24 && (
                                                <span className="text-[11px] text-gray-500 dark:text-slate-400 self-center">
                                                    + {col.values.length - 24} more
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Held back, with the reason */}
                    {withheld.length > 0 && (
                        <section>
                            <div className="flex items-center gap-2 mb-2">
                                <EyeOff className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                                <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                                    Columns held back
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

                    {/* The rules, both modes */}
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
                        Values are sent to the AI provider that writes your SQL. You can turn this off
                        at any time and go back to Private mode, where no values at all leave your device.
                    </p>
                </div>

                {/* Actions */}
                <div className="shrink-0 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 p-4 border-t border-gray-200 dark:border-white/10">
                    {mode === 'consent' ? (
                        <>
                            <button
                                onClick={onDecline}
                                className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-gray-300 dark:border-white/15 text-gray-700 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                            >
                                No, stay in Private mode
                            </button>
                            <button
                                onClick={onAgree}
                                className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-amber-600 hover:bg-amber-700 transition-colors flex items-center justify-center gap-2"
                            >
                                <Check className="w-4 h-4" />
                                I agree — send these values
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={onDecline}
                                className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-emerald-300 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-2"
                            >
                                <ShieldCheck className="w-4 h-4" />
                                Turn this off — back to Private mode
                            </button>
                            <button
                                onClick={onClose}
                                className="px-5 py-2.5 rounded-xl text-sm font-bold text-white bg-gray-800 dark:bg-slate-700 hover:bg-gray-900 dark:hover:bg-slate-600 transition-colors"
                            >
                                Keep it on
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default PrivacyConsentDialog;
