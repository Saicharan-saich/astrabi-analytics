/**
 * The column dictionary: what each column of a dataset means, kept with the
 * dataset and used for every question, for any data — not rules for one kind
 * of file.
 *
 * For each column:
 *   meaning     one plain sentence
 *   unit        £, days, minutes, %, units
 *   formula     how it is worked out from other columns, found on the rows
 *   combine     add up / average / latest value / count / group by
 *   good        which way is good: higher (sales), lower (defects, waiting
 *               time, overspend) or neither
 *   negative    what a value below zero means
 *   words       what people call it ("over budget", "losses", "drop-offs")
 *
 * Built in three layers, each filling only what the one before left open:
 *   1. rules: the cleaner's roles, the data shape and formulas found on the
 *      rows, and directions that names make plain (defects, refunds, revenue);
 *   2. the AI, given names, types, roles and formulas only — never a value —
 *      writes the meaning, direction and everyday words for the rest;
 *   3. the user, in the column review: their word wins, and is remembered for
 *      that column the next time the same kind of file is uploaded.
 */
import { ColumnType, type ColumnSemantic, type Dataset, type DatasetDomainProfile } from '../types';
import { describeDatasetShape } from './datasetShape';
import { describeFormula, type ColumnFormula } from '../utils/columnFormulas';
import { datasetSignature } from './columnCorrectionsService';

export interface ColumnMeaning {
    column: string;
    meaning?: string;
    unit?: string;
    formula?: string;
    combine: 'add up' | 'average' | 'latest value' | 'count' | 'group by' | 'date' | 'identifier';
    good?: 'higher' | 'lower' | 'neutral';
    negative?: string;
    words: string[];
    source: 'rules' | 'ai' | 'user';
    /** False when the meaning is a guess the user should confirm (an abbreviation, an internal code). */
    sure: boolean;
    /** What to ask the user when it is not sure. */
    question?: string;
}

const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasToken = (name: string, words: RegExp) => tokens(name).some(token => words.test(token));

/** Things where less is better, said plainly in the name. */
const LESS_IS_BETTER = /^(defects?|errors?|faults?|failures?|failed|complaints?|returns?|returned|refunds?|refunded|churn|churned|cancell?ations?|cancell?ed|attrition|leavers?|absences?|absent|sickness|sick|delays?|delayed|late|lateness|wait|waiting|downtime|scrap|waste|rejects?|rejected|bounces?|bounced|arrears|overdue|incidents?|accidents?|injur(y|ies)|overspend|overspent|deficit|losses|loss|breaches?|escalations?|backlog|stockouts?|shrinkage|damages?|damaged|disputes?|chargebacks?|no_?shows?|noshows?|overtime|cost|costs|expenses?|spend|spent|debt)$/;
/** Things where more is better. */
const MORE_IS_BETTER = /^(revenue|sales|takings|income|profit|profits|margin|orders|units|conversions?|converted|score|rating|ratings|satisfaction|nps|csat|retention|retained|attendance|yield|output|productivity|savings|surplus|bookings|signups|leads|wins|won|renewals?|visits|visitors|engagement|uptime|throughput|completed|completions)$/;
/** Snapshots: a balance or a level on a date, never added up across dates. */
const SNAPSHOT = /^(balance|stock|inventory|on_hand|headcount|level|levels|backlog|outstanding|open)$/;
/** A plan set against what happened. */
const PLAN = /^(budget|budgeted|plan|planned|target|targets|forecast|forecasted|goal|quota|expected|estimate|estimated)$/;

/** Which way is good, from a column's name alone (undefined when the name does not say). */
export function nameDirection(name: string, role: ColumnType): ColumnMeaning['good'] {
    if (role !== ColumnType.METRIC && role !== ColumnType.BOOLEAN) return undefined;
    if (hasToken(name, LESS_IS_BETTER)) return 'lower';
    if (hasToken(name, MORE_IS_BETTER)) return 'higher';
    if (hasToken(name, PLAN)) return 'neutral';
    return undefined;
}

