import React, { useEffect, useMemo, useState } from 'react';
import {
    ArrowUpDown, Calculator, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Columns3, Copy, Eye, EyeOff,
    Filter, GitBranch, Info, Layers, Link2, Loader2, Pencil, Plus, Ruler, Search, SlidersHorizontal, Tag, Trash2, Type, X,
} from 'lucide-react';
import { ColumnType, type CleaningStep, type ColumnDefinition, type Dataset, type EtlOptions, type FilterOp, type StepKind } from '../types';
import { applySteps, describeStep, newStep, STEP_GROUPS, stepProblem, type StepResult } from '../services/cleaningSteps';

/**
 * Your steps — clean by hand, Power Query style, for people who are not data
 * specialists. Every action is a recorded step in a list: edit it, move it,
 * switch it off, say why it is there. A live preview shows the table after the
 * steps. "Apply" re-cleans the whole file with them, and from then on they run
 * on every new file, and they are saved with the client's setup.
 */

interface Props {
    dataset: Dataset;
    onApply?: (nextOptions: EtlOptions, label: string) => void;
    pending?: string | null;
}

const ICONS: Record<StepKind, React.ComponentType<{ className?: string }>> = {
    filter_rows: Filter, remove_duplicates: Copy, remove_columns: Trash2, keep_columns: Columns3, rename_column: Pencil,
    change_type: SlidersHorizontal, fill_blanks: CircleDashed, find_replace: Search, group_values: Tag, tidy_text: Type,
    round_numbers: Ruler, split_column: GitBranch, join_columns: Link2, calculated_column: Calculator, date_part: CalendarDays,
    unpivot: ArrowUpDown, group_by: Layers,
};
const KIND_LABEL: Record<string, string> = Object.fromEntries(STEP_GROUPS.flatMap(g => g.kinds.map(k => [k.kind, k.label])));
const TYPE_WORD: Record<string, string> = { METRIC: 'Number', DIMENSION: 'Category', DATE: 'Date', ID: 'Identifier', BOOLEAN: 'Yes/No' };
const PREVIEW_ROWS = 40;
const label = (name: string) => name.replace(/_/g, ' ');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/* ── small inputs ─────────────────────────────────────────────────── */

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="qi-steps-field">
            <span className="qi-steps-label">{title}</span>
            {children}
            {hint && <span className="qi-steps-hint">{hint}</span>}
        </label>
    );
}

function ColumnSelect({ value, columns, onChange, only, ariaLabel }: { value?: string; columns: ColumnDefinition[]; onChange: (v: string) => void; only?: ColumnType[]; ariaLabel?: string }) {
    const list = only ? columns.filter(c => only.includes(c.type)) : columns;
    return (
        <select className="qi-steps-input" value={value || ''} onChange={e => onChange(e.target.value)} aria-label={ariaLabel}>
            {!value && <option value="">Pick a column</option>}
            {list.map(c => <option key={c.name} value={c.name}>{label(c.name)} · {TYPE_WORD[c.type] || c.type}</option>)}
            {value && !list.some(c => c.name === value) && <option value={value}>{label(value)} (not in this file)</option>}
        </select>
    );
}

function ColumnPicker({ value = [], columns, onChange, only }: { value?: string[]; columns: ColumnDefinition[]; onChange: (v: string[]) => void; only?: ColumnType[] }) {
    const list = only ? columns.filter(c => only.includes(c.type)) : columns;
    const toggle = (name: string) => onChange(value.includes(name) ? value.filter(v => v !== name) : [...value, name]);
    return (
        <div className="qi-steps-chips" role="group">
            {list.map(c => (
                <button key={c.name} type="button" aria-pressed={value.includes(c.name)} className={value.includes(c.name) ? 'is-on' : ''} onClick={() => toggle(c.name)}>
                    {value.includes(c.name) && <Check className="h-3 w-3" aria-hidden />}{label(c.name)}
                </button>
            ))}
            {!list.length && <span className="qi-steps-hint">No columns of this kind.</span>}
        </div>
    );
}

const Text = ({ value, onChange, placeholder, ariaLabel }: { value?: string; onChange: (v: string) => void; placeholder?: string; ariaLabel?: string }) => (
    <input className="qi-steps-input" value={value ?? ''} placeholder={placeholder} aria-label={ariaLabel} onChange={e => onChange(e.target.value)} />
);

