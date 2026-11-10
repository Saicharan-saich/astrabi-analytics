/**
 * What kind of data is this? Worked out in the browser from the columns and
 * the rows' shape (never sent anywhere as values):
 *
 *   hybrid    amounts to add up (sales, cost, quantity) and categories to
 *             split them by — most business data
 *   records   no amounts at all: each row is one appointment, patient, ticket
 *             or survey answer, described by categories, yes/no answers,
 *             dates and numbers such as age. It is measured by counting rows,
 *             counting distinct people, and the share with each answer.
 *   measures  numbers only (readings, prices over time) with little or
 *             nothing to group them by
 */
import { ColumnType, type Dataset } from '../types';
import { flagSubject, isYesNoColumn, yesNoLabel } from './ai-sql/plainLabels';
import { isAdditiveName, isCoordinateName, isPerRowName } from '../utils/numberMeaning';
import { findLineColumns } from './etlMeasureIntegrity';
import { findColumnFormulas, describeFormula, type ColumnFormula } from '../utils/columnFormulas';
import { spokenName } from '../utils/spokenName';

export type DatasetKind = 'hybrid' | 'records' | 'measures';

export interface DatasetShape {
    kind: DatasetKind;
    /** Short name: "Records — nothing to add up". */
    label: string;
    /** One plain sentence on what the data holds. */
    summary: string;
    /** One plain sentence on how QuickInsight measures it. */
    howMeasured: string;
    /** Amounts that add up across rows (sales, cost, units). */
    amounts: string[];
    /** Numbers that describe each row (age, days waited, price, temperature): averaged or put in ranges. */
    perRowNumbers: string[];
    yesNo: string[];
    categories: string[];
    dates: string[];
    /** A column with a different value on every row (appointment ID). */
    rowId?: string;
    /** IDs that repeat: several rows per patient or customer. */
    entityIds: string[];
    /** The yes/no column that looks like the result being tracked (showed up, churned, converted). */
    outcome?: string;
    /** Numbers that are the days between two date columns: date_diff = appointment_day − scheduled_day. */
    dayGaps: Record<string, { from: string; to: string }>;
    /** Tell the story by counting rows and comparing an outcome (no amounts to add up). */
    countStory: boolean;
    /**
     * Rows that are the lines of one order: consecutive rows share this column
     * (Shopify's "Name" #1001, a receipt number, a transaction ID).
     */
    lineKey?: { column: string; word: string };
    /** Order amounts filled on the first line of each order only (Shopify subtotal, shipping, total). */
    firstRowAmounts: string[];
    /** How to add up sales per line: a line amount, or price × quantity. */
    lineSales?: string;
    /** Columns that name the customer (an email, a customer ID) and repeat. */
    customerKeys: string[];
    /** Amounts with some negative rows: refunds, returns or corrections. */
    signedAmounts: string[];
    /** How number columns are worked out from each other ("variance" = "budget" − "actual"). */
    formulas: ColumnFormula[];
    /** What one row is, in words: "appointment". */
    recordWord: string;
    /** The same, plural: "appointments". */
    recordsWord: string;
}

const ID_NAME = /(^|[_\s.-])(id|uuid|guid|key|ref|reference|sku|barcode|ean|isbn)$|^(id|uuid|guid)([_\s.-]|$)|_id_|[a-z]Id$/;
const FREE_TEXT = /(url|link|notes?|description|comment|comments|email|e-mail|phone|mobile|address|postcode|zip|remarks?|summary|message|text|name)$/i;
const NOT_A_MEASURE = /(^|_)(lat|lon|lng|latitude|longitude|zip|postcode|phone|year|yr|month|week|day|hour|quarter)$/i;
/** Numbered things that are names, not amounts: store 12, ward 4, grade 3. */
const CODE_NAME = /(store|branch|shop|site|dept|department|zone|region|area|district|ward|room|class|grade|level|tier|group|team|cluster|segment|category|type|code|line|channel|plant|warehouse|route|terminal|gate|floor|bed|seat|unit|division|cohort|batch|version|stage|step|status|number|no|num|nr)$/i;
const OUTCOME = /(show|showed|attend|no.?show|churn|convert|success|approved|default|cancel|return|readmi|surviv|died|death|dead|deceased|fraud|won|lost|pass|fail|complet|resolv|left|attrition|respon|click|purchas|outcome|target|label|result|bought|subscri|renew|enrol|admit|hired|accept|reject|late|on.?time|defect|spam|exited|exit|retained|stroke|disease|diagnos)/i;
const ROW_WORD = /(appointment|visit|encounter|admission|case|claim|application|call|session|event|booking|order|invoice|transaction|ticket|enrol|registration|reservation|response|survey|record|loan|policy|trip|job|incident|request)/i;