function ruleMeaning(name: string, role: ColumnType, inShape: { amounts: Set<string>; perRow: Set<string>; formula?: ColumnFormula; currency?: string }): ColumnMeaning {
    const combine: ColumnMeaning['combine'] = role === ColumnType.DATE ? 'date'
        : role === ColumnType.ID ? 'identifier'
            : role === ColumnType.METRIC ? (hasToken(name, SNAPSHOT) ? 'latest value' : inShape.perRow.has(name) ? 'average' : 'add up')
                : role === ColumnType.BOOLEAN ? 'count' : 'group by';
    const good = nameDirection(name, role);
    const f = inShape.formula;
    return {
        column: name,
        unit: inShape.currency ? currencySymbol(inShape.currency) : hasToken(name, /^(pct|percent|percentage|rate)$/) ? '%' : undefined,
        formula: f ? describeFormula(f) : undefined,
        combine,
        good,
        negative: f && /difference|change|margin/.test(f.kind) ? `${f.b.replace(/_/g, ' ')} is higher than ${f.a.replace(/_/g, ' ')}` : undefined,
        words: [],
        source: 'rules',
        sure: !unclearName(name),
    };
}

/**
 * Short names everyone in business reads the same way: trusted as they are.
 * Anything else this short ("LOS", "OEE", "Adj", "Var2") is a guess until the
 * user says what it means — the same letters mean different things in a
 * hospital and a call centre.
 */
const COMMON_SHORT = new Set(['id', 'qty', 'sku', 'vat', 'tax', 'mrr', 'arr', 'nps', 'csat', 'cogs', 'roi', 'kpi', 'eta', 'pct', 'amt', 'avg', 'url', 'utm', 'dob', 'age', 'sex', 'zip', 'city', 'name', 'date', 'time', 'year', 'week', 'day', 'month', 'cost', 'cash', 'card', 'paid', 'net', 'gross', 'total', 'price', 'sales', 'units', 'type', 'size', 'item', 'shop', 'store', 'site', 'team', 'role', 'plan', 'tier', 'note', 'notes', 'email', 'phone', 'status', 'region', 'brand', 'stock', 'unit', 'rate', 'fee', 'fees', 'tip', 'tips', 'gbp', 'usd', 'eur', 'uk', 'us', 'eu', 'hr', 'it', 'pos', 'crm', 'b2b', 'b2c', 'ytd', 'mtd', 'qtd', 'yoy', 'mom', 'aov', 'ltv', 'cac', 'cpc', 'cpm', 'ctr', 'gmv', 'ebitda', 'p&l', 'pnl', 'wip', 'fte', 'kg', 'km', 'mins', 'hrs', 'dept', 'cust', 'prod', 'emp', 'mgr', 'inv', 'acct', 'txn', 'trans', 'desc', 'loc', 'addr', 'bal', 'rev', 'disc', 'ship', 'ord', 'num', 'no', 'nbr', 'cnt', 'ttl', 'qty', 'sms', 'vip', 'api', 'gst', 'hst', 'pst', 'ein', 'vin', 'imei', 'ip', 'os', 'ux', 'ui', 'cv', 'en', 'fr', 'de', 'at', 'on', 'by', 'of', 'per', 'to', 'from', 'in', 'out', 'is', 'has', 'new', 'old', 'max', 'min', 'sum', 'mean', 'end', 'start', 'open', 'zone', 'code_no',
    // Everyday short words (not abbreviations): a name made of these says what it is.
    'bed', 'car', 'van', 'bus', 'job', 'pay', 'bar', 'cup', 'box', 'bag', 'kit', 'pet', 'art', 'ad', 'ads', 'app', 'web', 'map', 'lot', 'row', 'use', 'run', 'win', 'won', 'bid', 'buy', 'log', 'tv', 'pc', 'all', 'any', 'tea', 'gas', 'oil', 'fuel', 'food', 'meal', 'dish', 'menu', 'room', 'desk', 'ward', 'area', 'wage', 'sale', 'deal', 'lead', 'risk', 'task', 'goal', 'step', 'page', 'view', 'hour', 'bill', 'debt', 'loan', 'rent', 'gift', 'game', 'file', 'stay', 'trip', 'seat', 'shift', 'call', 'mail', 'post', 'text', 'tag', 'tags', 'link', 'user', 'list', 'cart', 'pack', 'case', 'part', 'tool', 'cat', 'fit', 'tax', 'due', 'won', 'lost', 'sold', 'kept', 'left', 'paid', 'owed', 'gain', 'loss', 'wait', 'late', 'miss', 'hit', 'yes', 'flag_yes']);
