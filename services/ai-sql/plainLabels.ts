/**
 * Plain words for what people read in answers: yes/no columns as words
 * ("Holiday" / "Not holiday", never 0 and 1), big numbers as "45.5 million",
 * and column names without underscores.
 */

const YES = new Set(['1', 'true', 'yes', 'y', 't']);
const NO = new Set(['0', 'false', 'no', 'n', 'f']);

/** Short names that are always written in capitals. */
const ACRONYMS = new Set(['sms', 'vip', 'cpi', 'nps', 'kpi', 'gdp', 'bmi', 'hiv', 'icu', 'gp', 'mri', 'sku', 'url', 'id', 'uk', 'usa', 'eu', 'crm', 'b2b', 'b2c', 'hr', 'ceo', 'ivf', 'tv', 'pc']);

/** Lower-case a label for the middle of a sentence, keeping capitals in names like SMS. */
export function lowerLabel(label: string): string {
    return label.split(' ').map(word => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase())).join(' ');
}

/** "holiday_flag" → "holiday", "is_member" → "member", "SMS_received" → "SMS received". */
export function flagSubject(column: string): string {
    // Short capitals (SMS, VIP) stay capitals unless the whole name is in capitals.
    const allCaps = column === column.toUpperCase();
    const subject = column
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_.-]+/g, ' ')
        .split(/\s+/)
        .map(word => ((!allCaps && /^[A-Z]{2,5}$/.test(word)) || ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
        .join(' ')
        .replace(/\b(is|has|was|flag|flags|indicator|ind|yn|bool|boolean)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return subject || column.replace(/_/g, ' ');
}

/** Things people do, as they are said in the negative: "showed up" → "Didn't show up". */
const DID: Record<string, string> = {
    showed: 'show', attended: 'attend', arrived: 'arrive', churned: 'churn', converted: 'convert', completed: 'complete',
    cancelled: 'cancel', canceled: 'cancel', returned: 'return', renewed: 'renew', subscribed: 'subscribe', clicked: 'click',
    opened: 'open', purchased: 'purchase', responded: 'respond', defaulted: 'default', enrolled: 'enrol', passed: 'pass',
    failed: 'fail', survived: 'survive', signed: 'sign', booked: 'book', visited: 'visit', left: 'leave', paid: 'pay',
    bought: 'buy', won: 'win', lost: 'lose', joined: 'join', replied: 'reply', ordered: 'order', upgraded: 'upgrade',
};

/** The "no" side in words: "Not holiday", "Didn't show up", "SMS not received". */
function noLabel(subject: string): string {
    const words = subject.split(' ');
    const first = words[0].toLowerCase();
    if (DID[first]) return `Didn't ${[DID[first], ...words.slice(1)].join(' ')}`;
    // "SMS received", "loan approved": something that was or wasn't done to it.
    if (words.length >= 2 && /ed$/.test(words[1]) && words[1].length > 3) {
        const head = words[0];
        return `${head.charAt(0).toUpperCase()}${head.slice(1)} not ${words.slice(1).join(' ')}`;
    }
    if (/^no\b/.test(first)) return `Not a ${subject}`;
    return `Not ${subject}`;
}

/** True when every value is a yes/no (0/1, true/false, yes/no) and both appear or only one does. */
export function isYesNoColumn(values: unknown[]): boolean {
    const seen = new Set<string>();
    for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const key = String(value).trim().toLowerCase();
        if (!YES.has(key) && !NO.has(key)) return false;
        seen.add(YES.has(key) ? 'y' : 'n');
    }
    return seen.size > 0;
}

/** "Holiday" for yes, "Not holiday" for no; "Showed up" / "Didn't show up". */
export function yesNoLabel(column: string, value: unknown): string {
    const key = String(value ?? '').trim().toLowerCase();
    const subject = flagSubject(column);
    const capital = subject.charAt(0).toUpperCase() + subject.slice(1);
    if (YES.has(key)) return capital;
    if (NO.has(key)) return noLabel(subject);
    return String(value ?? '');
}

/** True for the "yes" side of a yes/no value. */
export const isYesValue = (value: unknown) => YES.has(String(value ?? '').trim().toLowerCase());

/** Rows with their yes/no grouping columns turned into words. */
export function relabelYesNo(rows: Record<string, any>[], columns: string[]): { rows: Record<string, any>[]; relabelled: string[] } {
    const relabelled = columns.filter(column => rows.length > 0
        && Object.prototype.hasOwnProperty.call(rows[0], column)
        && isYesNoColumn(rows.map(row => row[column])));
    if (!relabelled.length) return { rows, relabelled };
    return {
        rows: rows.map(row => {
            const copy = { ...row };
            for (const column of relabelled) copy[column] = yesNoLabel(column, row[column]);
            return copy;
        }),
        relabelled,
    };
}

/** 45544116.29 → "45.5 million"; 1234.5 → "1,235"; 12.345 → "12.35". With a symbol when the currency is known. */
export function friendlyNumber(value: number, symbol = ''): string {
    if (!Number.isFinite(value)) return String(value);
    const abs = Math.abs(value);
    const sign = value < 0 ? '−' : '';
    const unit = (n: number, word: string) => `${sign}${symbol}${n.toLocaleString('en-GB', { maximumFractionDigits: n < 10 ? 2 : 1 })} ${word}`;
    if (abs >= 1e9) return unit(abs / 1e9, 'billion');
    if (abs >= 1e6) return unit(abs / 1e6, 'million');
    if (abs >= 1000) return `${sign}${symbol}${Math.round(abs).toLocaleString('en-GB')}`;
    return `${sign}${symbol}${abs.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

/** "weekly_sales" → "weekly sales". */
export const plainName = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** How strong a correlation is, in words. */
export function correlationInWords(r: number, x: string, y: string): { headline: string; summary: string } {
    const a = Math.abs(r);
    const strength = a < 0.1 ? 'almost no' : a < 0.3 ? 'a weak' : a < 0.5 ? 'a moderate' : a < 0.7 ? 'a strong' : 'a very strong';
    const shown = r.toLocaleString('en-GB', { maximumFractionDigits: 2 });
    if (a < 0.1) {
        return {
            headline: `Almost no link between ${x} and ${y}`,
            summary: `There is almost no link between ${x} and ${y} (${shown}, on a scale from −1 to +1). When one goes up or down, the other doesn't change in a way you could rely on.`,
        };
    }
    const direction = r > 0 ? `when ${x} is higher, ${y} tends to be higher too` : `when ${x} is higher, ${y} tends to be lower`;
    return {
        headline: `${strength.charAt(0).toUpperCase() + strength.slice(1)} link between ${x} and ${y}`,
        summary: `There is ${strength} link between ${x} and ${y} (${shown}, on a scale from −1 to +1): ${direction}${a < 0.3 ? ', but only slightly' : ''}. This shows they move together, not that one causes the other.`,
    };
}