/** Columns that are negative by nature: a variance, a profit, a change, a balance. */
const SIGNED_BY_NATURE = /(^|_)(variance|var|diff|difference|gap|delta|change|growth|profit|loss|balance|surplus|deficit|over|under|margin)(_|$)/i;

/** An order number as shops write it: #1001, INV-204, SO10023, R-55012. */
const ORDER_NUMBER = /^#\s?\d{2,}$|^[A-Z]{1,5}[-#/]?\d{3,}$/i;
/** Columns that name the customer. */
const CUSTOMER_KEY = /(^|_)(e_?mail|email_address|customer_email|buyer_email)$|^(customer|client|buyer|member|guest|patron|account|user)(_?(id|email|no|number|ref|key|code|name))?$/i;
/** A looked-up column's own name: "order → Orders / email → Customers.city" → "city". */
const leafName = (name: string) => name.includes(' → ') ? name.split('.').pop() || name : name;
/** The word for one order from its key's name ("receipt_no" → receipt); a bare "name" or "number" is the order. */
const keyWord = (name: string) => {
    const word = idWord(name);
    return !word || /^(name|number|no|num|ref|reference|id|key|#)$/i.test(word) ? 'order' : word;
};
/** Where each run of a key starts, when rows come in runs (the lines of one order), else null. */
function lineRuns(rows: Record<string, any>[], key: string): boolean[] | null {
    if (rows.length < 6) return null;
    const starts: boolean[] = new Array(rows.length).fill(false);
    const seen = new Set<string>();
    let runs = 0, multi = 0, runLength = 0;
    for (let i = 0; i < rows.length; i++) {
        const value = rows[i][key];
        if (isBlank(value)) return null;
        const text = String(value);
        if (i > 0 && text === String(rows[i - 1][key])) { runLength++; continue; }
        if (seen.has(text)) return null;
        if (runLength > 1) multi++;
        seen.add(text); starts[i] = true; runs++; runLength = 1;
    }
    if (runLength > 1) multi++;
    const continuation = rows.length - runs;
    return multi >= 3 && continuation >= rows.length * 0.05 && runs >= rows.length * 0.1 ? starts : null;
}

const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const isNumeric = (value: unknown) => typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) && !/^-?0\d/.test(value.trim());
const human = (name: string) => spokenName(name);
const plural = (word: string) => /(s|x|ch|sh)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
const list = (items: string[], max = 4, name: (item: string) => string = human) => {
    const shown = items.slice(0, max).map(name);
    const more = items.length - shown.length;
    if (more > 0) return `${shown.join(', ')} and ${more} more`;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] || '';
};
/** "appointment_id" → "appointment", "PatientId" → "patient". */
export const idWord = (name: string) => human(name).replace(/\s*(id|uuid|guid|key|ref|reference|number|no|num|nr|code)$/i, '').trim();

/** A number's name in words: "date_diff" → "days from scheduled day to appointment day" when that is what it is. */
export function numberLabel(name: string, dayGaps: DatasetShape['dayGaps'] = {}): string {
    const gap = dayGaps[name];
    return gap ? `days from ${human(gap.from)} to ${human(gap.to)}` : human(name);
}

const cache = new WeakMap<object, { signature: string; shape: DatasetShape }>();

