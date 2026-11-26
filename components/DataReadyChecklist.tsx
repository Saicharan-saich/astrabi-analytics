import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, CircleDashed, Info, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import type { BlankChoice, Dataset, ETLLog, EtlOptions } from '../types';
import { buildReadiness, type ReadyItem } from '../utils/dataReadiness';
import { buildReviewOptions, type StepDecision } from '../utils/cleaningReview';
import { cleanedByOlderVersion } from '../utils/etlChangeSummary';
import type { BlankCard } from '../utils/blankChoices';
import { blankRows, rowsForLog, type ItemChanges, type ItemRows } from '../utils/itemRows';
import { ViewRowsButton, type RowsEditor } from './ItemRowsView';
import { mergeFixes } from '../services/valueFixes';
import { ColumnType, type ColumnDefinition } from '../types';

/**
 * "Is your data ready?" — the cleaning as one plain checklist for people who
 * are not data specialists. Every item says what was done or found, why it
 * matters, and what would go wrong without it. Choices wait for "Apply
 * changes" and are applied in one re-clean of the original upload, so every
 * choice can be changed back.
 */

interface Props {
    dataset: Dataset;
    /** Re-clean once with these options (the review's decisions). */
    onApply?: (nextOptions: EtlOptions, label: string) => void;
    /** Reverse one automatic step straight away. */
    onRevert?: (revert: NonNullable<ETLLog['revert']>) => void;
    onReclean?: () => void;
    /** The re-run in progress, if any. */
    pending?: string | null;
    /** Opens the full step-by-step list. */
    onShowEveryCheck?: () => void;
}

/** Why / without / measured impact, the same three lines everywhere. */
function Reasons({ item }: { item: Pick<ReadyItem, 'why' | 'without' | 'impact'> }) {
    return (
        <dl className="qi-chk-reasons">
            <div><dt>Why it matters</dt><dd>{item.why}</dd></div>
            {item.without && <div><dt>Without it</dt><dd>{item.without}</dd></div>}
            {item.impact && <div><dt>In your data</dt><dd>{item.impact}</dd></div>}
        </dl>
    );
}

function decisionFor(item: ReadyItem, choiceId: string): StepDecision | null {
    const d = item.decision;
    if (!d) return null;
    if (d.kind === 'outlier') return { kind: 'outlier', column: d.column, choice: choiceId as 'keep' | 'remove' | 'cap' };
    if (d.kind === 'typo') return { kind: 'typo', column: d.column, choice: choiceId as 'merge' | 'keep' };
    if (d.kind === 'flag' && d.key) {
        const option = d.options?.find(o => o.choice === choiceId);
        return { kind: 'flag', key: d.key, column: d.column, choice: choiceId as 'keep' | 'remove' | 'fix', label: option?.label || choiceId };
    }
    return null;
}

type RowsView = ItemRows | ItemChanges | null;

function DecisionItem({ item, picked, onPick, view, editor }: { item: ReadyItem; picked?: string; onPick: (choice: string) => void; view: RowsView; editor?: RowsEditor }) {
    return (
        <li className="qi-chk-item is-decide">
            <div className="qi-chk-item-head">
                <AlertCircle className="qi-chk-icon is-attention" aria-hidden />
                <div className="min-w-0 flex-1">
                    <h4>{item.title}</h4>
                    <p className="qi-chk-what">{item.what}</p>
                </div>
            </div>
            <Reasons item={item} />
            <fieldset className="qi-chk-choices">
                <legend>What should happen?</legend>
                {item.choices!.map(choice => (
                    <label key={choice.id} className={picked === choice.id ? 'is-picked' : ''}>
                        <input type="radio" name={`decide-${item.id}`} checked={picked === choice.id} onChange={() => onPick(choice.id)} />
                        <span><strong>{choice.label}</strong><em>{choice.effect}</em></span>
                    </label>
                ))}
            </fieldset>
            <ViewRowsButton title={item.title} view={view} editor={editor} />
        </li>
    );
}

