import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Pencil, Save, Table2, Undo2, Wand2, X } from 'lucide-react';
import { rowsToCsv, viewLabel, type ItemChanges, type ItemRows } from '../utils/itemRows';
import { fixesFromEdits } from '../utils/rowEdits';
import type { ValueFix } from '../types';

/** What the table needs to let someone change values (admins, in the checklist). */
export interface RowsEditor {
    /** The file's identifier column, if it has one: single-row changes are saved by it. */
    idColumn?: string;
    /** Existing values to suggest for a column. */
    optionsFor: (column: string) => string[];
    /** A number column (changes are read as numbers). */
    isNumber: (column: string) => boolean;
    onSave: (fixes: ValueFix[]) => void;
}

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

function RowsDialog({ title, view, onClose, editor }: { title: string; view: ItemRows | ItemChanges; onClose: () => void; editor?: RowsEditor }) {
    const [page, setPage] = useState(0);
    // Changes typed into the table: row position → new value ('' = blank).
    const [edits, setEdits] = useState<Map<number, string>>(new Map());
    const [saving, setSaving] = useState(false);
    const edit = view.mode === 'rows' && view.source === 'data' && editor ? view.edit : undefined;
    const original = (i: number) => (view.mode === 'rows' ? view.rows[i]?.[edit?.column || ''] : undefined);
    const setEdit = (i: number, value: string) => setEdits(prev => {
        const next = new Map(prev);
        const before = original(i);
        if (value === (before === null || before === undefined ? '' : String(before))) next.delete(i); else next.set(i, value);
        return next;
    });
    const fillUsual = () => {
        if (view.mode !== 'rows' || !edit?.by || !edit.usual) return;
        const next = new Map(edits);
        view.rows.forEach((row, i) => { const usual = edit.usual![String(row[edit.by!])]; if (usual !== undefined && String(row[edit.column]) !== usual) next.set(i, usual); });
        setEdits(next);
    };
    const plan = useMemo(() => (edit && view.mode === 'rows' && edits.size
        ? fixesFromEdits(view.rows, edits, { column: edit.column, by: edit.by, idColumn: editor?.idColumn, isNumber: editor?.isNumber(edit.column) })
        : null), [edit, view, edits, editor]);
    const save = () => {
        if (!plan || !editor) return;
        setSaving(true);
        editor.onSave(plan.fixes);
        onClose();
    };
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
                        {edit?.by && edit.usual && <button type="button" className="qi-chk-undo" onClick={fillUsual}><Wand2 className="h-3.5 w-3.5" aria-hidden /> Fill in the usual {label(edit.column)}</button>}
                        <button type="button" className="qi-chk-undo" onClick={download}><Download className="h-3.5 w-3.5" aria-hidden /> Download these rows</button>
                        <button ref={closeRef} type="button" className="qi-steps-icon" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                    </div>
                </header>
                {edit && (
                    <p className="qi-rows-edit-note"><Pencil className="h-3.5 w-3.5" aria-hidden /> Change any value in <strong>{label(edit.column)}</strong> below. Changes are kept as your fixes: they repeat every time this file is cleaned, and on next month’s file with a saved setup. Undo them from the checklist at any time.</p>
                )}
                {edit && <datalist id="qi-rows-options">{editor!.optionsFor(edit.column).map(v => <option key={v} value={v} />)}</datalist>}
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
                                        const at = page * PAGE + i;
                                        if (edit && c === edit.column) {
                                            const before = row[c];
                                            const value = edits.has(at) ? edits.get(at)! : (before === null || before === undefined ? '' : String(before));
                                            return (
                                                <td key={c} className={`is-hit qi-rows-edit ${edits.has(at) ? 'is-edited' : ''}`}>
                                                    <input value={value} list={editor!.isNumber(c) ? undefined : 'qi-rows-options'} inputMode={editor!.isNumber(c) ? 'decimal' : undefined}
                                                        placeholder="blank" aria-label={`${label(c)} for row ${at + 1}`} onChange={e => setEdit(at, e.target.value)} />
                                                    {edits.has(at) && <button type="button" className="qi-rows-undo" aria-label={`Undo the change in row ${at + 1}`} onClick={() => setEdit(at, before === null || before === undefined ? '' : String(before))}><Undo2 className="h-3 w-3" aria-hidden /></button>}
                                                </td>
                                            );
                                        }
                                        const v = cell(row[c]);
                                        return <td key={c} className={`${hit(c) ? 'is-hit' : ''} ${v.blank ? 'is-blank' : ''} ${v.number ? 'is-num' : ''}`}>{v.text}</td>;
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {plan && (
                    <footer className="qi-rows-save" role="status">
                        <span><strong>{edits.size.toLocaleString('en-GB')} change{edits.size === 1 ? '' : 's'}</strong> · {plan.summary}</span>
                        <div className="flex gap-2">
                            <button type="button" className="qi-chk-undo" onClick={() => setEdits(new Map())}>Discard</button>
                            <button type="button" className="qi-review-apply" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />} Save and clean again</button>
                        </div>
                    </footer>
                )}
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

export const ViewRowsButton: React.FC<{ title: string; view: ItemRows | ItemChanges | null; editor?: RowsEditor }> = ({ title, view, editor }) => {
    const [open, setOpen] = useState(false);
    if (!view) return null;
    return (
        <>
            <button type="button" className="qi-chk-view" onClick={() => setOpen(true)}>
                <Table2 className="h-3.5 w-3.5" aria-hidden /> {viewLabel(view)}{editor && view.mode === 'rows' && view.source === 'data' && view.edit ? ' and fix' : ''}
            </button>
            {open && <RowsDialog title={title} view={view} editor={editor} onClose={() => setOpen(false)} />}
        </>
    );
};
