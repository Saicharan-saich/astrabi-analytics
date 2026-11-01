import type { ETLLog } from '../types';

/**
 * Turns the cleaning log into a short, plain account of what changed in the
 * user's data: what was removed, what was added, which values were rewritten,
 * and what is worth checking. Bookkeeping steps (profiling, ordering, renaming
 * headers to snake_case) are left out — they don't change any number.
 */
export type ChangeKind = 'removed' | 'added' | 'converted' | 'check' | 'kept';

export interface ChangeItem {
    id: string;
    kind: ChangeKind;
    title: string;
    detail: string;
    columns: string[];
    count?: number;
    samples?: Record<string, any>[];
    revert?: ETLLog['revert'];
}

export interface ChangeSummary {
    items: ChangeItem[];
    byKind: Record<ChangeKind, ChangeItem[]>;
    rowsBefore?: number;
    rowsAfter?: number;
    headline: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const quoted = (details: string) => details.match(/Column '([^']+)'/)?.[1];
const rowsDropped = (l: ETLLog) => (l.rowsBefore !== undefined && l.rowsAfter !== undefined ? l.rowsBefore - l.rowsAfter : undefined);
const firstNumber = (details: string) => { const m = details.match(/(\d[\d,]*)/); return m ? Number(m[1].replace(/,/g, '')) : undefined; };

type Rule = { kind: ChangeKind; title: (l: ETLLog, n: number | undefined, col?: string) => string };

const RULES: Record<string, Rule> = {
    'Empty Row Removal': { kind: 'removed', title: (_l, n) => `Removed ${plural(n ?? 0, 'empty row')}` },
    'Repeated Header Rows': { kind: 'removed', title: (_l, n) => `Removed ${plural(n ?? 0, 'repeated header row')}` },
    'Total Row Removal': { kind: 'removed', title: (_l, n) => `Removed ${plural(n ?? 0, 'total row')}` },
    'Duplicate Row Removal': { kind: 'removed', title: (_l, n) => `Removed ${plural(n ?? 0, 'duplicate row')}` },
    'Empty Column Removal': { kind: 'removed', title: l => `Removed ${plural(l.affectedColumns?.length || 0, 'empty column')}` },
    'Duplicate Column Removal': { kind: 'removed', title: l => `Removed ${plural(l.affectedColumns?.length || 0, 'duplicate column')}` },

    'Auto-Merge Name Columns': { kind: 'added', title: l => `Combined first and last name into '${l.affectedColumns?.[2] || 'full_name'}'` },
    'Unpivot Period Columns': { kind: 'added', title: () => `Turned period columns into 'period' and 'value'` },
    'Period From Year And Month': { kind: 'added', title: l => `Added '${l.affectedColumns?.[0] || 'period'}' from the year and month` },
    'Mixed Currency Flag': { kind: 'added', title: l => `Added '${l.affectedColumns?.[1]}' — '${l.affectedColumns?.[0]}' mixes currencies` },
    'Repeated Order-Level Amount': { kind: 'added', title: l => `Added '${l.affectedColumns?.[1]}' so '${l.affectedColumns?.[0]}' is counted once per order` },
    'Line Cost Derived': { kind: 'added', title: l => `Added '${l.affectedColumns?.[2] || 'line_cost'}' (quantity × unit cost)` },
    'Header Collision': { kind: 'added', title: l => `Kept ${plural(l.affectedColumns?.length || 0, 'column')} whose names clashed` },

    'Null Token Standardization': { kind: 'converted', title: (_l, n) => `Treated ${plural(n ?? 0, 'value')} like "N/A" or "-" as blank` },
    'Placeholder Values Removed': { kind: 'converted', title: (l, n, c) => `Treated ${plural(n ?? 0, 'placeholder')} in '${c}' as missing` },
    'Placeholder Dates Removed': { kind: 'converted', title: (l, n, c) => `Treated ${plural(n ?? 0, 'placeholder date')} in '${c}' as missing` },
    'Units Removed': { kind: 'converted', title: (_l, _n, c) => `Read numbers written with units in '${c}'` },
    'Percent Scale Standardized': { kind: 'converted', title: (_l, n, c) => `Put ${plural(n ?? 0, 'value')} in '${c}' on the same percent scale` },
    'Durations Converted': { kind: 'converted', title: (_l, n, c) => `Converted ${plural(n ?? 0, 'duration')} in '${c}' to minutes` },
    'Category Canonicalization': { kind: 'converted', title: (_l, n, c) => `Merged spelling variants in '${c}' (${plural(n ?? 0, 'cell')})` },

    'Coercion Loss Flag': { kind: 'check', title: (_l, n, c) => `${plural(n ?? 0, 'value')} in '${c}' couldn't be read as numbers` },
    'Total Row Flag': { kind: 'check', title: (_l, n) => `${plural(n ?? 0, 'row')} look like totals but were kept` },
    'Repeated Rows Kept': { kind: 'check', title: (_l, n) => `${plural(n ?? 0, 'row')} repeat exactly and were kept` },
    'Ambiguous Date Flag': { kind: 'check', title: (l, _n, c) => `Day/month order assumed for '${c}'` },
    'Line Total Mismatch Flag': { kind: 'check', title: l => `'${l.affectedColumns?.[0]}' doesn't always equal quantity × price` },
    'Revenue From Price × Quantity': { kind: 'check', title: () => 'Revenue is computed as quantity × unit price' },
    'Mixed Scale Flag': { kind: 'check', title: (_l, _n, c) => `'${c}' mixes 0–1 and 0–100 values` },
    'Outlier Flag': { kind: 'check', title: (_l, n, c) => `${plural(n ?? 0, 'unusual value')} in '${c}'` },
    'Sign Anomaly Flag': { kind: 'check', title: (_l, n, c) => `${plural(n ?? 0, 'negative value')} in '${c}'` },
    'Range Anomaly Flag': { kind: 'check', title: (_l, n, c) => `${plural(n ?? 0, 'value')} out of range in '${c}'` },
    'Date Order Flag': { kind: 'check', title: (_l, n) => `${plural(n ?? 0, 'row')} end before they start` },
    'Possible Typo Flag': { kind: 'check', title: (_l, _n, c) => `Possible typos in '${c}'` },
    'Multi-Value Cell Flag': { kind: 'check', title: (_l, n, c) => `${plural(n ?? 0, 'cell')} in '${c}' hold several values` },
    'Missing Data Flag': { kind: 'check', title: (_l, _n, c) => `'${c}' is mostly empty` },

    'Kept As Uploaded': { kind: 'kept', title: l => keptTitle(l) },
};

