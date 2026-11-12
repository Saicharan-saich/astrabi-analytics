/**
 * Value grounding: the AI never sees the values in the data, so when a
 * question says "takeaway", "greeting cards" or "outside the UK" it has to
 * guess how the file writes them — and a guess that matches nothing gives a
 * confident 0%, a blank, or 100%. Run against the real AI, this was the
 * cause of three of every five wrong answers.
 *
 * Here, on the user's own computer, every text value the query filters on is
 * looked up in the column it is compared with:
 *   - it is there                       → nothing to do;
 *   - one value is plainly the same     → the query is corrected to the value
 *     thing (Greeting Card / greeting     as the file writes it, and the
 *     cards, GB / UK, To Go / takeaway)   answer says so;
 *   - nothing, or several, could match  → the person is asked which they
 *                                         mean, from the values really there.
 * The values are only ever shown to the person. Nothing is sent to the AI.
 */
import { ColumnType, type Dataset } from '../../types';
import { resolveCountryName } from '../../utils/chartSuggestions';

export interface GroundedValue { column: string; asked: string; used: string }
export interface UngroundedValue { column: string; asked: string; choices: string[] }
export interface NarrowedValue { column: string; asked: string; used: string; others: string[] }
export interface Grounding { sql: string; corrected: GroundedValue[]; unknown: UngroundedValue[]; narrowed?: NarrowedValue[] }

const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)`;
const LITERAL = String.raw`'((?:[^']|'')*)'`;
const bare = (name: string) => name.replace(/^"|"$/g, '').replace(/""/g, '"');
const escapeSql = (text: string) => text.replace(/'/g, "''");

/** Words that mean the same thing in everyday business speech. One entry per meaning. */
const SAME_THING: string[][] = [
    ['takeaway', 'take away', 'takeout', 'take out', 'to go', 'togo', 'carry out', 'carryout', 'collection', 'pickup', 'pick up'],
    ['eat in', 'dine in', 'dinein', 'for here', 'sit in', 'in house', 'eat here'],
    ['delivery', 'delivered', 'deliveries'],
    ['card', 'credit card', 'debit card', 'credit', 'debit', 'contactless'],
    ['cash', 'cash payment'],
    ['yes', 'y', 'true', '1'], ['no', 'n', 'false', '0'],
    ['male', 'm', 'man', 'men'], ['female', 'f', 'woman', 'women'],
    ['cancelled', 'canceled', 'cancellation', 'cancel'], ['refunded', 'refund', 'returned', 'return'],
    ['completed', 'complete', 'fulfilled', 'done', 'delivered'], ['pending', 'open', 'in progress', 'processing'],
    ['online', 'web', 'website', 'ecommerce', 'e commerce'], ['in store', 'instore', 'shop', 'retail', 'store'],
];

const norm = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const singular = (word: string) => word.length > 3 ? word.replace(/ies$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/([^s])s$/, '$1') : word;
const stem = (text: string) => norm(text).split(' ').map(singular).join(' ');

/** The country a label names, however it is written: a name, a common short form, or a two-letter code (GB, DE). */
function countryOf(label: string): string | null {
    const text = label.trim();
    const known = resolveCountryName(text) || resolveCountryName(norm(text));
    if (known) return known;
    if (/^[A-Za-z]{2}$/.test(text)) {
        try {
            const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(text.toUpperCase());
            if (name && name.toUpperCase() !== text.toUpperCase()) return resolveCountryName(name) || name.toLowerCase();
        } catch { /* not a region code */ }
    }
    return null;
}

function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]; row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = keep;
        }
    }
    return row[b.length];
}