const OPS: { op: FilterOp; text: string; numbers?: boolean; texts?: boolean }[] = [
    { op: 'blank', text: 'is blank' }, { op: 'not_blank', text: 'is not blank' },
    { op: 'equals', text: 'is' }, { op: 'not_equals', text: 'is not' },
    { op: 'contains', text: 'contains', texts: true }, { op: 'not_contains', text: 'does not contain', texts: true },
    { op: 'starts_with', text: 'starts with', texts: true }, { op: 'ends_with', text: 'ends with', texts: true },
    { op: 'one_of', text: 'is one of (comma-separated)', texts: true },
    { op: 'greater', text: 'is more than', numbers: true }, { op: 'greater_eq', text: 'is at least', numbers: true },
    { op: 'less', text: 'is less than', numbers: true }, { op: 'less_eq', text: 'is at most', numbers: true },
    { op: 'between', text: 'is between', numbers: true },
];

/** The most common values of a column (for suggestions and grouping). */
function topValues(rows: Record<string, any>[], column?: string, limit = 40): { value: string; count: number }[] {
    if (!column) return [];
    const counts = new Map<string, number>();
    for (const row of rows) {
        const v = row[column];
        if (v === null || v === undefined || v === '') continue;
        const k = String(v);
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, limit);
}

/* ── the form for one step ────────────────────────────────────────── */