export function describeDatasetShape(dataset: Pick<Dataset, 'rows' | 'columns'>): DatasetShape {
    const rows = (dataset.rows || []) as Record<string, any>[];
    // Same rows and the same column roles → the same answer.
    const signature = dataset.columns.map(column => `${column.name}:${column.type}`).join('|');
    const cached = cache.get(rows);
    if (cached && cached.signature === signature) return cached.shape;
    const sample = rows.length > 20000 ? rows.filter((_, index) => index % Math.ceil(rows.length / 20000) === 0) : rows;

    const amounts: string[] = [];
    const perRowNumbers: string[] = [];
    const yesNo: string[] = [];
    const categories: string[] = [];
    const dates: string[] = [];
    const ids: { name: string; unique: boolean }[] = [];
    const perRowMetrics: string[] = [];

    for (const column of dataset.columns.filter(c => !c.name.startsWith('__'))) {
        const values = sample.map(row => row[column.name]).filter(value => !isBlank(value));
        if (!values.length) continue;
        if (column.type === ColumnType.DATE || values.slice(0, 50).every(value => value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)))) {
            dates.push(column.name);
            continue;
        }
        // Map coordinates are positions: not an amount, not a grouping.
        if (isCoordinateName(column.name)) continue;
        const distinct = new Set(values.map(String)).size;
        const numeric = values.every(isNumeric);
        const yearLike = numeric && values.every(value => { const n = Number(value); return Number.isInteger(n) && n >= 1900 && n <= 2100; });
        if (column.type === ColumnType.ID || ID_NAME.test(column.name) || (!numeric && distinct / values.length > 0.9 && values.length > 40)) {
            ids.push({ name: column.name, unique: distinct >= values.length * 0.98 });
            continue;
        }
        if (distinct <= 2 && isYesNoColumn(values, column.name) && (column.type !== ColumnType.METRIC || !isAdditiveName(column.name))) {
            yesNo.push(column.name);
            continue;
        }
        if (numeric && !yearLike && !NOT_A_MEASURE.test(column.name)) {
            if (column.type === ColumnType.METRIC) {
                if (isPerRowName(column.name)) { perRowNumbers.push(column.name); perRowMetrics.push(column.name); }
                else amounts.push(column.name);
                continue;
            }
            // A number the cleaner kept as a grouping: age, days waited (an
            // attribute of each row) — or store 12 (a name).
            if (distinct >= 12 && !CODE_NAME.test(human(column.name).replace(/\s+/g, '_'))) {
                perRowNumbers.push(column.name);
                continue;
            }
        }
        if (FREE_TEXT.test(column.name) && distinct > 50) continue;
        if (distinct >= 2) categories.push(column.name);
    }

    // A number that is just the days between two of the dates (a waiting time).
    const dayGaps: DatasetShape['dayGaps'] = {};
    const dayOf = (value: unknown): number | null => {
        const text = value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : typeof value === 'string' ? value.slice(0, 10) : '';
        const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
        return Number.isFinite(time) ? time / 86_400_000 : null;
    };
    const probe = sample.slice(0, 500);
    for (const name of perRowNumbers) {
        for (const from of dates) for (const to of dates) {
            if (from === to || dayGaps[name]) continue;
            let checked = 0; let matched = 0;
            for (const row of probe) {
                const a = dayOf(row[from]); const b = dayOf(row[to]); const n = Number(row[name]);
                if (a === null || b === null || isBlank(row[name]) || !Number.isFinite(n)) continue;
                checked++;
                if (Math.abs((b - a) - n) < 0.5) matched++;
            }
            if (checked >= 20 && matched >= checked * 0.95) dayGaps[name] = { from, to };
        }
    }

    // Lines of one order: consecutive rows share a key, and each key value
    // appears in one run only. Read from the rows in their file order.
    const ordered = rows.slice(0, 20000);
    const keyCandidates = dataset.columns.filter(c => !c.name.startsWith('__') && !dates.includes(c.name) && !amounts.includes(c.name) && !perRowNumbers.includes(c.name) && !yesNo.includes(c.name));
    let lineKey: DatasetShape['lineKey'];
    let lineStarts: boolean[] | null = null;
    let bestScore = -1;
    for (const column of keyCandidates) {
        const starts = lineRuns(ordered, column.name);
        if (!starts) continue;
        const values = ordered.slice(0, 500).map(row => String(row[column.name] ?? ''));
        const score = (column.type === ColumnType.ID ? 2 : 0) + (ROW_WORD.test(column.name) ? 2 : 0)
            + (values.filter(v => ORDER_NUMBER.test(v.trim())).length >= values.length * 0.9 ? 2 : 0);
        if (score > bestScore) { bestScore = score; lineStarts = starts; lineKey = { column: column.name, word: keyWord(column.name) }; }
    }
    const firstRowAmounts: string[] = [];
    let lineSales: string | undefined;
    if (lineKey && lineStarts) {
        const starts = lineStarts;
        const groupFirsts = starts.map((first, i) => first && i + 1 < starts.length && !starts[i + 1]);
        for (const name of [...amounts, ...perRowNumbers]) {
            let firsts = 0, firstFilled = 0, rest = 0, restBlank = 0;
            ordered.forEach((row, i) => {
                if (groupFirsts[i]) { firsts++; if (!isBlank(row[name])) firstFilled++; } else if (!starts[i]) { rest++; if (isBlank(row[name])) restBlank++; }
            });
            if (firsts >= 3 && rest > 0 && firstFilled >= firsts * 0.9 && restBlank >= rest * 0.95) firstRowAmounts.push(name);
        }
        const lineColumns = findLineColumns([...amounts, ...perRowNumbers].filter(name => !firstRowAmounts.includes(name)));
        const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
        if (lineColumns.lineAmount) lineSales = `SUM(${q(lineColumns.lineAmount)})`;
        else if (lineColumns.unitPrice && lineColumns.quantity) lineSales = `SUM(${q(lineColumns.unitPrice)} * ${q(lineColumns.quantity)})`;
        if (!ids.some(id => id.name === lineKey!.column)) ids.push({ name: lineKey.column, unique: false });
        const index = categories.indexOf(lineKey.column);
        if (index >= 0) categories.splice(index, 1);
    }
    // Who the customer is: an email or customer ID that repeats.
    const customerKeys = dataset.columns.map(c => c.name).filter(name => CUSTOMER_KEY.test(leafName(name)) && name !== lineKey?.column && (() => {
        const values = sample.map(row => row[name]).filter(value => !isBlank(value)).map(String);
        return values.length > 1 && new Set(values).size < values.length * 0.95;
    })());
    for (const name of customerKeys) {
        if (!ids.some(id => id.name === name)) ids.push({ name, unique: false });
        const index = categories.indexOf(name);
        if (index >= 0) categories.splice(index, 1);
    }
    // How number columns are worked out from each other, checked on the rows here.
    let formulas: ColumnFormula[] = [];
    try { formulas = findColumnFormulas(rows, [...amounts, ...perRowNumbers]); } catch { formulas = []; }
    const naturallySigned = new Set(formulas.filter(f => f.kind === 'difference' || f.kind === 'change' || f.kind === 'change_percent' || f.kind === 'margin' || f.kind === 'margin_percent').map(f => f.result));
    const signedAmounts = amounts.filter(name => {
        // A variance, a profit or a change is negative by nature, not because of refunds.
        if (naturallySigned.has(name) || SIGNED_BY_NATURE.test(name)) return false;
        let negative = 0, filled = 0;
        for (const row of sample) { const v = row[name]; if (isBlank(v)) continue; filled++; if (Number(v) < 0) negative++; }
        return negative > 0 && negative < filled * 0.5;
    });

    const unique = ids.filter(id => id.unique);
    const rowId = unique.find(id => ROW_WORD.test(id.name))?.name || unique[0]?.name;
    const entityIds = ids.filter(id => !id.unique).map(id => id.name);
    // A yes/no looked up from another table ("customer → Customers.accepts_marketing")
    // describes that table, not the result this table tracks.
    const outcome = [...yesNo].filter(name => !name.includes(' → ')).map((name, index) => ({ name, score: (OUTCOME.test(name) ? 10 : 0) + index / 100 }))
        .filter(item => item.score >= 10).sort((a, b) => b.score - a.score)[0]?.name;
    const recordWord = (rowId && idWord(rowId)) || 'row';
    const recordsWord = plural(recordWord);

    const groupings = categories.length + yesNo.length;
    // Measured numbers (sales, price, temperature) make it hybrid; numbers the
    // cleaner kept as attributes of each row (age, days waited) do not.
    const measured = amounts.length + perRowMetrics.length;
    const kind: DatasetKind = measured > 0
        ? (groupings > 0 ? 'hybrid' : 'measures')
        : (groupings > 0 || !perRowNumbers.length ? 'records' : 'measures');

    const countStory = kind === 'records' || (amounts.length === 0 && Boolean(outcome) && groupings + perRowNumbers.length > 1);
    const entity = entityIds[0] ? plural(idWord(entityIds[0])) : '';
    const numberName = (name: string) => numberLabel(name, dayGaps);
    const outcomeWords = outcome ? yesNoLabel(outcome, true).toLowerCase() : '';
    const described = [
        categories.length ? 'categories' : '',
        yesNo.length ? 'yes/no answers' : '',
        dates.length ? 'dates' : '',
        perRowNumbers.length ? `numbers such as ${list(perRowNumbers, 2, numberName)}` : '',
    ].filter(Boolean);
    const describedText = described.length > 1 ? `${described.slice(0, -1).join(', ')} and ${described[described.length - 1]}` : described[0] || 'its columns';

    let shape: DatasetShape;
    if (kind === 'records') {
        shape = {
            kind, amounts, perRowNumbers, yesNo, categories, dates, rowId, entityIds, outcome, recordWord, recordsWord, dayGaps, countStory, lineKey, firstRowAmounts, lineSales, customerKeys, signedAmounts, formulas,
            label: 'Records — nothing to add up',
            summary: `Each row is one ${recordWord}, described by ${describedText}. There are no amounts such as sales or cost.`,
            howMeasured: `QuickInsight measures it by counting ${recordsWord}${entity ? ` and distinct ${entity}` : ''}, and by the share of ${recordsWord} with each answer${outcome ? ` (for example the % that ${outcomeWords})` : ''}${perRowNumbers.length ? `; ${list(perRowNumbers, 2, numberName)} ${perRowNumbers.length === 1 ? 'is' : 'are'} averaged or put into ranges` : ''}.`,
        };
    } else if (kind === 'measures') {
        const numbers = [...amounts, ...perRowNumbers];
        shape = {
            kind, amounts, perRowNumbers, yesNo, categories, dates, rowId, entityIds, outcome, recordWord, recordsWord, dayGaps, countStory, lineKey, firstRowAmounts, lineSales, customerKeys, signedAmounts, formulas,
            label: 'Numbers only',
            summary: `Mostly numbers (${list(numbers)}), with nothing to group them by${dates.length ? ' except the date' : ''}.`,
            howMeasured: `QuickInsight looks at totals and averages${dates.length ? ', how they change over time' : ''}, their ranges, and which numbers move together.`,
        };
    } else {
        shape = {
            kind, amounts, perRowNumbers, yesNo, categories, dates, rowId, entityIds, outcome, recordWord, recordsWord, dayGaps, countStory, lineKey, firstRowAmounts, lineSales, customerKeys, signedAmounts, formulas,
            label: amounts.length ? 'Amounts and categories' : 'Scores and categories',
            summary: `${amounts.length ? `Amounts you can add up (${list(amounts, 3)})` : `Measured numbers (${list(perRowMetrics, 3)})`} and ${[...categories, ...yesNo].length === 1 ? 'a category' : 'categories'} to split them by (${list([...categories, ...yesNo.map(flagSubject)], 3)}).`,
            howMeasured: `QuickInsight ${amounts.length ? 'adds up and averages the amounts' : 'averages the numbers'}, split by the categories${dates.length ? ' and over time' : ''}${outcome ? `, and compares the share that ${outcomeWords}` : ''}.`,
        };
    }
    cache.set(rows, { signature, shape });
    return shape;
}