/** Names that say nothing on their own: an internal grouping or a code only the business knows. */
const VAGUE_NAME = /^(bucket|flag|code|class|grp|cat|misc|other|adj|adjustment|val|value|field|col|column|data|info|x|y|z|ref|key|band|indicator|ind|marker|bin|mode|kind)$/;

/** Is this column's name too unclear to trust a guess about it? */
export function unclearName(name: string): boolean {
    const parts = tokens(name);
    if (!parts.length) return true;
    // A copy or a numbered field ("var2", "amount_2", "field_7") — which one is it?
    if (/^(field|col|column|unnamed|var|value|val|amount|x|data)_?\d+$/i.test(name.replace(/\s+/g, '_'))) return true;
    // An internal letter code ("type_b", "group_a"): which one is it, and what is it?
    if (parts.length > 1 && /^[a-z]$/.test(parts[parts.length - 1]) && !/^(x|y|z)$/.test(parts[parts.length - 1])) return true;
    // As written: "LOS" in capitals is an acronym; "ward" is a word.
    const written = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const acronym = (part: string, i: number) => {
        const word = part.replace(/\d+$/, '');
        if (!word || /^\d+$/.test(part) || COMMON_SHORT.has(word)) return false;
        if (word.length <= 3) return true;
        // Four letters: an acronym when written in capitals or with no vowel ("OPEX", "lnth").
        const raw = (written[i] || '').replace(/\d+$/, '');
        return word.length === 4 && (raw === raw.toUpperCase() && /[A-Z]/.test(raw) || !/[aeiouy]/.test(word));
    };
    if (parts.length === 1) {
        const word = parts[0].replace(/\d+$/, '');
        if (VAGUE_NAME.test(word)) return true;
        return acronym(parts[0], 0);
    }
    // Every word is an unknown abbreviation ("los_hrs" is fine because "hrs" is known; "los_ald" is not).
    return parts.every((part, i) => acronym(part, i));
}

const currencySymbol = (code: string) => ({ GBP: '£', USD: '$', EUR: '€', INR: '₹', JPY: '¥' } as Record<string, string>)[code] || code;

const MEANINGS_KEY = 'QuickInsight-column-meanings-v1';
type Remembered = Record<string, Record<string, Partial<Pick<ColumnSemantic, 'description' | 'goodDirection' | 'negativeMeans' | 'aliases' | 'unit'>>>>;
function readRemembered(): Remembered {
    try { return JSON.parse(localStorage.getItem(MEANINGS_KEY) || '{}') || {}; } catch { return {}; }
}

/** Remember what the user said a column means, for the next upload of the same kind of file. */
export function rememberMeanings(columnNames: string[], semantics: Record<string, ColumnSemantic>): void {
    try {
        const all = readRemembered();
        const signature = datasetSignature(columnNames);
        const bucket = { ...(all[signature] || {}) };
        for (const [name, s] of Object.entries(semantics)) {
            if (s.meaningSource !== 'user') continue;
            bucket[name.toLowerCase()] = { description: s.description, goodDirection: s.goodDirection, negativeMeans: s.negativeMeans, aliases: (s.aliases || []).map(word => word.trim()).filter(Boolean), unit: s.unit };
        }
        all[signature] = bucket;
        localStorage.setItem(MEANINGS_KEY, JSON.stringify(all));
    } catch { /* storage unavailable: meanings still apply to this dataset */ }
}

/** What the user said before about these columns (same kind of file), if anything. */
export function rememberedMeanings(columnNames: string[]): Record<string, Partial<ColumnSemantic>> {
    const bucket = readRemembered()[datasetSignature(columnNames)] || {};
    const out: Record<string, Partial<ColumnSemantic>> = {};
    for (const name of columnNames) if (bucket[name.toLowerCase()]) out[name] = { ...bucket[name.toLowerCase()], meaningSource: 'user' };
    return out;
}