function keptTitle(l: ETLLog): string {
    switch (l.revert?.option) {
        case 'keepDuplicateRows': return 'Duplicate rows kept';
        case 'keepTotalRows': return 'Total rows kept';
        case 'keepWideLayout': return 'Period columns kept side by side';
        case 'keepNameColumns': return 'Name columns kept separate';
        case 'keepPlaceholders': return `Placeholders kept${quoted(l.details) ? ` in '${quoted(l.details)}'` : ''}`;
        default: return 'Kept as uploaded';
    }
}

export function summariseEtlChanges(logs: ETLLog[] | undefined): ChangeSummary {
    const items: ChangeItem[] = [];
    let rowsBefore: number | undefined;
    let rowsAfter: number | undefined;
    (logs || []).forEach((l, index) => {
        if (l.step === 'Final Summary') { rowsBefore = l.rowsBefore; rowsAfter = l.rowsAfter; return; }
        if (l.status === 'skipped') return;
        const rule = RULES[l.step];
        if (!rule) return;
        const count = rowsDropped(l) ?? l.affectedRows ?? (rule.kind === 'removed' || l.step === 'Null Token Standardization' ? firstNumber(l.details) : undefined);
        const column = quoted(l.details) || l.affectedColumns?.[0];
        items.push({
            id: `${l.step}:${index}`,
            kind: rule.kind,
            title: rule.title(l, count, column),
            detail: l.details,
            columns: l.affectedColumns || [],
            count,
            samples: l.removedRowSamples,
            revert: l.revert,
        });
    });
    const byKind: Record<ChangeKind, ChangeItem[]> = { removed: [], added: [], converted: [], check: [], kept: [] };
    for (const item of items) byKind[item.kind].push(item);

    const parts: string[] = [];
    const removedRows = byKind.removed.filter(i => /row/.test(i.title)).reduce((s, i) => s + (i.count || 0), 0);
    if (removedRows) parts.push(`${plural(removedRows, 'row')} removed`);
    if (byKind.added.length) parts.push(`${plural(byKind.added.length, 'column change', 'column changes')}`);
    if (byKind.converted.length) parts.push(`${plural(byKind.converted.length, 'value fix', 'value fixes')}`);
    if (byKind.check.length) parts.push(`${plural(byKind.check.length, 'thing', 'things')} to check`);
    const headline = parts.length ? parts.join(' · ') : 'Nothing needed changing';
    return { items, byKind, rowsBefore, rowsAfter, headline };
}
