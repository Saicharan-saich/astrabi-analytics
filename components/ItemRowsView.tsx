import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Table2, X } from 'lucide-react';
import { rowsToCsv, viewLabel, type ItemChanges, type ItemRows } from '../utils/itemRows';

/**
 * "View rows" on a checklist item: a button that opens every row the item is
 * about in a tidy table, the column it concerns first and highlighted.
 */
const PAGE = 50;
const LONG_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const label = (name: string) => name.replace(/_/g, ' ');

function cell(value: unknown): { text: string; blank: boolean; number: boolean } {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { text: 'blank', blank: true, number: false };
    if (typeof value === 'number') return { text: value.toLocaleString('en-GB', { maximumFractionDigits: 4 }), blank: false, number: true };
    if (value instanceof Date || (typeof value === 'string' && LONG_DATE.test(value))) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isNaN(date.getTime())) return { text: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), blank: false, number: false };
    }
    return { text: String(value), blank: false, number: false };
}

function sourceLine(view: ItemRows | ItemChanges): string {
    const n = (x: number) => x.toLocaleString('en-GB');
    if (view.mode === 'changes') return view.total > view.changes.length
        ? `Examples of the values this step changed: ${n(view.changes.length)} of ${n(view.total)}.`
        : 'Every value this step changed, before and after.';
    if (view.source === 'data') return `All ${n(view.total)} row${view.total === 1 ? '' : 's'}, straight from your cleaned data. Viewing changes nothing.`;
    if (view.source === 'removed') return view.rows.length < view.total
        ? `These rows were taken out of the analysis. The first ${n(view.rows.length)} of ${n(view.total)} were kept to show here.`
        : 'These rows were taken out of the analysis. Undo the step to put them back.';
    return view.rows.length < view.total
        ? `${n(view.rows.length)} of the ${n(view.total)} rows this is about, kept to show here.`
        : `The ${n(view.total)} row${view.total === 1 ? '' : 's'} this is about.`;
}

function RowsDialog({ title, view, onClose }: { title: string; view: ItemRows | ItemChanges; onClose: () => void }) {
    const [page, setPage] = useState(0);
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const columns = useMemo(() => {
        if (view.mode === 'changes') return ['column', 'before', 'after'];
        const seen = new Set<string>();
        for (const row of view.rows.slice(0, 200)) for (const key of Object.keys(row)) if (!key.startsWith('__')) seen.add(key);
        const first = view.highlight.filter(h => seen.has(h));
        return [...first, ...[...seen].filter(k => !first.includes(k))];
    }, [view]);
    const all: Record<string, unknown>[] = view.mode === 'changes'
        ? view.changes.map(c => ({ column: label(c.column), before: c.before, after: c.after }))
        : view.rows;
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    const shown = all.slice(page * PAGE, page * PAGE + PAGE);
    const hit = (column: string) => (view.mode === 'changes' ? column === 'after' : view.highlight.includes(column));

    const download = () => {
        const blob = new Blob([rowsToCsv(all, columns)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'rows'}.csv`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <div className="qi-handover-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <section className="qi-rows" role="dialog" aria-modal="true" aria-labelledby="qi-rows-title">
                <header className="qi-rows-head">
                    <div className="min-w-0">
                        <h2 id="qi-rows-title">{title}</h2>
                        <p>{sourceLine(view)}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        <button type="button" className="qi-chk-undo" onClick={download}><Download className="h-3.5 w-3.5" aria-hidden /> Download these rows</button>
                        <button ref={closeRef} type="button" className="qi-steps-icon" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                    </div>
                </header>
                <div className="qi-rows-table" tabIndex={0} aria-label={`${title}: table`}>
                    <table>
                        <thead>
                            <tr>
                                <th className="qi-rows-num" scope="col">#</th>
                                {columns.map(c => <th key={c} scope="col" className={hit(c) ? 'is-hit' : ''}>{label(c)}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((row, i) => (
                                <tr key={page * PAGE + i}>
                                    <td className="qi-rows-num">{(page * PAGE + i + 1).toLocaleString('en-GB')}</td>
                                    {columns.map(c => {
                                        const v = cell(row[c]);
                                        return <td key={c} className={`${hit(c) ? 'is-hit' : ''} ${v.blank ? 'is-blank' : ''} ${v.number ? 'is-num' : ''}`}>{v.text}</td>;
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {pages > 1 && (
                    <footer className="qi-rows-pager">
                        <span>Rows {(page * PAGE + 1).toLocaleString('en-GB')}–{Math.min(all.length, page * PAGE + PAGE).toLocaleString('en-GB')} of {all.length.toLocaleString('en-GB')}</span>
                        <div className="flex gap-1">
                            <button type="button" className="qi-steps-icon" aria-label="Previous rows" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></button>
                            <button type="button" className="qi-steps-icon" aria-label="Next rows" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></button>
                        </div>
                    </footer>
                )}
            </section>
        </div>
    );
}

export const ViewRowsButton: React.FC<{ title: string; view: ItemRows | ItemChanges | null }> = ({ title, view }) => {
    const [open, setOpen] = useState(false);
    if (!view) return null;
    return (
        <>
            <button type="button" className="qi-chk-view" onClick={() => setOpen(true)}>
                <Table2 className="h-3.5 w-3.5" aria-hidden /> {viewLabel(view)}
            </button>
            {open && <RowsDialog title={title} view={view} onClose={() => setOpen(false)} />}
        </>
    );
};