/** Every column's meaning, from rules, the AI and the user (the user's word wins). */
export function columnDictionary(dataset: Dataset): ColumnMeaning[] {
    const columns = dataset.columns.filter(c => !c.name.startsWith('__'));
    let shape: ReturnType<typeof describeDatasetShape> | null = null;
    try { shape = describeDatasetShape(dataset); } catch { shape = null; }
    const formulaFor = new Map((shape?.formulas || []).map(f => [f.result, f]));
    const amounts = new Set(shape?.amounts || []);
    const perRow = new Set(shape?.perRowNumbers || []);
    const semantics = dataset.domainProfile?.columnSemantics || {};
    const remembered = rememberedMeanings(columns.map(c => c.name));
    return columns.map(column => {
        const base = ruleMeaning(column.name, column.type, { amounts, perRow, formula: formulaFor.get(column.name), currency: column.currency });
        const said = { ...semantics[column.name], ...remembered[column.name] } as Partial<ColumnSemantic>;
        if (said.isHidden) return null;
        const source = said.meaningSource || (said.description ? 'ai' : 'rules');
        return {
            ...base,
            meaning: said.description?.trim() || undefined,
            unit: said.unit || base.unit,
            // A user's direction always wins; the AI's fills a gap, or replaces a rule only when it is sure.
            good: said.meaningSource === 'user' ? (said.goodDirection || base.good) : (base.good || said.goodDirection),
            negative: said.negativeMeans || base.negative,
            words: [...new Set([...(said.aliases || [])].map(w => w.trim()).filter(Boolean))].slice(0, 8),
            source,
            // The user's word settles it; otherwise either the AI or the name can say it is a guess.
            // (A direction alone does not say what the column is: the user has to say what it means.)
            sure: said.meaningSource === 'user' && (said.description?.trim() || said.meaningSure) ? true : said.meaningSure === false ? false : base.sure,
            question: said.meaningQuestion || `What does "${column.name.replace(/_/g, ' ')}" mean in your file?`,
        } as ColumnMeaning;
    }).filter((m): m is ColumnMeaning => Boolean(m));
}

/** The dictionary as the AI reads it with every question: words about columns, never values. */
export function dictionaryForPrompt(dataset: Dataset): string {
    const entries = columnDictionary(dataset).filter(m => !m.sure || m.meaning || m.good || m.negative || m.words.length || m.formula);
    if (!entries.length) return '';
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const lines = entries.map(m => {
        const parts: string[] = [];
        if (!m.sure) {
            return `- ${q(m.column)}: NOT CONFIRMED${m.meaning ? ` (a guess: ${m.meaning.replace(/\.$/, '')})` : ''}. If a question depends on what this column means, ask (clarify) instead of assuming.`;
        }
        if (m.meaning) parts.push(m.meaning.replace(/\.$/, ''));
        if (m.unit) parts.push(`in ${m.unit}`);
        if (m.good === 'higher') parts.push('higher is better');
        else if (m.good === 'lower') parts.push('higher is worse');
        else if (m.good === 'neutral') parts.push('neither higher nor lower is better on its own');
        if (m.negative) parts.push(`below 0 means ${m.negative}`);
        if (m.words.length) parts.push(`people call it: ${m.words.join(', ')}`);
        return `- ${q(m.column)}: ${parts.join('; ')}${m.source === 'user' ? ' (set by the user)' : ''}`;
    });
    return `COLUMN MEANINGS (what each column means and which way is good; the user's settings are final):\n${lines.join('\n')}`;
}