function StepForm({ step, columns, rows, onChange }: { step: CleaningStep; columns: ColumnDefinition[]; rows: Record<string, any>[]; onChange: (s: CleaningStep) => void }) {
    const set = (patch: Partial<CleaningStep>) => onChange({ ...step, ...patch });
    const column = columns.find(c => c.name === step.column);
    const numbersOrDates = column?.type === ColumnType.METRIC || column?.type === ColumnType.DATE;
    const values = useMemo(() => topValues(rows, step.column), [rows, step.column]);

    switch (step.kind) {
        case 'filter_rows': {
            const ops = OPS.filter(o => (o.numbers ? numbersOrDates : true) && (o.texts ? !numbersOrDates || column?.type === ColumnType.DATE : true));
            const needsValue = step.op !== 'blank' && step.op !== 'not_blank';
            return (
                <>
                    <div className="qi-steps-row">
                        <Field title="Rows to"><select className="qi-steps-input" aria-label="Rows to" value={step.action || 'remove'} onChange={e => set({ action: e.target.value as 'keep' | 'remove' })}><option value="remove">Remove</option><option value="keep">Keep only</option></select></Field>
                        <Field title="Where"><ColumnSelect ariaLabel="Where" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field>
                        <Field title="Condition"><select className="qi-steps-input" aria-label="Condition" value={step.op || 'blank'} onChange={e => set({ op: e.target.value as FilterOp })}>{ops.map(o => <option key={o.op} value={o.op}>{o.text}</option>)}</select></Field>
                    </div>
                    {needsValue && (
                        <div className="qi-steps-row">
                            <Field title={step.op === 'between' ? 'From' : 'Value'} hint={column?.type === ColumnType.DATE ? 'Dates as 2026-01-31' : undefined}>
                                <input className="qi-steps-input" aria-label={step.op === 'between' ? 'From' : 'Value'} list={`values-${step.id}`} value={step.value ?? ''} onChange={e => set({ value: e.target.value })} />
                                <datalist id={`values-${step.id}`}>{values.map(v => <option key={v.value} value={v.value} />)}</datalist>
                            </Field>
                            {step.op === 'between' && <Field title="To"><Text ariaLabel="To" value={step.value2} onChange={v => set({ value2: v })} /></Field>}
                        </div>
                    )}
                </>
            );
        }
        case 'remove_duplicates':
            return (
                <>
                    <Field title="Rows count as repeats when these columns match" hint="Pick none to compare whole rows."><ColumnPicker value={step.columns} columns={columns} onChange={v => set({ columns: v })} /></Field>
                    <Field title="Keep"><select className="qi-steps-input" aria-label="Keep" value={step.keepCopy || 'first'} onChange={e => set({ keepCopy: e.target.value as 'first' | 'last' })}><option value="first">The first copy</option><option value="last">The last copy</option></select></Field>
                </>
            );
        case 'remove_columns': case 'keep_columns':
            return <Field title={step.kind === 'remove_columns' ? 'Columns to remove' : 'Columns to keep'}><ColumnPicker value={step.columns} columns={columns} onChange={v => set({ columns: v })} /></Field>;
        case 'rename_column':
            return <div className="qi-steps-row"><Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field><Field title="New name"><Text ariaLabel="Column" value={step.to} onChange={v => set({ to: v })} placeholder="e.g. Customer" /></Field></div>;
        case 'change_type':
            return (
                <div className="qi-steps-row">
                    <Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field>
                    <Field title="Treat it as" hint="Numbers are added up; categories group; dates drive trends; identifiers are counted.">
                        <select className="qi-steps-input" aria-label="Treat it as" value={step.to || ColumnType.DIMENSION} onChange={e => set({ to: e.target.value })}>
                            {[ColumnType.METRIC, ColumnType.DIMENSION, ColumnType.DATE, ColumnType.BOOLEAN, ColumnType.ID].map(t => <option key={t} value={t}>{TYPE_WORD[t]}</option>)}
                        </select>
                    </Field>
                </div>
            );
        case 'fill_blanks': {
            const numeric = column?.type === ColumnType.METRIC;
            return (
                <div className="qi-steps-row">
                    <Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field>
                    <Field title="Fill with">
                        <select className="qi-steps-input" aria-label="Fill with" value={step.fill || 'zero'} onChange={e => set({ fill: e.target.value as CleaningStep['fill'] })}>
                            {numeric && <option value="zero">0</option>}
                            <option value="value">A value I type</option>
                            <option value="down">The value in the row above</option>
                            <option value="up">The value in the row below</option>
                            {numeric && <option value="average">The average</option>}
                            {numeric && <option value="median">The middle value</option>}
                            <option value="most_common">The most common value</option>
                        </select>
                    </Field>
                    {step.fill === 'value' && <Field title="Value"><Text ariaLabel="Value" value={step.value} onChange={v => set({ value: v })} placeholder={numeric ? 'e.g. 0' : 'e.g. Online'} /></Field>}
                </div>
            );
        }
        case 'find_replace':
            return (
                <>
                    <div className="qi-steps-row">
                        <Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field>
                        <Field title="Find"><Text ariaLabel="Find" value={step.find} onChange={v => set({ find: v })} placeholder="e.g. Ltd." /></Field>
                        <Field title="Replace with" hint="Leave empty to delete it."><Text ariaLabel="Replace with" value={step.replace} onChange={v => set({ replace: v })} placeholder="e.g. Ltd" /></Field>
                    </div>
                    <div className="qi-steps-checks">
                        <label><input type="checkbox" checked={Boolean(step.wholeCell)} onChange={e => set({ wholeCell: e.target.checked })} /> Only when it is the whole cell</label>
                        <label><input type="checkbox" checked={Boolean(step.matchCase)} onChange={e => set({ matchCase: e.target.checked })} /> Capitals must match</label>
                    </div>
                </>
            );
        case 'group_values': {
            const group = step.groups?.[0] || { from: [], to: '' };
            const setGroup = (patch: Partial<typeof group>) => set({ groups: [{ ...group, ...patch }] });
            return (
                <>
                    <Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v, groups: [{ from: [], to: '' }] })} only={[ColumnType.DIMENSION, ColumnType.ID, ColumnType.BOOLEAN]} /></Field>
                    <Field title="Values to group together" hint="The most common values; the number is how many rows have it.">
                        <div className="qi-steps-chips" role="group">
                            {values.map(v => {
                                const on = group.from.includes(v.value);
                                return <button key={v.value} type="button" aria-pressed={on} className={on ? 'is-on' : ''} onClick={() => setGroup({ from: on ? group.from.filter(x => x !== v.value) : [...group.from, v.value] })}>{on && <Check className="h-3 w-3" aria-hidden />}{v.value} <span className="qi-steps-count">{v.count}</span></button>;
                            })}
                        </div>
                    </Field>
                    <Field title="Count them as"><Text ariaLabel="Count them as" value={group.to} onChange={v => setGroup({ to: v })} placeholder="e.g. North West" /></Field>
                </>
            );
        }
        case 'tidy_text':
            return (
                <>
                    <Field title="Columns" hint="Extra spaces are always removed."><ColumnPicker value={step.columns} columns={columns} onChange={v => set({ columns: v })} only={[ColumnType.DIMENSION, ColumnType.ID]} /></Field>
                    <Field title="Capitals">
                        <select className="qi-steps-input" aria-label="Capitals" value={step.textCase || 'keep'} onChange={e => set({ textCase: e.target.value as CleaningStep['textCase'] })}>
                            <option value="keep">Leave as they are</option><option value="title">Title Case</option><option value="sentence">Sentence case</option><option value="upper">CAPITALS</option><option value="lower">lower case</option>
                        </select>
                    </Field>
                </>
            );
        case 'round_numbers':
            return <div className="qi-steps-row"><Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} only={[ColumnType.METRIC]} /></Field><Field title="Decimal places"><input className="qi-steps-input" aria-label="Column" type="number" min={0} max={6} value={step.decimals ?? 2} onChange={e => set({ decimals: Number(e.target.value) })} /></Field></div>;
        case 'split_column':
            return (
                <>
                    <div className="qi-steps-row">
                        <Field title="Column"><ColumnSelect ariaLabel="Column" value={step.column} columns={columns} onChange={v => set({ column: v })} /></Field>
                        <Field title="Split at">
                            <select className="qi-steps-input" aria-label="Split at" value={step.separator ?? ','} onChange={e => set({ separator: e.target.value })}>
                                <option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value=" ">Space</option><option value="-">Dash -</option><option value="/">Slash /</option><option value="|">Bar |</option>
                            </select>
                        </Field>
                    </div>
                    <Field title="Names of the new columns" hint="Comma-separated, e.g. Last name, First name. Leave empty for automatic names.">
                        <Text value={(step.names || []).join(', ')} onChange={v => set({ names: v.split(',').map(x => x.trim()).filter(Boolean) })} />
                    </Field>
                    <div className="qi-steps-checks"><label><input type="checkbox" checked={Boolean(step.keepOriginal)} onChange={e => set({ keepOriginal: e.target.checked })} /> Keep the original column too</label></div>
                </>
            );
        case 'join_columns':
            return (
                <>
                    <Field title="Columns, in order" hint="Blank cells are left out."><ColumnPicker value={step.columns} columns={columns} onChange={v => set({ columns: v })} /></Field>
                    <div className="qi-steps-row">
                        <Field title="Put between them"><select className="qi-steps-input" aria-label="Put between them" value={step.separator ?? ' '} onChange={e => set({ separator: e.target.value })}><option value=" ">A space</option><option value=", ">Comma and space</option><option value=" - ">A dash</option><option value=" / ">A slash</option><option value="">Nothing</option></select></Field>
                        <Field title="Name of the new column"><Text ariaLabel="Name of the new column" value={step.name} onChange={v => set({ name: v })} placeholder="e.g. Full name" /></Field>
                    </div>
                    <div className="qi-steps-checks"><label><input type="checkbox" checked={step.keepOriginal !== false} onChange={e => set({ keepOriginal: e.target.checked })} /> Keep the original columns</label></div>
                </>
            );
        case 'calculated_column': {
            const useNumber = step.rightColumn === undefined;
            return (
                <>
                    <div className="qi-steps-row">
                        <Field title="Take"><ColumnSelect ariaLabel="Take" value={step.column} columns={columns} onChange={v => set({ column: v })} only={[ColumnType.METRIC]} /></Field>
                        <Field title="Then">
                            <select className="qi-steps-input" aria-label="Then" value={step.operator || '-'} onChange={e => set({ operator: e.target.value as CleaningStep['operator'] })}>
                                <option value="+">add</option><option value="-">subtract</option><option value="*">multiply by</option><option value="/">divide by</option><option value="pct_of">as a % of</option><option value="pct_change">% change from</option>
                            </select>
                        </Field>
                        <Field title={useNumber ? 'A number' : 'Another column'}>
                            {useNumber
                                ? <input className="qi-steps-input" aria-label="A number" type="number" value={step.rightNumber ?? ''} onChange={e => set({ rightNumber: e.target.value === '' ? undefined : Number(e.target.value) })} />
                                : <ColumnSelect ariaLabel="Another column" value={step.rightColumn} columns={columns} onChange={v => set({ rightColumn: v })} only={[ColumnType.METRIC]} />}
                        </Field>
                    </div>
                    <div className="qi-steps-checks"><label><input type="checkbox" checked={useNumber} onChange={e => set(e.target.checked ? { rightColumn: undefined, rightNumber: step.rightNumber ?? 1 } : { rightColumn: columns.find(c => c.type === ColumnType.METRIC && c.name !== step.column)?.name || '', rightNumber: undefined })} /> Use a number instead of a column</label></div>
                    <Field title="Name of the new column"><Text ariaLabel="Name of the new column" value={step.name} onChange={v => set({ name: v })} placeholder="e.g. Profit" /></Field>
                </>
            );
        }
        case 'date_part':
            return (
                <div className="qi-steps-row">
                    <Field title="Date column"><ColumnSelect ariaLabel="Date column" value={step.column} columns={columns} onChange={v => set({ column: v })} only={[ColumnType.DATE]} /></Field>
                    <Field title="Take its">
                        <select className="qi-steps-input" aria-label="Take its" value={step.part || 'month_name'} onChange={e => set({ part: e.target.value as CleaningStep['part'] })}>
                            <option value="year">Year (2026)</option><option value="quarter">Quarter (2026 Q1)</option><option value="year_month">Year and month (2026-01)</option><option value="month_name">Month name (January)</option><option value="month">Month number (01)</option><option value="week">Week (2026-W05)</option><option value="weekday">Day of the week (Monday)</option><option value="day">Day of the month (31)</option>
                        </select>
                    </Field>
                    <Field title="Name of the new column"><Text ariaLabel="Name of the new column" value={step.name} onChange={v => set({ name: v })} placeholder="e.g. Order month" /></Field>
                </div>
            );
        case 'unpivot':
            return (
                <>
                    <Field title="Columns to turn into rows" hint="e.g. one column per month. Each becomes a row with its name and its value."><ColumnPicker value={step.columns} columns={columns} onChange={v => set({ columns: v })} /></Field>
                    <div className="qi-steps-row">
                        <Field title="Call the names column"><Text ariaLabel="Call the names column" value={step.to} onChange={v => set({ to: v })} placeholder="e.g. Month" /></Field>
                        <Field title="Call the values column"><Text ariaLabel="Call the values column" value={step.name} onChange={v => set({ name: v })} placeholder="e.g. Sales" /></Field>
                    </div>
                </>
            );
        case 'group_by': {
            const totals = step.totals || [];
            const setTotal = (i: number, patch: Partial<(typeof totals)[number]>) => set({ totals: totals.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
            return (
                <>
                    <p className="qi-steps-warn"><Info className="h-3.5 w-3.5" aria-hidden /> After this step a row is one group, not one record. Everything after it, and every answer, uses the totals.</p>
                    <Field title="One row for each"><ColumnPicker value={step.groupBy} columns={columns} onChange={v => set({ groupBy: v })} only={[ColumnType.DIMENSION, ColumnType.DATE, ColumnType.ID, ColumnType.BOOLEAN]} /></Field>
                    <span className="qi-steps-label">With these totals</span>
                    {totals.map((t, i) => (
                        <div key={i} className="qi-steps-row is-tight">
                            <select className="qi-steps-input" aria-label="How" value={t.how} onChange={e => setTotal(i, { how: e.target.value as typeof t.how })}>
                                <option value="sum">Total of</option><option value="average">Average of</option><option value="count">Number of rows</option><option value="count_distinct">Number of different</option><option value="min">Lowest</option><option value="max">Highest</option>
                            </select>
                            {t.how !== 'count' && <ColumnSelect value={t.column} columns={columns} onChange={v => setTotal(i, { column: v })} only={t.how === 'count_distinct' ? undefined : [ColumnType.METRIC]} ariaLabel="Of column" />}
                            <input className="qi-steps-input" aria-label="Name" placeholder="Name (optional)" value={t.name} onChange={e => setTotal(i, { name: e.target.value })} />
                            <button type="button" className="qi-steps-icon" aria-label="Remove this total" onClick={() => set({ totals: totals.filter((_x, j) => j !== i) })}><X className="h-3.5 w-3.5" /></button>
                        </div>
                    ))}
                    <button type="button" className="qi-chk-more" onClick={() => set({ totals: [...totals, { column: columns.find(c => c.type === ColumnType.METRIC)?.name || '', how: 'sum', name: '' }] })}><Plus className="h-3.5 w-3.5" aria-hidden /> Add a total</button>
                </>
            );
        }
        default: return null;
    }
}