/**
 * For the AI: how to measure this data, from the column names and roles only
 * (no values). Added to the column list it is sent.
 */
export function shapeForModel(shape: DatasetShape, yesTest: (column: string) => string = column => `"${column.replace(/"/g, '""')}"`): string {
    const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const lines = [`DATA SHAPE: ${shape.kind === 'records' ? 'records with nothing to add up' : shape.kind === 'measures' ? 'numbers only' : 'amounts and categories'}.`];
    if (shape.rowId) lines.push(`Each row is one ${shape.recordWord} (${q(shape.rowId)} is different on every row).`);
    const lineKey = shape.lineKey;
    if (lineKey) {
        const order = lineKey.word;
        lines.push(`${q(lineKey.column)} is the ${order} number: the lines of one ${order} are consecutive rows with the same ${q(lineKey.column)}. Count ${plural(order)} with COUNT(DISTINCT ${q(lineKey.column)}); a figure per ${order} divides by that count, not by the number of rows.`);
        if (shape.firstRowAmounts.length) {
            lines.push(`${shape.firstRowAmounts.map(q).join(', ')} ${shape.firstRowAmounts.length === 1 ? 'is an amount' : 'are amounts'} for the whole ${order}, filled on its first row only and blank on its other rows: SUM ${shape.firstRowAmounts.length === 1 ? 'it' : 'them'} as they are for ${order} totals (each ${order} counts once), and never split ${shape.firstRowAmounts.length === 1 ? 'it' : 'them'} by product or line item.${shape.lineSales ? ` Sales by product or line item: ${shape.lineSales}.` : ''}`);
        }
    }
    const otherIds = shape.entityIds.filter(name => name !== lineKey?.column && !shape.customerKeys.includes(name));
    if (otherIds.length) lines.push(`${otherIds.map(q).join(', ')} repeat${otherIds.length === 1 ? 's' : ''}: one ${idWord(otherIds[0])} can have several rows. Count them with COUNT(DISTINCT ...).`);
    for (const name of shape.customerKeys) lines.push(`${q(name)} identifies the customer and repeats when they come back: count customers with COUNT(DISTINCT ${q(name)}) (blank = no customer recorded).`);
    if (shape.formulas?.length) lines.push(`How columns are worked out (checked on every row of this data): ${shape.formulas.map(describeFormula).join('; ')}. Use these to tell which way a difference goes.`);
    if (shape.signedAmounts.length) lines.push(`Some rows have a negative ${shape.signedAmounts.map(q).join(', ')} (refunds, returns or corrections). Plain SUM gives the figure after them; leave negative rows out only when the question asks for sales before refunds.`);
    if (shape.kind === 'records') {
        lines.push('There are no amounts: never SUM an ID, a yes/no or a category. Measure with:');
        lines.push(`- the number of ${shape.recordsWord}: COUNT(*)`);
        if (shape.yesNo.length) {
            const example = shape.outcome || shape.yesNo[0];
            lines.push(`- rates: the % of rows where a yes/no is yes, e.g. ROUND(100.0 * COUNT_IF(${yesTest(example)}) / COUNT(*), 1) AS ${example.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_rate_pct, always with the number of ${shape.recordsWord} beside it`);
        }
        if (shape.perRowNumbers.length) lines.push(`- ${shape.perRowNumbers.map(q).join(', ')}: AVG or MEDIAN, or ranges with CASE WHEN (e.g. 0, 1-7, 8-30, 31+), never SUM`);
        for (const [name, gap] of Object.entries(shape.dayGaps)) lines.push(`- ${q(name)} is the number of days from ${q(gap.from)} to ${q(gap.to)} (a waiting time).`);
        if (shape.categories.length) lines.push('- the share of rows in each category: COUNT(*) * 100.0 / SUM(COUNT(*)) OVER ()');
    }
    if (shape.outcome) {
        const yes = yesNoLabel(shape.outcome, true).toLowerCase();
        const no = yesNoLabel(shape.outcome, false).toLowerCase();
        lines.push(`The result being tracked looks like ${q(shape.outcome)} (yes = ${yes}, no = ${no}). "Rate", "how many", "why" and "most important" questions are usually about it; say which side you measured in the title (e.g. "% who ${no}").`);
    }
    // For every kind of data: the count behind each figure lets the app judge,
    // from the numbers themselves, which groups are too small to trust.
    lines.push('Beside every rate or average worked out per group, also return how many records are in that group (e.g. COUNT(*) AS group_size). Keep small groups unless the user asks to drop them: the app marks figures based on too few records.');
    return lines.join('\n');
}