/** The request for the AI to fill the meanings: names, types, roles and formulas only. */
export function dictionaryRequest(dataset: Dataset): string {
    const dictionary = columnDictionary(dataset);
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const lines = dictionary.map(m => `- ${q(m.column)}: ${m.combine}${m.unit ? `, in ${m.unit}` : ''}${m.formula ? `, worked out as ${m.formula}` : ''}${m.good ? `, ${m.good === 'higher' ? 'higher is better' : m.good === 'lower' ? 'higher is worse' : 'no better direction'} (already known)` : ''}`);
    const where = dataset.subjectTable ? `sheet or table "${dataset.subjectTable}" of "${dataset.name}"` : `file "${dataset.name}"`;
    const domain = dataset.domainProfile?.domain ? `It looks like ${dataset.domainProfile.domain} data${dataset.domainProfile.grain ? `, one row per ${dataset.domainProfile.grain.toLowerCase()}` : ''}.` : '';
    return `Columns of the ${where}. ${domain}
You see names, roles and formulas only, never values.
${lines.join('\n')}

For every column, say in plain words for a small-business owner:
- "meaning": one short sentence on what it holds (no column names in snake_case).
- "good": "higher" if more is better for the business, "lower" if more is worse (costs, complaints, waiting, overspend), "neutral" if neither (a category, an ID, a date, a plan figure on its own). For a difference worked out between an actual and a plan, decide from the formula which way is good: for money spent, more spending than planned is worse; for money earned, earning less than planned is worse. If you cannot tell whether the amounts are money spent or earned, use "neutral".
- "negative": for numbers that can be below 0, what that means in words ("spent more than budgeted"); otherwise omit.
- "words": up to 5 everyday words or phrases people use when they ask about it ("over budget", "losses", "late deliveries"); for categories, what one value is called ("department").
- "sure": true when the name means one thing to anyone in business (revenue, quantity, order date, VAT, MRR). false when it is an abbreviation with several meanings (LOS is length of stay in a hospital and level of service elsewhere), an internal code or grouping (Bucket, Type B, Adj), a numbered or copied field (Var2), or a figure whose meaning depends on how this business works. Do not mark common names unsure.
- "question": only when "sure" is false, one short plain question to ask the owner ("What does LOS mean in your file: length of stay, or something else?").
Keep "good" as given where it says (already known).
Return ONLY JSON: {"columns":{"column_name":{"meaning":"...","good":"higher|lower|neutral","negative":"...","words":["..."],"sure":true,"question":"..."}}}`;
}

/** Merge the AI's meanings into the profile, never over the user's. */
export function applyDictionary(profile: DatasetDomainProfile, reply: unknown, dataset: Dataset): DatasetDomainProfile {
    const columns = (reply as any)?.columns && typeof (reply as any).columns === 'object' ? (reply as any).columns : {};
    const semantics: Record<string, ColumnSemantic> = { ...profile.columnSemantics };
    const remembered = rememberedMeanings(dataset.columns.map(c => c.name));
    for (const column of dataset.columns) {
        const current: ColumnSemantic = semantics[column.name] || {
            role: column.type, aggregation: column.type === ColumnType.METRIC ? 'SUM' : 'NONE', format: 'raw',
            humanLabel: column.name.replace(/_/g, ' '), description: '', isHidden: false,
        };
        if (remembered[column.name]) { semantics[column.name] = { ...current, ...remembered[column.name] } as ColumnSemantic; continue; }
        if (current.meaningSource === 'user') continue;
        const said = columns[column.name];
        if (!said || typeof said !== 'object') { semantics[column.name] = current; continue; }
        const good = ['higher', 'lower', 'neutral'].includes(said.good) ? said.good : undefined;
        semantics[column.name] = {
            ...current,
            description: typeof said.meaning === 'string' && said.meaning.trim() ? said.meaning.trim().slice(0, 200) : current.description,
            goodDirection: good || current.goodDirection,
            negativeMeans: typeof said.negative === 'string' && said.negative.trim() ? said.negative.trim().slice(0, 120) : current.negativeMeans,
            aliases: Array.isArray(said.words) ? said.words.map(String).map((w: string) => w.trim()).filter(Boolean).slice(0, 5) : current.aliases,
            meaningSure: said.sure === false ? false : said.sure === true ? true : current.meaningSure,
            meaningQuestion: said.sure === false && typeof said.question === 'string' && said.question.trim() ? said.question.trim().slice(0, 160) : current.meaningQuestion,
            meaningSource: 'ai',
        };
    }
    return { ...profile, columnSemantics: semantics, meaningsVersion: 1 };
}

/** Which way is good for a column, as the dictionary says (undefined when nobody knows). */
export function goodDirectionOf(dataset: Dataset, column: string): ColumnMeaning['good'] {
    return columnDictionary(dataset).find(m => m.column === column)?.good;
}

/** Columns whose meaning is a guess and that nobody has explained yet: what to ask the user. */
export function columnsNeedingWord(dataset: Dataset): ColumnMeaning[] {
    return columnDictionary(dataset).filter(m => !m.sure && m.combine !== 'date');
}