/* ── preview ──────────────────────────────────────────────────────── */

function cell(v: unknown, type?: ColumnType): string {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    return type === ColumnType.DATE ? String(v).slice(0, 10) : String(v);
}

function Preview({ rows, columns, highlight, total, truncated }: { rows: Record<string, any>[]; columns: ColumnDefinition[]; highlight: string[]; total: number; truncated: boolean }) {
    const shown = columns.filter(c => !c.name.startsWith('__'));
    return (
        <section className="qi-steps-preview" aria-label="Preview">
            <header>
                <strong>Preview</strong>
                <span>{total.toLocaleString('en-GB')} row{total === 1 ? '' : 's'}{truncated ? ' in the first 5,000 rows of your file' : ''} · {shown.length} columns · showing the first {Math.min(PREVIEW_ROWS, rows.length)}</span>
            </header>
            <div className="qi-steps-grid">
                <table>
                    <thead>
                        <tr>{shown.map(c => <th key={c.name} className={highlight.includes(c.name) ? 'is-hit' : ''}><span>{label(c.name)}</span><em>{TYPE_WORD[c.type] || c.type}</em></th>)}</tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                            <tr key={i}>{shown.map(c => {
                                const text = cell(row[c.name], c.type);
                                return <td key={c.name} className={`${highlight.includes(c.name) ? 'is-hit' : ''} ${c.type === ColumnType.METRIC ? 'is-num' : ''} ${text ? '' : 'is-blank'}`}>{text || 'blank'}</td>;
                            })}</tr>
                        ))}
                    </tbody>
                </table>
                {!rows.length && <p className="qi-steps-hint">No rows left after these steps.</p>}
            </div>
        </section>
    );
}

