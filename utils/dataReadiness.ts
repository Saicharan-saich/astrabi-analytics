/**
 * dataReadiness.ts — "Is your data ready?" in plain words.
 *
 * Sorts the cleaning log into what a non-technical person needs:
 *   needsYou    flagged things only they can decide, with the choices
 *   fixed       what the cleaning changed for them, each with why it was done
 *               and what would go wrong without it (with the amount, when the
 *               cleaning measured one)
 *   goodToKnow  things noticed but left alone
 *   blanks      every column with blank cells, with choices and exact results
 *   quiet       how many other checks found nothing
 * Pure: works from the dataset's own log and columns, for any file.
 */

import { ColumnType, type Dataset, type ETLLog } from '../types';
import { getStepGuide } from '../components/etlStepGuide';
import { summariseEtlChanges, type ChangeKind } from './etlChangeSummary';
import { amount, blankCards, type BlankCard } from './blankChoices';

export interface ReadyChoice {
    id: string;
    label: string;
    effect: string;
}

export interface ReadyItem {
    id: string;
    logIndex: number;
    kind: ChangeKind;
    title: string;
    /** What was done or found, in one plain sentence. */
    what: string;
    /** Why it matters for the answers. */
    why: string;
    /** What goes wrong without it ('' when not meaningful). */
    without: string;
    /** Measured: what the removed rows added up to. */
    impact?: string;
    revert?: ETLLog['revert'];
    decision?: ETLLog['decision'];
    choices?: ReadyChoice[];
    samples?: Record<string, any>[];
    /** The engine's own words, for "technical detail". */
    technical: string;
}

export interface Readiness {
    needsYou: ReadyItem[];
    fixed: ReadyItem[];
    goodToKnow: ReadyItem[];
    blanks: BlankCard[];
    quiet: number;
    totals?: { ok: boolean; text: string };
    rowsUploaded?: number;
    rowsAnalysed?: number;
}

const label = (column: string) => column.replace(/_/g, ' ');
/** Removals that take out a second copy of something already counted. */
const DOUBLE_COUNTS = new Set(['Duplicate Row Removal', 'Copied Sheet', 'Total Row Removal', 'Repeated Header Rows']);

function impactOf(log: ETLLog, measures: Set<string>, currencyOf: (c: string) => string | undefined): string | undefined {
    const amounts = Object.entries(log.removedAmounts || {}).filter(([column, value]) => measures.has(column) && value !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2);
    if (!amounts.length) return undefined;
    const parts = amounts.map(([column, value]) => `${label(column)} ${amount(value, currencyOf(column))}`);
    return DOUBLE_COUNTS.has(log.step)
        ? `Without it, ${parts.join(' and ')} would be counted a second time.`
        : `The rows left out held ${parts.join(' and ')}.`;
}

function choicesFor(log: ETLLog): ReadyChoice[] | undefined {
    const d = log.decision;
    if (!d) return undefined;
    if (d.kind === 'outlier') return [
        { id: 'keep', label: 'They are real: keep them', effect: 'Every total stays as it is.' },
        { id: 'remove', label: 'They are mistakes: leave these rows out', effect: 'The rows go from every answer, so totals drop.' },
        { id: 'cap', label: 'Bring them into the usual range', effect: 'The rows stay, but these values are changed to the edge of the usual range, so totals change.' },
    ];
    if (d.kind === 'typo') return [
        { id: 'merge', label: 'Same thing: merge them', effect: 'They count as one group in every chart and total.' },
        { id: 'keep', label: 'Different things: keep them apart', effect: 'They stay as separate groups.' },
    ];
    if (d.kind === 'flag' && d.options?.length) return d.options.map(option => ({
        id: option.choice,
        label: option.label,
        effect: option.choice === 'keep' ? 'Nothing changes.' : option.choice === 'remove' ? 'The rows go from every answer.' : 'The values are corrected in every answer.',
    }));
    return undefined;
}

export function buildReadiness(dataset: Pick<Dataset, 'etlLogs' | 'columns'>): Readiness {
    const logs = dataset.etlLogs || [];
    const measures = new Set(dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name));
    const currencies = new Map(dataset.columns.map(c => [c.name, c.currency] as const));
    const currencyOf = (column: string) => currencies.get(column);
    const summary = summariseEtlChanges(logs);
    const used = new Set<number>();
    const needsYou: ReadyItem[] = [];
    const fixed: ReadyItem[] = [];
    const goodToKnow: ReadyItem[] = [];

    for (const item of summary.items) {
        const index = Number(item.id.slice(item.id.lastIndexOf(':') + 1));
        const log = logs[index];
        if (!log) continue;
        used.add(index);
        const guide = getStepGuide(log.step);
        const ready: ReadyItem = {
            id: item.id,
            logIndex: index,
            kind: item.kind,
            title: item.title,
            what: guide.what,
            why: guide.why,
            without: guide.ifSkipped && guide.ifSkipped !== '—' ? guide.ifSkipped : '',
            impact: impactOf(log, measures, currencyOf),
            revert: log.revert,
            decision: log.decision,
            choices: choicesFor(log),
            samples: log.sampleRows?.length ? log.sampleRows : log.removedRowSamples,
            technical: log.details,
        };
        if (item.kind === 'check' && ready.choices) needsYou.push(ready);
        else if (item.kind === 'check' || item.kind === 'kept') goodToKnow.push(ready);
        else fixed.push(ready);
    }

    const blankLog = logs.find(l => l.step === 'Blank Values');
    const blanks = blankCards(blankLog?.blanks, currencyOf);
    if (blankLog) used.add(logs.indexOf(blankLog));

    const totalsLog = logs.find(l => l.step === 'Totals Check');
    const totals = totalsLog
        ? { ok: totalsLog.status === 'applied', text: totalsLog.details.replace(/^Every total matches the file: /, '') }
        : undefined;
    if (totalsLog) used.add(logs.indexOf(totalsLog));

    // Everything else the cleaning looked at and left alone.
    const quiet = logs.filter((l, i) => !used.has(i) && l.status === 'skipped').length;
    return { needsYou, fixed, goodToKnow, blanks, quiet, totals, rowsUploaded: summary.rowsBefore, rowsAnalysed: summary.rowsAfter };
}
