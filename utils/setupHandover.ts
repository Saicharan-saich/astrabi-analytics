/**
 * setupHandover.ts — the handover page for a saved cleaning setup.
 *
 * What the client keeps after a setup session: what the setup does, the file
 * it expects, every step with its reason, every decision in plain words, and
 * when the app will warn them. Built from the setup alone, so it works for any
 * client's file and never needs the data.
 */

import { ColumnType, type CleaningSetup } from '../types';
import { describeStep } from '../services/cleaningSteps';
import { describeRule } from '../services/etlQualityChecks';
import { describeSetup } from './cleaningSetups';

export interface HandoverItem { text: string; why?: string; off?: boolean }
export interface HandoverSection { id: string; title: string; intro?: string; items: HandoverItem[]; columns?: { name: string; kind: string }[] }
export interface Handover {
    title: string;
    summary: string;
    facts: { label: string; value: string }[];
    sections: HandoverSection[];
}

const word = (column: string) => `'${column.replace(/_/g, ' ')}'`;
const day = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const KIND: Record<string, string> = { METRIC: 'Number (added up and averaged)', DIMENSION: 'Category (groups and filters)', DATE: 'Date (trends over time)', ID: 'Identifier (counted, never added up)', BOOLEAN: 'Yes/No', UNKNOWN: 'Not decided' };

const BLANK: Record<string, string> = {
    zero: 'a blank counts as 0',
    typical: 'a blank is filled with the typical value (an estimate)',
    remove: 'rows with a blank here are left out of every answer',
    leave: 'blanks are left blank',
};
const OUTLIER: Record<string, string> = {
    keep: 'unusually high or low values are real and kept',
    remove: 'rows with unusually high or low values are left out',
    cap: 'unusually high or low values are brought into the usual range',
};
const TYPO: Record<string, string> = { merge: 'likely misspellings are merged into one spelling', keep: 'similar spellings are kept apart' };
const FLAG: Record<string, string> = { keep: 'left as they are', remove: 'the rows are left out', fix: 'the values are corrected' };
const KEPT: Record<string, string> = {
    keepDuplicateRows: 'Repeated rows are kept (not removed as copies)',
    keepTotalRows: 'Total and subtotal rows are kept',
    keepWideLayout: 'One column per period is kept as it is (not turned into rows)',
    keepNameColumns: 'Separate name columns are kept apart (not joined)',
    keepPlaceholders: 'Stand-in values such as 999999 are kept as written',
    keepCategorySpellings: 'Category spellings are kept exactly as written',
    skipAllocation: 'Order-level amounts are not spread across order lines',
    skipLineCost: 'No line cost column is worked out',
    keepMixedUnits: 'Mixed units (such as kg and g) are left as written',
};

