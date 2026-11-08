/**
 * Is a column a real yes/no — or a category that happens to have two values?
 *
 * Two values is not enough. Male/Female, Urban/Rural, North/South, Pass/Fail
 * and Basic/Premium are categories: their own words are the labels and they
 * are never shown as "yes" and "no". A column is yes/no only when its values
 * are the words of a true/false pair:
 *
 *   true/false · yes/no · y/n · t/f · 1/0 (and booleans)
 *
 * with two guards:
 *   - a coded category (gender 0/1, region 1/0, class 1/0) is not yes/no:
 *     its name says it is a category, the codes just stand for labels
 *   - one letter on its own ("F", "N") or one number ("1") with nothing else
 *     is only yes/no when the name says flag (is_, has_, _flag, _yn)
 *
 * Every part of the app asks this one function, so the cleaner, the semantic
 * layer, the AI description, the data story and the charts always agree.
 */

const YES = new Set(['true', 'yes', 'y', 't', '1', '1.0']);
const NO = new Set(['false', 'no', 'n', 'f', '0', '0.0']);

/** Words that name a category (the last word of the name): gender, region, plan… */
const LABEL_WORDS = new Set(['gender', 'sex', 'region', 'side', 'hand', 'handedness', 'class', 'group', 'type', 'segment', 'category',
    'team', 'shift', 'zone', 'grade', 'level', 'tier', 'channel', 'plan', 'version', 'variant', 'cohort', 'arm', 'area', 'location',
    'site', 'department', 'dept', 'division', 'source', 'direction', 'currency', 'language', 'country', 'state', 'city', 'race',
    'ethnicity', 'size', 'color', 'colour', 'brand', 'model', 'method', 'mode', 'kind', 'status']);
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** "customer_gender", "gender_code", "Region" → a category name (the codes stand for labels). */
export function isLabelName(name: string): boolean {
    const list = words(name);
    while (list.length > 1 && /^(code|cd|no|num|number|key|id|cat)$/.test(list[list.length - 1])) list.pop();
    const head = list[list.length - 1];
    // "status" with 0/1 is usually a flag ("active status"), so only words that say what the labels are count.
    return Boolean(head) && LABEL_WORDS.has(head) && head !== 'status';
}

/** Names that say yes/no: is_member, has_kids, holiday_flag, active_yn, churned. */
export const FLAG_NAME = /(^|[_\s.-])(is|has|was|did|can|flag|flags|yn|bool|boolean|indicator)($|[_\s.-])|_(flag|yn|ind)$|^(is|has)[A-Z_]/;

const token = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const text = String(value).trim().toLowerCase();
    return text === '' ? null : text;
};

/**
 * True when the column is a yes/no. `values` can be a sample; blanks are
 * ignored. `name` is the column name (used by the guards above).
 */
export function isYesNoValues(values: unknown[], name = ''): boolean {
    const seen = new Set<string>();
    for (const value of values) {
        const key = token(value);
        if (key === null) continue;
        if (!YES.has(key) && !NO.has(key)) return false;
        seen.add(key);
        if (seen.size > 4) return false;
    }
    if (!seen.size) return false;
    const hasYes = [...seen].some(key => YES.has(key));
    const hasNo = [...seen].some(key => NO.has(key));
    const numeric = [...seen].every(key => /^[01](\.0)?$/.test(key));
    const letters = [...seen].every(key => key.length === 1 && /[a-z]/.test(key));
    // gender 0/1, region 1/0: codes for labels, not yes and no.
    if (isLabelName(name) && !FLAG_NAME.test(name) && (numeric || letters)) return false;
    if (hasYes && hasNo) return true;
    // Only one side: a lone word (all "Yes", all "true") is still yes/no; a
    // lone letter or digit is only when the name says so.
    if (numeric || letters) return FLAG_NAME.test(name);
    return true;
}

/** Which side a yes/no value is on (null when it is neither). */
export function yesNoSide(value: unknown): boolean | null {
    const key = token(value);
    if (key === null) return null;
    if (YES.has(key)) return true;
    if (NO.has(key)) return false;
    return null;
}

/**
 * Datasets saved before this rule: a column stored as yes/no whose values are
 * really two labels (Male/Female, M/F) goes back to a category. Returns the
 * same array when nothing changes.
 */
export function repairTwoLabelColumns<T extends { name: string; type: string }>(columns: T[], rows: Record<string, unknown>[]): T[] {
    let changed = false;
    const sample = rows.length > 5000 ? rows.filter((_, index) => index % Math.ceil(rows.length / 5000) === 0) : rows;
    const next = columns.map(column => {
        if (column.type !== 'BOOLEAN') return column;
        const values = sample.map(row => row[column.name]);
        const yes = new Set(values.filter(value => value !== null && value !== undefined && value !== '').map(value => String(value).trim().toLowerCase()));
        if (isYesNoValues(values, column.name) || yes.size === 0) return column;
        // Messy yes/no (Yes, No, N/A) stays yes/no; only a pair of labels moves.
        const words = [...yes].filter(value => !YES.has(value) && !NO.has(value));
        if (words.length === 0 || words.length < yes.size - 1) return column;
        changed = true;
        return { ...column, type: 'DIMENSION' } as T;
    });
    return changed ? next : columns;
}
