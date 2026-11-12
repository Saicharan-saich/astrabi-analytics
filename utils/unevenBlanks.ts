/**
 * Two number columns set against each other (actual and budget, revenue and
 * cost) where some rows have one and not the other.
 *
 * SUM("actual") − SUM("budget") then compares different sets of rows: a
 * department with 61,000 of budget on rows whose actual spending was never
 * entered looks 61,000 under budget when it is in fact over. Worked out row
 * by row — SUM("actual" − "budget") — a row missing either figure drops out
 * of both sides, which is also what a difference column in the file does.
 *
 * Counted on the user's rows in the browser; only column names and counts are
 * ever passed on.
 */

export interface UnevenPair {
    a: string;
    b: string;
    /** Rows where a is filled and b is blank. */
    onlyA: number;
    /** Rows where b is filled and a is blank. */
    onlyB: number;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && Number.isNaN(v));

/** Pairs of the given columns where rows have one figure and not the other. */
export function unevenBlankPairs(rows: Record<string, any>[], columns: string[]): UnevenPair[] {
    const names = columns.slice(0, 16);
    // Only columns that are blank somewhere can be part of an uneven pair.
    const gaps = new Map<string, Uint8Array>();
    for (const name of names) {
        let any = false;
        const flags = new Uint8Array(rows.length);
        for (let i = 0; i < rows.length; i++) if (blank(rows[i][name])) { flags[i] = 1; any = true; }
        // A column that is blank on nearly every row is a different kind of column (filled once per order), not a gap.
        if (any) gaps.set(name, flags);
    }
    const out: UnevenPair[] = [];
    for (let x = 0; x < names.length; x++) {
        for (let y = x + 1; y < names.length; y++) {
            const fa = gaps.get(names[x]), fb = gaps.get(names[y]);
            if (!fa && !fb) continue;
            let onlyA = 0, onlyB = 0;
            for (let i = 0; i < rows.length; i++) {
                const ba = fa ? fa[i] : 0, bb = fb ? fb[i] : 0;
                if (!ba && bb) onlyA++;
                else if (ba && !bb) onlyB++;
            }
            if (onlyA || onlyB) out.push({ a: names[x], b: names[y], onlyA, onlyB });
        }
    }
    return out;
}

const ident = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)`;
const bare = (name: string) => name.replace(/^"|"$/g, '').replace(/""/g, '"');

/**
 * Rewrite SUM("a") − SUM("b") as SUM("a" − "b") for pairs with uneven blanks.
 * The two are equal when no figure is missing, so the rewrite never changes
 * an answer that was already right.
 */
export function rowWiseDifferences(sql: string, pairs: UnevenPair[]): { sql: string; used: UnevenPair[] } {
    if (!pairs.length) return { sql, used: [] };
    const used: UnevenPair[] = [];
    const find = (a: string, b: string) => pairs.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));
    const pattern = new RegExp(String.raw`\bSUM\s*\(\s*${ident}\s*\)\s*-\s*SUM\s*\(\s*${ident}\s*\)`, 'gi');
    const next = sql.replace(pattern, (whole, a: string, b: string) => {
        const pair = find(bare(a), bare(b));
        if (!pair) return whole;
        if (!used.includes(pair)) used.push(pair);
        return `SUM(${a} - ${b})`;
    });
    // Already row by row: the same rows are left out, so the answer says so too.
    for (const m of next.matchAll(new RegExp(String.raw`\bSUM\s*\(\s*${ident}\s*-\s*${ident}\s*\)`, 'gi'))) {
        const pair = find(bare(m[1]), bare(m[2]));
        if (pair && !used.includes(pair)) used.push(pair);
    }
    return { sql: next, used };
}

const plain = (name: string) => name.replace(/_/g, ' ');
const rowsWord = (n: number) => `${n.toLocaleString('en-GB')} row${n === 1 ? '' : 's'}`;

/** Said on the answer when a difference was worked out row by row because figures are missing. */
export function unevenBlankNote(pairs: UnevenPair[]): string | null {
    if (!pairs.length) return null;
    const parts = pairs.slice(0, 2).map(p => [
        p.onlyA ? `${rowsWord(p.onlyA)} ${p.onlyA === 1 ? 'has' : 'have'} a ${plain(p.a)} but no ${plain(p.b)}` : '',
        p.onlyB ? `${rowsWord(p.onlyB)} ${p.onlyB === 1 ? 'has' : 'have'} a ${plain(p.b)} but no ${plain(p.a)}` : '',
    ].filter(Boolean).join(' and '));
    return `${parts.join('; ')}. Those rows are left out of the difference, so it compares like with like; totals shown beside it still include them, so they may not subtract exactly to it.`;
}

/** Told to the AI with the data description: names and nothing else. */
export function unevenBlankLine(pairs: UnevenPair[]): string | null {
    if (!pairs.length) return null;
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const shown = pairs.slice(0, 4).map(p => `${q(p.a)} and ${q(p.b)}`);
    return `Some rows have one of ${shown.join('; ')} and not the other. Work a difference between two columns out row by row, SUM("a" - "b"), or use the file's own difference column; never SUM("a") - SUM("b"), which would set figures from different rows against each other.`;
}
