import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Undo2, X } from 'lucide-react';
import type { Dataset, ETLLog } from '../types';
import { ChangeItem, ChangeKind, cleanedByOlderVersion, summariseEtlChanges } from '../utils/etlChangeSummary';

interface CleaningChangesPanelProps {
    dataset: Dataset;
    /** Re-runs the cleaning with one step reversed (or restored). */
    onRevert?: (revert: NonNullable<ETLLog['revert']>) => void;
    /** The option currently being re-run, so its button shows progress. */
    pendingOption?: string | null;
    /** Always shown (no dismiss), e.g. at the top of the full cleaning log. */
    persistent?: boolean;
    /** Re-runs the current cleaning on the original upload. */
    onReclean?: () => void;
}

const SECTIONS: { kind: ChangeKind; label: string; tone: string }[] = [
    { kind: 'removed', label: 'Removed', tone: 'is-neutral' },
    { kind: 'added', label: 'Columns added or reshaped', tone: 'is-neutral' },
    { kind: 'converted', label: 'Values corrected', tone: 'is-good' },
    { kind: 'check', label: 'Worth checking', tone: 'is-attention' },
    { kind: 'kept', label: 'Left as uploaded', tone: 'is-neutral' },
];

const dismissKey = (dataset: Dataset) => `qi:cleaning-panel:${dataset.id}:${dataset.version || 1}`;
const readDismissed = (key: string) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const writeDismissed = (key: string) => { try { localStorage.setItem(key, '1'); } catch { /* storage unavailable */ } };

const LONG_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT/;
/** Dates as people write them: "29 May 2026" (with the time only when there is one). */
function cellText(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    const date = value instanceof Date ? value
        : typeof value === 'string' && (LONG_DATE.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) {
        const midnight = date.getHours() === 0 && date.getMinutes() === 0;
        return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', ...(midnight ? {} : { hour: '2-digit', minute: '2-digit' }) });
    }
    return String(value);
}

