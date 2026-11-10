/**
 * What to tell someone the moment their data is ready: what it holds, what
 * the cleaning changed, what is worth a look, and — for a workbook or a
 * store with several tables — how the tables were linked. Worked out from
 * the dataset's own metadata and cleaning log; plain words only.
 */
import type { Dataset, ETLLog } from '../types';
import { summariseEtlChanges } from '../utils/etlChangeSummary';
import { describeDatasetShape } from './datasetShape';

export interface DataReadySummary {
    /** The file or source name without its extension. */
    name: string;
    /** "1,188 rows · 11 columns · Jan 2024 – Dec 2024" */
    facts: string;
    /** What the data is, in one line: "Amounts and categories — sales, profit and quantity by city and product." */
    kind: string;
    /** Up to four changes the cleaning made, in plain words. */
    changes: string[];
    /** How many more changes there are beyond those shown. */
    moreChanges: number;
    /** Things the cleaning flagged for a look (left as they were). */
    toCheck: number;
    /** Sheets or tables linked together: "Line Items → Products". */
    links: string[];
    /** How many sheets or tables the data came from (1 for a single file). */
    tables: number;
    /** Sheets with the same columns put back together: "Jan, Feb and Mar → one table". */
    combined: string[];
    /** Sheets kept for reference only: "Summary (a summary made from the records)". */
    setAside: string[];
}

const monthYear = (iso?: string) => {
    if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
    return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const human = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

export function summariseDataReady(dataset: Dataset): DataReadySummary {
    const columns = dataset.columns.filter(c => !c.name.startsWith('__'));
    const sheets = dataset.sourceTables || dataset.relatedTables || [];
    const tables = sheets.filter(t => !t.sheetRole).length || 1;
    const from = monthYear(dataset.timeContext?.minDate);
    const to = monthYear(dataset.timeContext?.maxDate);
    const facts = [
        `${dataset.rows.length.toLocaleString('en-GB')} rows`,
        `${columns.length} columns`,
        tables > 1 ? `${tables} sheets` : '',
        from && to ? (from === to ? from : `${from} – ${to}`) : '',
    ].filter(Boolean).join(' · ');

    // Per-sheet logs read "Orders · Duplicate Row Removal": summarise by the step itself.
    const logs: ETLLog[] = (dataset.etlLogs || []).map(log => ({ ...log, step: log.step.replace(/^.+? · /, '') }));
    const summary = summariseEtlChanges(logs);
    // How the sheets were read has its own section in the pop-up.
    const sheetStep = /^(Sheets Combined|Copied Sheet|Summary Sheet|Notes Sheet|Plan Sheets Kept Apart|Sheets Kept Apart|Empty Sheets):/;
    const done = summary.items.filter(item => !sheetStep.test(item.id) && (item.kind === 'removed' || item.kind === 'added' || item.kind === 'converted'));
    const unique = [...new Set(done.map(item => item.title))];

    let kind = '';
    try {
        const shape = describeDatasetShape(dataset);
        kind = `${shape.label}: ${shape.summary}`;
    } catch { /* shape is a nicety */ }

    const edges = dataset.relationalCatalog?.schema.joinEdges || dataset.sourceSchema?.joinEdges || [];
    const links = [...new Set(edges.map(edge => `${edge.leftTable} → ${edge.rightTable}`))];

    const list = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    // From the cleaning log, so it is also said when the sheets became a single table.
    const combined = (dataset.etlLogs || []).filter(log => /Sheets Combined$/.test(log.step)).map(log => {
        const from = /^(.+?) have the same columns/.exec(log.details || '')?.[1];
        return from ? `${list(from.split(', '))} had the same columns, so they were put back together as one table` : '';
    }).filter(Boolean);
    const why = { report: 'a summary made from the records', notes: 'written notes', copy: 'an exact copy of another sheet' } as const;
    const fromLogs = (dataset.etlLogs || []).flatMap(log => {
        const sheet = /^(.+?) (?:looks like a summary|holds written notes|is an exact copy)/.exec(log.details || '')?.[1];
        if (!sheet) return [];
        const role = /summary/.test(log.details || '') ? 'report' : /notes/.test(log.details || '') ? 'notes' : 'copy';
        return [`${sheet} (${why[role as keyof typeof why]})`];
    });
    const setAside = [...new Set([...sheets.filter(t => t.sheetRole).map(t => `${t.name} (${why[t.sheetRole!]})`), ...fromLogs])];

    return {
        combined,
        setAside,
        name: human(dataset.name),
        facts,
        kind,
        changes: unique.slice(0, 4),
        moreChanges: Math.max(0, unique.length - 4),
        toCheck: summary.byKind.check.length,
        links,
        tables,
    };
}