/** The values in a column that are plainly the same thing as what was asked for, best first. */
export function sameValues(asked: string, values: string[]): string[] {
    const a = norm(asked), as = stem(asked);
    if (!a) return [];
    const by = (test: (value: string) => boolean) => values.filter(test);
    // Same once case, punctuation and plurals are set aside.
    let hit = by(v => stem(v) === as);
    if (hit.length) return hit;
    // The same country, however it is written (UK, GB, United Kingdom).
    const country = countryOf(asked);
    if (country) { hit = by(v => countryOf(v) === country); if (hit.length) return hit; }
    // The same thing in everyday speech.
    const group = SAME_THING.find(words => words.includes(a) || words.includes(as));
    if (group) { hit = by(v => group.includes(norm(v)) || group.includes(stem(v))); if (hit.length) return hit; }
    // The asked words inside one value, or one value inside the asked words ("latte" in "Oat Milk Latte" is not unique; "greeting card" in "Greeting Card (pack)" is).
    hit = by(v => { const s = stem(v); return s.length >= 3 && as.length >= 3 && (` ${s} `.includes(` ${as} `) || ` ${as} `.includes(` ${s} `)); });
    if (hit.length) return hit;
    // A slip of the keyboard.
    if (as.length >= 5) { hit = by(v => distance(stem(v), as) <= (as.length >= 9 ? 2 : 1)); if (hit.length) return hit; }
    return [];
}