/* ── the editor ───────────────────────────────────────────────────── */

export const StepsEditor: React.FC<Props> = ({ dataset, onApply, pending = null }) => {
    const saved = dataset.etlOptions?.manualSteps || [];
    const [draft, setDraft] = useState<CleaningStep[]>(saved);
    const [editing, setEditing] = useState<{ step: CleaningStep; index: number; isNew: boolean } | null>(null);
    const [picking, setPicking] = useState(false);
    useEffect(() => { setDraft(dataset.etlOptions?.manualSteps || []); setEditing(null); setPicking(false); }, [dataset.version, dataset.etlOptions]);

    // The table the steps start from: saved before the steps when there are some, else the data itself.
    const base = useMemo(() => (saved.length && dataset.stepBase
        ? dataset.stepBase
        : { rows: dataset.rows.slice(0, 5000), columns: dataset.columns }), [dataset.stepBase, dataset.rows, dataset.columns, saved.length]);
    const truncated = (dataset.totalRows || dataset.rows.length) > base.rows.length || base.rows.length >= 5000;
    const missingBase = saved.length > 0 && !dataset.stepBase;

    // The steps as they will run, with the one being edited in place.
    const working = useMemo(() => {
        if (!editing) return draft;
        const next = [...draft];
        if (editing.isNew) next.splice(editing.index, 0, editing.step); else next[editing.index] = editing.step;
        return next;
    }, [draft, editing]);
    const upTo = editing ? editing.index + 1 : working.length;
    const before = useMemo(() => applySteps(base.rows, base.columns, working.slice(0, editing ? editing.index : working.length)), [base, working, editing]);
    const after = useMemo(() => (editing ? applySteps(base.rows, base.columns, working.slice(0, upTo)) : before), [base, working, upTo, editing, before]);
    const results = useMemo(() => applySteps(base.rows, base.columns, working).results, [base, working]);
    const resultOf = (id: string): StepResult | undefined => results.find(r => r.id === id);

    const dirty = !same(draft, saved);
    const busy = Boolean(pending);
    const problem = editing ? stepProblem(editing.step) : '';
    const editingResult = editing ? after.results.at(-1) : undefined;

    const startAdd = (kind: StepKind) => {
        setPicking(false);
        setEditing({ step: newStep(kind, before.columns), index: draft.length, isNew: true });
    };
    const commit = () => {
        if (!editing || problem) return;
        const next = [...draft];
        if (editing.isNew) next.splice(editing.index, 0, editing.step); else next[editing.index] = editing.step;
        setDraft(next);
        setEditing(null);
    };
    const move = (i: number, by: number) => {
        const j = i + by;
        if (j < 0 || j >= draft.length) return;
        const next = [...draft];
        [next[i], next[j]] = [next[j], next[i]];
        setDraft(next);
    };
    const apply = () => onApply?.({ ...(dataset.etlOptions || {}), manualSteps: draft.length ? draft : undefined }, draft.length ? `Your ${draft.length} step${draft.length === 1 ? '' : 's'}` : 'Steps removed');
    const autoFixes = (dataset.etlLogs || []).filter(l => l.status === 'applied' && !['Final Summary', 'Column Ordering', 'DimDate Generation', 'Your Step', 'Totals Check'].includes(l.step)).length;

    return (
        <section className="qi-steps" aria-label="Your steps">
            <header className="qi-steps-head">
                <div className="min-w-0">
                    <h3>Your steps</h3>
                    <p>Clean the data your way. Every step is recorded with its reason, runs again on every new file, and is saved in this client's setup.</p>
                </div>
                {dirty && (
                    <div className="qi-steps-applybar" role="region" aria-label="Unsaved steps">
                        <span>Not applied yet</span>
                        <button type="button" className="qi-ws-ghost px-3 py-1.5 rounded-lg text-[13px] font-semibold" onClick={() => { setDraft(saved); setEditing(null); }} disabled={busy}>Discard</button>
                        <button type="button" className="qi-review-apply" onClick={apply} disabled={busy || !onApply || Boolean(editing)} title={editing ? 'Finish the step you are editing first' : undefined}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />} {busy ? 'Applying…' : 'Apply to the whole file'}
                        </button>
                    </div>
                )}
            </header>
            {missingBase && <p className="qi-steps-warn"><Info className="h-3.5 w-3.5" aria-hidden /> Previews start from the data after your steps until the file is cleaned again. Apply once to refresh them.</p>}

            <div className="qi-steps-layout">
                <ol className="qi-steps-list" aria-label="Steps, in the order they run">
                    <li className="qi-steps-item is-fixed"><span className="qi-steps-num">·</span><div><strong>Your file as uploaded</strong><span>{(dataset.rawRows?.length || dataset.totalRows || 0).toLocaleString('en-GB')} rows</span></div></li>
                    <li className="qi-steps-item is-fixed"><span className="qi-steps-num">·</span><div><strong>Automatic cleaning</strong><span>{autoFixes} fix{autoFixes === 1 ? '' : 'es'}, explained in the Checklist</span></div></li>
                    {draft.map((step, i) => {
                        const Icon = ICONS[step.kind];
                        const r = resultOf(step.id);
                        const active = editing && !editing.isNew && editing.index === i;
                        return (
                            <li key={step.id} className={`qi-steps-item ${step.off ? 'is-off' : ''} ${active ? 'is-active' : ''} ${r?.status === 'skipped' ? 'is-skipped' : ''}`}>
                                <span className="qi-steps-num">{i + 1}</span>
                                <div className="min-w-0 flex-1">
                                    <button type="button" className="qi-steps-title" onClick={() => setEditing({ step: { ...step }, index: i, isNew: false })} disabled={Boolean(editing) && !active}>
                                        <Icon className="h-3.5 w-3.5" aria-hidden /> <strong>{describeStep(step)}</strong>
                                    </button>
                                    <span className={`qi-steps-result ${r?.status === 'skipped' ? 'is-warn' : ''}`}>{r?.text}</span>
                                    {step.note && <span className="qi-steps-note">Why: {step.note}</span>}
                                </div>
                                <div className="qi-steps-actions">
                                    <button type="button" className="qi-steps-icon" aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0 || Boolean(editing)}><ChevronUp className="h-3.5 w-3.5" /></button>
                                    <button type="button" className="qi-steps-icon" aria-label={`Move step ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === draft.length - 1 || Boolean(editing)}><ChevronDown className="h-3.5 w-3.5" /></button>
                                    <button type="button" className="qi-steps-icon" aria-label={step.off ? `Switch step ${i + 1} on` : `Switch step ${i + 1} off`} aria-pressed={!step.off} onClick={() => setDraft(draft.map((s, j) => (j === i ? { ...s, off: !s.off } : s)))} disabled={Boolean(editing)}>{step.off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
                                    <button type="button" className="qi-steps-icon" aria-label={`Delete step ${i + 1}`} onClick={() => setDraft(draft.filter((_s, j) => j !== i))} disabled={Boolean(editing)}><Trash2 className="h-3.5 w-3.5" /></button>
                                </div>
                            </li>
                        );
                    })}
                    {editing?.isNew && (
                        <li className="qi-steps-item is-active is-new"><span className="qi-steps-num">{draft.length + 1}</span><div><strong>{describeStep(editing.step)}</strong><span>New step</span></div></li>
                    )}
                    {!editing && (
                        <li><button type="button" className="qi-steps-add" onClick={() => setPicking(v => !v)} aria-expanded={picking}><Plus className="h-4 w-4" aria-hidden /> Add a step</button></li>
                    )}
                </ol>

                <div className="qi-steps-main">
                    {picking && !editing && (
                        <section className="qi-steps-palette" aria-label="Add a step">
                            <header><strong>What do you want to do?</strong><button type="button" className="qi-steps-icon" aria-label="Close" onClick={() => setPicking(false)}><X className="h-4 w-4" /></button></header>
                            {STEP_GROUPS.map(group => (
                                <div key={group.title} className="qi-steps-palette-group">
                                    <h4>{group.title}</h4>
                                    <div className="qi-steps-palette-grid">
                                        {group.kinds.map(k => {
                                            const Icon = ICONS[k.kind];
                                            return <button key={k.kind} type="button" onClick={() => startAdd(k.kind)}><Icon className="h-4 w-4" aria-hidden /><span><strong>{k.label}</strong><em>{k.hint}</em></span></button>;
                                        })}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {editing && (
                        <section className="qi-steps-form" aria-label={editing.isNew ? 'New step' : `Edit step ${editing.index + 1}`}>
                            <header>
                                <strong>{editing.isNew ? 'New step' : `Step ${editing.index + 1}`}: {KIND_LABEL[editing.step.kind]}</strong>
                                <button type="button" className="qi-steps-icon" aria-label="Cancel" onClick={() => setEditing(null)}><X className="h-4 w-4" /></button>
                            </header>
                            <StepForm step={editing.step} columns={before.columns} rows={before.rows} onChange={step => setEditing({ ...editing, step })} />
                            <Field title="Why is this step needed? (optional)" hint="Shown with the step in the Checklist, so anyone can see why it is done.">
                                <Text value={editing.step.note} onChange={v => setEditing({ ...editing, step: { ...editing.step, note: v || undefined } })} placeholder="e.g. The client's test orders start with TEST" ariaLabel="Why is this step needed?" />
                            </Field>
                            <div className="qi-steps-formfoot">
                                <p className={`qi-steps-effect ${problem ? '' : editingResult?.status === 'skipped' ? 'is-warn' : 'is-ok'}`} role="status">
                                    {problem
                                        ? problem
                                        : <><strong>{describeStep(editing.step)}.</strong> {editingResult?.text}{editingResult && editingResult.rowsBefore !== editingResult.rowsAfter ? ` (${editingResult.rowsBefore.toLocaleString('en-GB')} → ${editingResult.rowsAfter.toLocaleString('en-GB')} rows)` : ''}{truncated ? ', in the preview' : ''}.</>}
                                </p>
                                <div className="flex gap-2">
                                    <button type="button" className="qi-ws-ghost px-3 py-1.5 rounded-lg text-[13px] font-semibold" onClick={() => setEditing(null)}>Cancel</button>
                                    <button type="button" className="qi-review-apply" onClick={commit} disabled={Boolean(problem)}><Check className="h-4 w-4" aria-hidden /> {editing.isNew ? 'Add step' : 'Save step'}</button>
                                </div>
                            </div>
                        </section>
                    )}

                    {!picking && !editing && !draft.length && (
                        <section className="qi-steps-empty">
                            <strong>No steps yet</strong>
                            <p>The automatic cleaning has already run. Add a step for anything else this client's file needs: removing test orders, renaming columns, grouping spellings, working out a profit column. Each step runs again on every new file.</p>
                            <button type="button" className="qi-review-apply" onClick={() => setPicking(true)}><Plus className="h-4 w-4" aria-hidden /> Add the first step</button>
                        </section>
                    )}

                    <Preview rows={after.rows} columns={after.columns} highlight={editing ? (editingResult?.columns || [editing.step.column || '']) : []} total={after.rows.length} truncated={truncated} />
                </div>
            </div>
        </section>
    );
};

