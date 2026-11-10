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
}

const monthYear = (iso?: string) => {
    if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
    return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const human = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

export function summariseDataReady(dataset: Dataset): DataReadySummary {
    const columns = dataset.columns.filter(c => !c.name.startsWith('__'));
    const tables = (dataset.sourceTables || dataset.relatedTables || []).length || 1;
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
    const done = summary.items.filter(item => item.kind === 'removed' || item.kind === 'added' || item.kind === 'converted');
    const unique = [...new Set(done.map(item => item.title))];

    let kind = '';
    try {
        const shape = describeDatasetShape(dataset);
        kind = `${shape.label}: ${shape.summary}`;
    } catch { /* shape is a nicety */ }

    const edges = dataset.relationalCatalog?.schema.joinEdges || dataset.sourceSchema?.joinEdges || [];
    const links = [...new Set(edges.map(edge => `${edge.leftTable} → ${edge.rightTable}`))];

    return {
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