interface Use { column: string; literal: string; like: boolean; start: number; end: number; fold?: 'lower' | 'upper' }
/** LOWER("col") = 'to go': the value written back has to be in the same case as the column side. */
const foldOf = (text: string): Use['fold'] => /^\s*(?:TRIM\s*\(\s*)?LOWER\s*\(/i.test(text) ? 'lower' : /^\s*(?:TRIM\s*\(\s*)?UPPER\s*\(/i.test(text) ? 'upper' : undefined;

/** Every text value a query compares a column with: =, <>, IN (…), LIKE and ILIKE. */
function textUses(sql: string): Use[] {
    const uses: Use[] = [];
    const wrap = String.raw`(?:(?:LOWER|UPPER|TRIM)\s*\(\s*)*`;
    const close = String.raw`(?:\s*\))*`;
    const one = new RegExp(`${wrap}${IDENT}${close}\\s*(=|<>|!=|NOT\\s+I?LIKE|I?LIKE)\\s*${wrap}${LITERAL}`, 'gi');
    for (const m of sql.matchAll(one)) {
        const at = m.index! + m[0].lastIndexOf(`'${m[3]}'`);
        uses.push({ column: bare(m[1]), literal: m[3].replace(/''/g, "'"), like: /LIKE/i.test(m[2]), start: at, end: at + m[3].length + 2, fold: foldOf(m[0]) });
    }
    const list = new RegExp(`${wrap}${IDENT}${close}\\s+(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, 'gi');
    for (const m of sql.matchAll(list)) {
        const base = m.index! + m[0].indexOf('(', m[0].search(/\bIN\b/i));
        for (const v of m[2].matchAll(new RegExp(LITERAL, 'g'))) uses.push({ column: bare(m[1]), literal: v[1].replace(/''/g, "'"), like: false, start: base + 1 + v.index!, end: base + 1 + v.index! + v[0].length, fold: foldOf(m[0]) });
    }
    return uses;
}

const looksLikeDateOrNumber = (text: string) => /^\s*-?[\d.,:/\-\sT]+\s*$/.test(text) || /^\d{4}-\d{2}/.test(text);

/**
 * Check every text value the query filters on against the column it is
 * compared with, correct the ones that are plainly the same thing, and
 * report the ones that match nothing.
 */
export function groundValues(sql: string, dataset: Pick<Dataset, 'columns' | 'rows'>, options: { keepPatterns?: boolean } = {}): Grounding {
    const corrected: GroundedValue[] = [];
    const unknown: UngroundedValue[] = [];
    const narrowed: NarrowedValue[] = [];
    const columns = new Map(dataset.columns.map(c => [c.name.toLowerCase(), c]));
    const distinct = new Map<string, { values: string[]; counts: Map<string, number> }>();
    const valuesOf = (name: string) => {
        if (!distinct.has(name)) {
            const counts = new Map<string, number>();
            for (const row of dataset.rows) { const v = row[name]; if (v === null || v === undefined || v === '') continue; const s = String(v); counts.set(s, (counts.get(s) || 0) + 1); }
            distinct.set(name, { values: [...counts.keys()], counts });
        }
        return distinct.get(name)!;
    };
    const edits: { start: number; end: number; text: string }[] = [];
    const written = (use: Use, value: string, exact = false) => {
        const cased = use.fold === 'lower' ? value.toLowerCase() : use.fold === 'upper' ? value.toUpperCase() : value;
        return `'${use.like && !exact ? '%' : ''}${escapeSql(cased)}${use.like && !exact ? '%' : ''}'`;
    };
    for (const use of textUses(sql)) {
        const column = columns.get(use.column.toLowerCase());
        // Categories and names only: numbers, dates, IDs and yes/no columns are not matched by wording.
        if (!column || column.type !== ColumnType.DIMENSION) continue;
        const pattern = use.like ? use.literal.replace(/[%_]/g, ' ').trim() : use.literal;
        if (!pattern || looksLikeDateOrNumber(pattern)) continue;
        const { values, counts } = valuesOf(column.name);
        if (!values.length || values.length > 20000) continue;
        const p = pattern.toLowerCase();
        const present = use.like ? values.some(v => v.toLowerCase().includes(p)) : values.some(v => v.toLowerCase() === p);
        if (present) {
            // "a latte" written as LIKE '%latte%' also takes in Oat Milk Latte. When one value IS the
            // word and others only contain it, the one named is used, and the answer says so.
            if (use.like && !options.keepPatterns) {
                const named = values.filter(v => stem(v) === stem(pattern));
                const containing = values.filter(v => v.toLowerCase().includes(p));
                if (named.length === 1 && containing.length > 1) {
                    narrowed.push({ column: column.name, asked: pattern, used: named[0], others: containing.filter(v => v !== named[0]).slice(0, 3) });
                    edits.push({ start: use.start, end: use.end, text: written(use, named[0], true) });
                }
            }
            continue;
        }
        if (unknown.some(u => u.column === column.name && u.asked === pattern) || corrected.some(c => c.column === column.name && c.asked === pattern)) {
            const done = corrected.find(c => c.column === column.name && c.asked === pattern);
            if (done) edits.push({ start: use.start, end: use.end, text: written(use, done.used) });
            continue;
        }
        const same = sameValues(pattern, values);
        if (same.length === 1) {
            corrected.push({ column: column.name, asked: pattern, used: same[0] });
            // The comparison stays as written (LOWER(col) = LOWER('x') still holds for the real value).
            edits.push({ start: use.start, end: use.end, text: written(use, same[0]) });
            continue;
        }
        // Several could be meant, or none: the person chooses, from what is really there (most common first).
        // With nothing alike in a long list of names there is nothing sensible to offer: the query runs
        // as written and the "nothing matched" explanation covers it.
        if (!same.length && values.length > 30) continue;
        const pool = same.length ? same : values;
        const choices = [...pool].sort((x, y) => (counts.get(y) || 0) - (counts.get(x) || 0)).slice(0, 4);
        unknown.push({ column: column.name, asked: pattern, choices });
    }
    let out = sql;
    for (const edit of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return { sql: out, corrected, unknown, ...(narrowed.length ? { narrowed } : {}) };
}

const plain = (name: string) => name.replace(/_/g, ' ');

/** Said on the answer when a value was read as the file writes it. */
export function groundingNote(corrected: GroundedValue[], narrowed: NarrowedValue[] = []): string | null {
    const parts = [
        ...corrected.slice(0, 3).map(c => `"${c.asked}" was read as ${c.used}, as your ${plain(c.column)} column writes it`),
        ...narrowed.slice(0, 2).map(n => `this covers ${n.used} only, not ${n.others.join(', ')}; ask for "all ${n.asked}" to include them`),
    ];
    if (!parts.length) return null;
    const text = parts.join('; ');
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** The question to put to the person when a value matches nothing in its column. */
export function groundingQuestion(question: string, miss: UngroundedValue): { question: string; options: { label: string; question: string }[] } {
    return {
        question: `Nothing in your ${plain(miss.column)} column is called "${miss.asked}". Which did you mean?`,
        options: miss.choices.map(choice => ({ label: choice.slice(0, 60), question: `${question.replace(/[?.!\s]+$/, '')} (where ${plain(miss.column)} is "${choice}")` })),
    };
}