export function buildHandover(setup: CleaningSetup): Handover {
    const o = setup.etlOptions || {};
    const sections: HandoverSection[] = [];
    // The headers as the client's file has them (not columns that steps make).
    const loose = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const cleaned = new Map(setup.columns.map(c => [loose(c.name), c]));
    const expected = (setup.headers?.length ? setup.headers : setup.columns.map(c => c.name)).map(header => ({ header, column: cleaned.get(loose(header)) }));

    sections.push({
        id: 'file', title: 'The file it expects',
        intro: `A file is recognised by its columns, in any order. The setup is used when at least three quarters of the columns match.`,
        items: [],
        columns: expected.map(e => ({ name: e.header, kind: e.column ? KIND[e.column.type] || e.column.type : 'Renamed or removed by the cleaning' })),
    });

    const steps = o.manualSteps || [];
    if (steps.length) sections.push({
        id: 'steps', title: 'Cleaning steps, in order',
        intro: 'These run after the automatic cleaning, on every file, in this order.',
        items: steps.map(step => ({ text: describeStep(step), why: step.note, off: step.off })),
    });

    const blanks = Object.entries(o.blankDecisions || {});
    if (blanks.length) sections.push({
        id: 'blanks', title: 'Blank cells',
        items: blanks.map(([column, choice]) => ({ text: `In ${word(column)}, ${BLANK[choice] || choice}.` })),
    });

    const decisions: HandoverItem[] = [
        ...Object.entries(o.outlierDecisions || {}).map(([column, choice]) => ({ text: `In ${word(column)}, ${OUTLIER[choice] || choice}.` })),
        ...Object.entries(o.typoDecisions || {}).map(([column, choice]) => ({ text: `In ${word(column)}, ${TYPO[choice] || choice}.` })),
        ...Object.entries(o.flagDecisions || {}).map(([key, choice]) => {
            const [kind, rest = ''] = key.split(':');
            const about = rest && !key.startsWith('rule:') ? ` in ${rest.split('->').map(word).join(' and ')}` : '';
            return { text: `${kind.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase())} flags${about}: ${FLAG[choice] || choice}.` };
        }),
    ];
    if (o.dateOrder) decisions.push({ text: `Dates like 03/04 are read ${o.dateOrder === 'day_first' ? 'day first (3 April)' : 'month first (4 March)'}.` });
    if (decisions.length) sections.push({ id: 'decisions', title: 'Decisions made', items: decisions });

    const rules = o.customRules || [];
    if (rules.length) sections.push({
        id: 'checks', title: 'Checks on every file',
        intro: 'Each file is checked against these. Rows that break a check are flagged for review or left out, as set.',
        items: rules.map(rule => ({ text: `${describeRule(rule)}: rows that break it are ${rule.action === 'remove' ? 'left out' : 'flagged for review'}.` })),
    });

    const kept = (Object.keys(KEPT) as (keyof typeof KEPT)[]).filter(k => (o as any)[k]).map(k => ({ text: `${KEPT[k]}.` }));
    if (kept.length) sections.push({ id: 'kept', title: 'Automatic steps switched off', intro: 'These automatic fixes were reversed for this file, on purpose.', items: kept });

    const kinds = Object.entries(setup.columnTypes || {});
    if (kinds.length) sections.push({
        id: 'kinds', title: 'Column kinds set by hand',
        items: kinds.map(([column, type]) => ({ text: `${word(column)} is treated as ${(KIND[type] || type).split(' (')[0].toLowerCase()}.` })),
    });

    sections.push({
        id: 'warnings', title: 'When QuickInsight will warn you',
        intro: 'Each new file is compared with the one this setup was made for. You will see a warning, before anyone relies on the numbers, when:',
        items: [
            { text: 'a column the setup expects is missing, so some answers would be incomplete;' },
            { text: 'a column now reads as a different kind, such as numbers arriving as text;' },
            { text: 'a step cannot run because a column it needs is not in the file;' },
            { text: 'a new column appears that the setup has no choices for.' },
            { text: 'If you see one of these, contact the people who set this up before relying on the numbers.' },
        ],
    });

    const metrics = expected.filter(e => e.column?.type === ColumnType.METRIC).length;
    return {
        title: setup.name,
        summary: `Every file with these columns is cleaned in exactly the same way, in your browser, so each month's numbers can be compared with the last. Your data never leaves your computer; this setup holds only the cleaning choices and the column names. It contains: ${describeSetup(setup).toLowerCase()}.`,
        facts: [
            { label: 'Set up', value: day(setup.createdAt) },
            ...(setup.updatedAt && setup.updatedAt !== setup.createdAt ? [{ label: 'Last changed', value: day(setup.updatedAt) }] : []),
            { label: 'Columns', value: `${expected.length} (${metrics} number${metrics === 1 ? '' : 's'})` },
            { label: 'Used', value: setup.timesUsed ? `${setup.timesUsed} time${setup.timesUsed === 1 ? '' : 's'}${setup.lastUsedAt ? `, last on ${day(setup.lastUsedAt)}` : ''}` : 'Not used yet' },
        ],
        sections,
    };
}
