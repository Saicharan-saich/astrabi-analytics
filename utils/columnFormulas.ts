/**
 * How a file's number columns are worked out from each other, found on the
 * user's own rows in the browser: "variance" = "budget" − "actual",
 * "total" = "qty" × "price", "margin_pct" = ("revenue" − "cost") ÷ "revenue" × 100.
 *
 * Only the formula (column names) is ever passed on, never a value. It
 * settles what a name cannot: whether a negative variance means over or under
 * budget depends on which way the file subtracts, and the AI, which sees no
 * values, would otherwise have to guess.
 *
 * A formula is reported only when it holds on at least 98% of the rows where
 * all three columns are filled (rounding allowed), on at least 20 rows, and
 * the columns it uses are not mostly zero (where anything "holds").
 */

export type FormulaKind = 'sum' | 'difference' | 'product' | 'ratio' | 'percent' | 'change' | 'change_percent' | 'margin' | 'margin_percent';

export interface ColumnFormula {
    /** The column that is worked out. */
    result: string;
    kind: FormulaKind;
    /** The two columns it is worked out from, in order: a − b, a ÷ b, (a − b) ÷ b. */
    a: string;
    b: string;
    /** Rows it was checked on. */
    rows: number;
}

const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(0.011, Math.abs(y) * 0.005);

const KINDS: { kind: FormulaKind; fn: (a: number, b: number) => number | null; symmetric: boolean }[] = [
    { kind: 'sum', fn: (a, b) => a + b, symmetric: true },
    { kind: 'difference', fn: (a, b) => a - b, symmetric: false },
    { kind: 'product', fn: (a, b) => a * b, symmetric: true },
    { kind: 'ratio', fn: (a, b) => (b === 0 ? null : a / b), symmetric: false },
    { kind: 'percent', fn: (a, b) => (b === 0 ? null : (a / b) * 100), symmetric: false },
    { kind: 'change', fn: (a, b) => (b === 0 ? null : (a - b) / b), symmetric: false },
    { kind: 'change_percent', fn: (a, b) => (b === 0 ? null : ((a - b) / b) * 100), symmetric: false },
    // A margin: the gap as a share of the first figure ((price − cost) ÷ price).
    { kind: 'margin', fn: (a, b) => (a === 0 ? null : (a - b) / a), symmetric: false },
    { kind: 'margin_percent', fn: (a, b) => (a === 0 ? null : ((a - b) / a) * 100), symmetric: false },
];

const toNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v.replace(/[,£$€\s]/g, ''));
        return Number.isFinite(n) ? n : null;
    }
    return null;
};

/** Formulas linking the given number columns, worked out on (up to) the first 600 rows. */
export function findColumnFormulas(rows: Record<string, any>[], columns: string[]): ColumnFormula[] {
    const sample = rows.slice(0, 600);
    const values = new Map<string, (number | null)[]>();
    for (const column of columns.slice(0, 14)) {
        const list = sample.map(row => toNumber(row[column]));
        const filled = list.filter((v): v is number => v !== null);
        // A column that is mostly zero, or the same everywhere, fits too many formulas to mean anything.
        if (filled.length < 20 || filled.filter(v => v === 0).length > filled.length * 0.5 || new Set(filled).size < 3) continue;
        values.set(column, list);
    }
    const names = [...values.keys()];
    const found: ColumnFormula[] = [];
    for (const result of names) {
        const r = values.get(result)!;
        let best: ColumnFormula | null = null;
        for (const a of names) {
            if (a === result) continue;
            for (const b of names) {
                if (b === result || b === a) continue;
                for (const { kind, fn, symmetric } of KINDS) {
                    if (symmetric && a > b) continue;
                    const va = values.get(a)!, vb = values.get(b)!;
                    let checked = 0, held = 0;
                    for (let i = 0; i < sample.length; i++) {
                        const x = va[i], y = vb[i], z = r[i];
                        if (x === null || y === null || z === null) continue;
                        const expected = fn(x, y);
                        if (expected === null) continue;
                        checked++;
                        if (close(z, expected)) held++;
                        else if (checked - held > Math.max(1, checked * 0.02) + 2) break;
                    }
                    if (checked >= 20 && held >= checked * 0.98) {
                        if (!best || checked > best.rows) best = { result, kind, a, b, rows: checked };
                    }
                }
            }
        }
        if (best) found.push(best);
    }
    // A column that is the result of one formula is not also offered as an input that
    // re-derives another result trivially (a = c + b alongside c = a − b): keep the
    // formula for the column most likely to be computed — a variance, a total, a rate.
    const kept: ColumnFormula[] = [];
    for (const formula of found) {
        const mirror = kept.find(other => new Set([other.result, other.a, other.b]).size === 3
            && [other.result, other.a, other.b].every(name => [formula.result, formula.a, formula.b].includes(name)));
        if (!mirror) { kept.push(formula); continue; }
        if (computedScore(formula.result) > computedScore(mirror.result)) kept.splice(kept.indexOf(mirror), 1, formula);
    }
    return kept;
}

/** How likely a name is to be a worked-out column rather than an entered one. */
function computedScore(name: string): number {
    const n = name.toLowerCase();
    if (/(variance|var\b|diff|difference|gap|over|under|delta|change|growth|margin|profit|net|balance|remaining|surplus|deficit|pct|percent|rate|ratio|share)/.test(n)) return 3;
    if (/(total|sum|amount|value|revenue|sales)/.test(n)) return 2;
    return 1;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The formula in words the AI reads, with what its sign means for a difference. */
export function describeFormula(f: ColumnFormula): string {
    const [a, b, r] = [q(f.a), q(f.b), q(f.result)];
    switch (f.kind) {
        case 'sum': return `${r} = ${a} + ${b}`;
        case 'difference': return `${r} = ${a} − ${b}, so ${r} below 0 means ${b} is higher than ${a}, and above 0 means ${a} is higher`;
        case 'product': return `${r} = ${a} × ${b}`;
        case 'ratio': return `${r} = ${a} ÷ ${b}`;
        case 'percent': return `${r} = ${a} ÷ ${b} × 100 (a percentage)`;
        case 'change': return `${r} = (${a} − ${b}) ÷ ${b} (a fraction; below 0 means ${b} is higher)`;
        case 'change_percent': return `${r} = (${a} − ${b}) ÷ ${b} × 100 (a percentage; below 0 means ${b} is higher)`;
        case 'margin': return `${r} = (${a} − ${b}) ÷ ${a} (a fraction; below 0 means ${b} is higher)`;
        case 'margin_percent': return `${r} = (${a} − ${b}) ÷ ${a} × 100 (a percentage; below 0 means ${b} is higher)`;
    }
}