function BlankItem({ card, picked, onPick, view, editor }: { card: BlankCard; picked: BlankChoice; onPick: (choice: BlankChoice) => void; view: RowsView; editor?: RowsEditor }) {
    const recommended = card.options.find(o => o.recommended);
    return (
        <li className="qi-chk-item is-blank">
            <div className="qi-chk-item-head">
                <CircleDashed className="qi-chk-icon" aria-hidden />
                <div className="min-w-0 flex-1">
                    <h4>{card.headline}</h4>
                    <p className="qi-chk-what">{card.why}</p>
                </div>
            </div>
            <fieldset className="qi-chk-choices">
                <legend>What does a blank mean here?</legend>
                {card.options.map(option => (
                    <label key={option.choice} className={picked === option.choice ? 'is-picked' : ''}>
                        <input type="radio" name={`blank-${card.column}`} checked={picked === option.choice} onChange={() => onPick(option.choice)} />
                        <span>
                            <strong>{option.label}{option.recommended && <b className="qi-chk-rec">Recommended</b>}</strong>
                            <span className="qi-chk-result">{option.result}</span>
                            <em>{option.effect}</em>
                        </span>
                    </label>
                ))}
            </fieldset>
            {recommended && <p className="qi-chk-because"><Info className="h-3.5 w-3.5" aria-hidden /> {card.because}</p>}
            <ViewRowsButton title={card.headline} view={view} editor={editor} />
        </li>
    );
}

function DoneItem({ item, onRevert, busy, pending, view }: { item: ReadyItem; onRevert?: Props['onRevert']; busy: boolean; pending: boolean; view: RowsView }) {
    const [open, setOpen] = useState(false);
    return (
        <li className="qi-chk-row">
            <button type="button" className="qi-chk-row-main" aria-expanded={open} onClick={() => setOpen(v => !v)}>
                <ChevronDown className={`qi-chk-chev h-3.5 w-3.5 ${open ? 'rotate-180' : ''}`} aria-hidden />
                <span className="min-w-0">
                    <strong>{item.title}</strong>
                    {!open && <span className="qi-chk-why-line">{item.why}</span>}
                </span>
            </button>
            <ViewRowsButton title={item.title} view={view} />
            {item.revert && onRevert && (
                <button type="button" className="qi-chk-undo" disabled={busy} onClick={() => onRevert(item.revert!)}>
                    {pending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Undo2 className="h-3 w-3" aria-hidden />} {item.revert.label}
                </button>
            )}
            {open && (
                <div className="qi-chk-row-body">
                    <p className="qi-chk-what">{item.what}</p>
                    <Reasons item={item} />
                    <p className="qi-chk-tech">{item.technical}</p>
                </div>
            )}
        </li>
    );
}

const BLANKS_SHOWN = 4;