function SampleRows({ rows }: { rows: Record<string, any>[] }) {
    const keys = Object.keys(rows[0] || {}).slice(0, 6);
    if (!keys.length) return null;
    return (
        <div className="qi-clean-samples mt-2 overflow-x-auto rounded-lg">
            <table className="w-full text-[11px]">
                <thead>
                    <tr>{keys.map(k => <th key={k} className="px-2 py-1 text-left font-semibold whitespace-nowrap">{k}</th>)}</tr>
                </thead>
                <tbody>
                    {rows.slice(0, 3).map((row, i) => (
                        <tr key={i}>{keys.map(k => <td key={k} className="px-2 py-1 whitespace-nowrap">{cellText(row[k])}</td>)}</tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ChangeRow({ item, onRevert, pending, busy }: { item: ChangeItem; onRevert?: CleaningChangesPanelProps['onRevert']; pending: boolean; busy: boolean }) {
    const [open, setOpen] = useState(false);
    return (
        <li className="qi-clean-item py-2.5">
            <div className="qi-clean-row flex items-start gap-3">
                <button type="button" onClick={() => setOpen(v => !v)} className="qi-clean-toggle mt-0.5 shrink-0" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'}>
                    {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                <button type="button" onClick={() => setOpen(v => !v)} className="qi-clean-title flex-1 min-w-0 text-left text-[13px] font-medium leading-5">
                    {item.title}
                </button>
                {item.revert && onRevert && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRevert(item.revert!)}
                        className="qi-clean-undo shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold"
                    >
                        {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                        {item.revert.label}
                    </button>
                )}
            </div>
            {open && (
                <div className="pl-[26px] pt-1">
                    <p className="qi-clean-detail text-[12px] leading-5">{item.detail}</p>
                    {item.samples && item.samples.length > 0 && <SampleRows rows={item.samples} />}
                </div>
            )}
        </li>
    );
}

/**
 * Plain account of what the automatic cleaning changed in the upload, with a
 * way to reverse each reversible step. Shown at the top of the dataset
 * workspace until dismissed for this version of the data.
 */
export const CleaningChangesPanel: React.FC<CleaningChangesPanelProps> = ({ dataset, onRevert, pendingOption, persistent = false, onReclean }) => {
    const summary = useMemo(() => summariseEtlChanges(dataset.etlLogs), [dataset.etlLogs]);
    const older = useMemo(() => cleanedByOlderVersion(dataset.etlLogs), [dataset.etlLogs]);
    const reversible = summary.items.filter(item => item.revert).length;
    const key = dismissKey(dataset);
    const [dismissed, setDismissed] = useState(() => readDismissed(key));
    const [lastKey, setLastKey] = useState(key);
    const [expanded, setExpanded] = useState(true);
    if (key !== lastKey) { setLastKey(key); setDismissed(readDismissed(key)); }

    if ((dismissed && !persistent) || summary.items.length === 0) return null;
    const { rowsBefore, rowsAfter } = summary;

    return (
        <section className="qi-clean-panel rounded-xl" aria-label="What we changed">
            <header className="qi-clean-head flex items-start gap-3 px-5 pt-4 pb-3">
                <div className="flex-1 min-w-0">
                    <h3 className="qi-clean-heading text-[15px] font-semibold">What we changed</h3>
                    <p className="qi-clean-sub text-[12.5px] mt-0.5">
                        {rowsBefore !== undefined && rowsAfter !== undefined && rowsBefore !== rowsAfter
                            ? `${rowsBefore.toLocaleString()} rows uploaded → ${rowsAfter.toLocaleString()} analysed. `
                            : ''}
                        {summary.headline}.{' '}
                        {!onRevert ? '' : reversible === summary.items.length ? 'Each change can be reversed.' : reversible > 0 ? `${reversible} of these can be reversed; the rest are needed to read the file.` : ''}
                    </p>
                </div>
                <button type="button" onClick={() => setExpanded(v => !v)} className="qi-clean-link text-[12px] font-semibold px-2 py-1">
                    {expanded ? 'Collapse' : 'Show'}
                </button>
                {!persistent && (
                    <button type="button" onClick={() => { writeDismissed(key); setDismissed(true); }} className="qi-clean-toggle p-1 rounded-md" aria-label="Dismiss" title="Hide until the data changes (still under Cleaning)">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </header>
            {older.stale && (
                <div className="qi-clean-older mx-5 mb-3 rounded-lg px-4 py-3" role="status">
                    <div className="min-w-0">
                        <strong>This data was cleaned by an earlier version of QuickInsight.</strong>
                        <p>
                            {older.blankKeyDuplicates > 0
                                ? `That version removed ${older.blankKeyDuplicates} rows as duplicates only because their ID was blank, and its changes cannot be undone. `
                                : 'Its changes cannot be undone here. '}
                            {onReclean
                                ? 'Re-clean it with the current rules: your original upload is kept, so nothing is lost, and every change will have an undo.'
                                : 'Upload the file again to clean it with the current rules, where every change has an undo.'}
                        </p>
                    </div>
                    {onReclean && (
                        <button type="button" className="qi-clean-reclean" onClick={onReclean} disabled={Boolean(pendingOption)}>
                            {pendingOption === '__reclean__' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden />}
                            {pendingOption === '__reclean__' ? 'Re-cleaning…' : 'Re-clean with current rules'}
                        </button>
                    )}
                </div>
            )}
            {expanded && (
                <div className="grid gap-x-8 gap-y-1 px-5 pb-4 md:grid-cols-2">
                    {SECTIONS.map(section => {
                        const list = summary.byKind[section.kind];
                        if (!list.length) return null;
                        return (
                            <div key={section.kind} className="min-w-0">
                                <div className="flex items-center gap-2 pt-2">
                                    <span className={`qi-report-chip ${section.tone}`}>{list.length}</span>
                                    <h4 className="qi-clean-section text-[11px] font-semibold uppercase tracking-wider">{section.label}</h4>
                                </div>
                                <ul className="qi-clean-list">
                                    {list.map(item => (
                                        <ChangeRow key={item.id} item={item} onRevert={onRevert} pending={Boolean(pendingOption) && pendingOption === item.revert?.option} busy={Boolean(pendingOption)} />
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
};