export const DataReadyChecklist: React.FC<Props> = ({ dataset, onApply, onRevert, onReclean, pending = null, onShowEveryCheck }) => {
    const ready = useMemo(() => buildReadiness(dataset), [dataset]);
    // The rows each item is about, for "View rows" (worked out here, from this data).
    const viewOf = useMemo(() => {
        const cache = new Map<number, RowsView>();
        return (item: ReadyItem) => {
            if (!cache.has(item.logIndex)) cache.set(item.logIndex, rowsForLog(dataset.etlLogs?.[item.logIndex], dataset.rows));
            return cache.get(item.logIndex)!;
        };
    }, [dataset.etlLogs, dataset.rows]);
    // Changing values in "View rows": saved as fixes, then cleaned again.
    const editor = useMemo<RowsEditor | undefined>(() => {
        if (!onApply) return undefined;
        const byName = new Map<string, ColumnDefinition>(dataset.columns.map(c => [c.name, c] as [string, ColumnDefinition]));
        const options = new Map<string, string[]>();
        return {
            idColumn: dataset.columns.find(c => c.type === ColumnType.ID)?.name,
            isNumber: column => byName.get(column)?.type === ColumnType.METRIC,
            optionsFor: column => {
                if (!options.has(column)) {
                    const counts = new Map<string, number>();
                    for (const row of dataset.rows) { const v = row[column]; if (v !== null && v !== undefined && String(v).trim()) counts.set(String(v), (counts.get(String(v)) || 0) + 1); }
                    options.set(column, [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([v]) => v));
                }
                return options.get(column)!;
            },
            onSave: fixes => onApply({ ...(dataset.etlOptions || {}), valueFixes: mergeFixes(dataset.etlOptions?.valueFixes, fixes) }, `Your fixes (${fixes.length})`),
        };
    }, [onApply, dataset.columns, dataset.rows, dataset.etlOptions]);
    const older = useMemo(() => cleanedByOlderVersion(dataset.etlLogs), [dataset.etlLogs]);
    const [decisions, setDecisions] = useState<Record<string, { decision: StepDecision; label: string }>>({});
    const [blankPicks, setBlankPicks] = useState<Record<string, BlankChoice>>({});
    const [allBlanks, setAllBlanks] = useState(false);
    // A finished re-clean is a new version of the data: start fresh.
    useEffect(() => { setDecisions({}); setBlankPicks({}); }, [dataset.version, dataset.etlLogs]);

    const busy = Boolean(pending);
    const blankChanges = ready.blanks.filter(card => blankPicks[card.column] && blankPicks[card.column] !== card.current);
    const changes = Object.values(decisions).map(d => d.label).concat(blankChanges.map(card => {
        const option = card.options.find(o => o.choice === blankPicks[card.column]);
        return `'${card.column.replace(/_/g, ' ')}': ${option?.label.toLowerCase() || blankPicks[card.column]}`;
    }));

    const apply = () => {
        if (!onApply || !changes.length) return;
        const stepDecisions = Object.fromEntries(Object.entries(decisions).map(([id, d]) => [id, d.decision]));
        const next = buildReviewOptions(dataset.etlOptions || {}, stepDecisions);
        if (blankChanges.length) {
            const blanks = { ...(next.blankDecisions || {}) };
            for (const card of blankChanges) {
                const choice = blankPicks[card.column];
                if (choice === 'leave') delete blanks[card.column];
                else blanks[card.column] = choice;
            }
            if (Object.keys(blanks).length) next.blankDecisions = blanks;
            else delete next.blankDecisions;
        }
        onApply(next, changes.length === 1 ? changes[0] : `${changes.length} cleaning choices`);
    };

    const toDecide = ready.needsYou.length;
    const verdict = toDecide
        ? `Nearly ready: ${toDecide} thing${toDecide === 1 ? '' : 's'} need${toDecide === 1 ? 's' : ''} your decision`
        : 'Ready to use';
    const rowsLine = ready.rowsUploaded !== undefined && ready.rowsAnalysed !== undefined
        ? ready.rowsUploaded === ready.rowsAnalysed
            ? `All ${ready.rowsAnalysed.toLocaleString('en-GB')} rows are in.`
            : `${ready.rowsAnalysed.toLocaleString('en-GB')} of ${ready.rowsUploaded.toLocaleString('en-GB')} uploaded rows are in.`
        : '';
    const shownBlanks = allBlanks ? ready.blanks : ready.blanks.slice(0, BLANKS_SHOWN);

    return (
        <section className="qi-chk" aria-label="Is your data ready?">
            <header className={`qi-chk-head ${toDecide ? 'is-attention' : 'is-ok'}`}>
                {toDecide ? <AlertCircle className="h-5 w-5" aria-hidden /> : <CheckCircle2 className="h-5 w-5" aria-hidden />}
                <div className="min-w-0">
                    <h3>{verdict}</h3>
                    <p>
                        {rowsLine}{' '}
                        {ready.totals ? (ready.totals.ok ? 'Every total matches your file.' : 'Some totals differ from your file; the reason is below.') : ''}
                    </p>
                    <ul className="qi-chk-tally" aria-label="Summary">
                        {ready.fixed.length > 0 && <li><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {ready.fixed.length} fixed for you</li>}
                        {toDecide > 0 && <li className="is-attention"><AlertCircle className="h-3.5 w-3.5" aria-hidden /> {toDecide} to decide</li>}
                        {ready.blanks.length > 0 && <li><CircleDashed className="h-3.5 w-3.5" aria-hidden /> {ready.blanks.length} column{ready.blanks.length === 1 ? '' : 's'} with blanks</li>}
                    </ul>
                </div>
            </header>

            {older.stale && (
                <div className="qi-chk-older" role="status">
                    <p>
                        <strong>This data was cleaned by an earlier version of QuickInsight.</strong>{' '}
                        {older.blankKeyDuplicates > 0 ? `That version removed ${older.blankKeyDuplicates} rows as duplicates only because their ID was blank. ` : ''}
                        {onReclean ? 'Clean it again with the current checks: your original upload is kept, and every change gets an undo.' : 'Upload the file again to clean it with the current checks.'}
                    </p>
                    {onReclean && (
                        <button type="button" className="qi-chk-undo" onClick={onReclean} disabled={busy}>
                            {pending === '__reclean__' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
                            {pending === '__reclean__' ? 'Cleaning again…' : 'Clean it again'}
                        </button>
                    )}
                </div>
            )}

            {ready.totals && !ready.totals.ok && (
                <div className="qi-totals is-warn" role="alert">
                    <AlertCircle className="h-4 w-4" aria-hidden />
                    <div><strong>Some totals differ from your file</strong><p>{ready.totals.text}</p></div>
                </div>
            )}

            {toDecide > 0 && (
                <div className="qi-chk-group">
                    <h3 className="qi-chk-group-title">Needs your decision</h3>
                    <p className="qi-chk-group-sub">Only you know your data well enough to decide these. Nothing changes until you apply.</p>
                    <ul className="qi-chk-list">
                        {ready.needsYou.map(item => (
                            <DecisionItem
                                key={item.id}
                                item={item}
                                view={viewOf(item)}
                                editor={editor}
                                picked={decisions[item.id]?.decision ? (decisions[item.id].decision as any).choice : undefined}
                                onPick={choice => {
                                    const decision = decisionFor(item, choice);
                                    const label = item.choices?.find(c => c.id === choice)?.label;
                                    if (decision) setDecisions(prev => ({ ...prev, [item.id]: { decision, label: `${item.title}: ${(label || choice).toLowerCase()}` } }));
                                }}
                            />
                        ))}
                    </ul>
                </div>
            )}

            {ready.blanks.length > 0 && (
                <div className="qi-chk-group">
                    <h3 className="qi-chk-group-title">Blank cells</h3>
                    <p className="qi-chk-group-sub">A blank can mean "none", "not recorded" or "does not apply". Each choice shows the numbers you would get.</p>
                    <ul className="qi-chk-list">
                        {shownBlanks.map(card => (
                            <BlankItem key={card.column} card={card} editor={editor} view={blankRows(card.column, dataset.rows)} picked={blankPicks[card.column] || card.current} onPick={choice => setBlankPicks(prev => ({ ...prev, [card.column]: choice }))} />
                        ))}
                    </ul>
                    {ready.blanks.length > BLANKS_SHOWN && (
                        <button type="button" className="qi-chk-more" onClick={() => setAllBlanks(v => !v)}>
                            <ChevronDown className={`h-3.5 w-3.5 ${allBlanks ? 'rotate-180' : ''}`} aria-hidden />
                            {allBlanks ? 'Show fewer' : `Show ${ready.blanks.length - BLANKS_SHOWN} more column${ready.blanks.length - BLANKS_SHOWN === 1 ? '' : 's'} with blanks`}
                        </button>
                    )}
                </div>
            )}

            {ready.fixed.length > 0 && (
                <div className="qi-chk-group">
                    <h3 className="qi-chk-group-title">Fixed for you</h3>
                    <p className="qi-chk-group-sub">Open any item to see why it was done and what would go wrong without it.</p>
                    <ul className="qi-chk-rows">
                        {ready.fixed.map(item => <DoneItem key={item.id} item={item} view={viewOf(item)} onRevert={onRevert} busy={busy} pending={pending === item.revert?.option} />)}
                    </ul>
                </div>
            )}

            {ready.goodToKnow.length > 0 && (
                <div className="qi-chk-group">
                    <h3 className="qi-chk-group-title">Good to know</h3>
                    <p className="qi-chk-group-sub">Noticed and left as they are.</p>
                    <ul className="qi-chk-rows">
                        {ready.goodToKnow.map(item => <DoneItem key={item.id} item={item} view={viewOf(item)} onRevert={onRevert} busy={busy} pending={pending === item.revert?.option} />)}
                    </ul>
                </div>
            )}

            <p className="qi-chk-quiet">
                {ready.quiet > 0 ? `${ready.quiet} other check${ready.quiet === 1 ? '' : 's'} found nothing to fix.` : ''}
                {onShowEveryCheck && <button type="button" className="qi-ws-link font-semibold" onClick={onShowEveryCheck}>See every check, step by step</button>}
            </p>

            {changes.length > 0 && (
                <div className="qi-review-bar rounded-xl" role="region" aria-label="Your choices">
                    <div className="qi-review-bar-text">
                        <strong>{changes.length} change{changes.length === 1 ? '' : 's'} to apply</strong>
                        <span>{changes.slice(0, 3).join(' · ')}{changes.length > 3 ? ` · +${changes.length - 3} more` : ''}</span>
                    </div>
                    <div className="qi-review-bar-actions">
                        <button type="button" className="qi-ws-ghost px-3 py-1.5 rounded-lg text-[13px] font-semibold" onClick={() => { setDecisions({}); setBlankPicks({}); }} disabled={busy}>Discard</button>
                        <button type="button" className="qi-review-apply" onClick={apply} disabled={busy || !onApply} title={!onApply ? 'This data source cannot be cleaned again here' : undefined}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                            {busy ? 'Applying…' : 'Apply changes'}
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
};

/** The overview's one-line status, pointing to the checklist. */
export const ReadySummary: React.FC<{ dataset: Dataset; onOpen?: () => void }> = ({ dataset, onOpen }) => {
    const ready = useMemo(() => buildReadiness(dataset), [dataset]);
    const older = useMemo(() => cleanedByOlderVersion(dataset.etlLogs), [dataset.etlLogs]);
    if (!ready.fixed.length && !ready.needsYou.length && !ready.blanks.length && !ready.totals && !older.stale) return null;
    const toDecide = ready.needsYou.length;
    const totalsOk = ready.totals?.ok !== false;
    const attention = toDecide > 0 || !totalsOk || older.stale;
    const parts = [
        ready.fixed.length ? `${ready.fixed.length} thing${ready.fixed.length === 1 ? '' : 's'} fixed for you` : '',
        toDecide ? `${toDecide} need${toDecide === 1 ? 's' : ''} your decision` : '',
        ready.blanks.length ? `${ready.blanks.length} column${ready.blanks.length === 1 ? ' has' : 's have'} blanks` : '',
    ].filter(Boolean);
    return (
        <div className={`qi-totals ${attention ? 'is-warn' : 'is-ok'}`} role="status">
            {attention ? <AlertCircle className="h-4 w-4" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
            <div>
                <strong>{toDecide || older.stale ? 'Nearly ready' : 'Your data is ready'}{totalsOk && ready.totals ? ' · every total matches your file' : ''}</strong>
                <p>{parts.join(' · ')}{!totalsOk ? ' · some totals differ from your file' : ''}{older.stale ? ' · cleaned by an earlier version of QuickInsight, worth cleaning again' : ''}</p>
                {onOpen && <button type="button" className="qi-totals-link" onClick={onOpen}>{attention ? 'Review and decide' : 'See what was checked'}</button>}
            </div>
        </div>
    );
};
