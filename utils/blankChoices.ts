/**
 * blankChoices.ts — the choices for one column's blank cells, each with what it
 * does to the numbers, worked out from the cleaning's measurement of that
 * column (BlankProfile). Pure: any column, any file.
 *
 * Each choice says, in plain words:
 *   what it does   ("Count a blank as 0")
 *   the result     the total and average you would get, or the rows you lose
 *   the catch      what goes wrong with it, so nobody picks it blind
 * and one choice is recommended, with the reason.
 */

import type { BlankChoice, BlankProfile } from '../types';
import { decimalsFor } from './numberKind';

export interface BlankOption {
    choice: BlankChoice;
    label: string;
    /** The numbers this choice gives, e.g. "Total 12,340 · average 4.21". */
    result: string;
    /** What it means for every answer. */
    effect: string;
    recommended: boolean;
}

export interface BlankCard {
    column: string;
    /** "312 of 3,900 tickets have no CSAT score (8%)". */
    headline: string;
    /** Why blanks matter for this column. */
    why: string;
    /** Why the recommended choice is recommended. */
    because: string;
    options: BlankOption[];
    /** The choice in force now. */
    current: BlankChoice;
    share: number;
}

const label = (column: string) => column.replace(/_/g, ' ').trim();
const count = (n: number) => n.toLocaleString('en-GB');
const pct = (share: number) => (share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

/** 4.6712 → "4.67", 1200 → "1,200", with the column's currency when known. */
export function amount(value: number, currency?: string): string {
    const d = decimalsFor(Math.round(value * 100) / 100);
    const text = Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
    const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
    return `${value < 0 ? '−' : ''}${symbol}${text}`;
}

/** Amounts left out when rows go: "revenue falls by £4,210". */
function lostText(profile: BlankProfile, currencyOf: (column: string) => string | undefined): string {
    const lost = (profile.onBlankRows || []).slice(0, 2);
    if (!lost.length) return '';
    return ` ${lost.map(m => `${label(m.column)} total falls by ${amount(Math.abs(m.amount), currencyOf(m.column))}`).join(', ')}.`;
}

/**
 * Optional amounts: a blank usually means "none" (no discount, no refund).
 * Recommended only when the column also never records a 0, so blank is how
 * "none" was written.
 */
const OPTIONAL_AMOUNT = /\b(discount|refund|rebate|fee|fees|tip|tips|bonus|commission|overtime|return|returns|adjustment|adjustments|penalty|penalties|surcharge|credit|credits|voucher|coupon|donation|extra|extras|allowance|claims?)\b/i;

export function recommendedChoice(profile: BlankProfile): { choice: BlankChoice; because: string } {
    const name = label(profile.column);
    if (profile.kind === 'number') {
        if (OPTIONAL_AMOUNT.test(name) && (profile.zeros ?? 0) === 0) {
            return { choice: 'zero', because: `'${name}' never records a 0, so a blank most likely means there was none.` };
        }
        return { choice: 'leave', because: 'A blank means the number was not recorded. Leaving it out keeps every total and average to what was actually recorded.' };
    }
    if (profile.kind === 'category') {
        return { choice: 'leave', because: `Rows keep counting in every total, and the blanks stay visible as their own "${profile.fillWord || 'Unknown'}" group.` };
    }
    return { choice: 'leave', because: 'Rows keep counting in every total; only time charts leave them out.' };
}

export function blankCard(profile: BlankProfile, currencyOf: (column: string) => string | undefined = () => undefined): BlankCard {
    const name = label(profile.column);
    const share = profile.rows ? profile.blanks / profile.rows : 0;
    const money = currencyOf(profile.column);
    const rec = recommendedChoice(profile);
    const headline = `${count(profile.blanks)} of ${count(profile.rows)} rows have no '${name}' (${pct(share)})`;
    const lost = lostText(profile, currencyOf);
    const options: BlankOption[] = [];

    if (profile.kind === 'number') {
        const n = profile.filled ?? 0;
        const sum = profile.sum ?? 0;
        const b = profile.blanks;
        const med = profile.median ?? 0;
        const result = (total: number, avg: number | null) => `Total ${amount(total, money)} · average ${avg === null ? '—' : amount(avg, money)}`;
        options.push({
            choice: 'leave', label: 'Leave them blank',
            result: result(sum, n ? sum / n : null),
            effect: `Totals and averages use the ${count(n)} rows that have a value.`,
            recommended: rec.choice === 'leave',
        });
        options.push({
            choice: 'zero', label: 'Count a blank as 0',
            result: result(sum, n + b ? sum / (n + b) : null),
            effect: n && sum ? `Right when a blank means none. If the number was just not recorded, the average is pulled down from ${amount(sum / n, money)} to ${amount(sum / (n + b), money)}.` : 'Right when a blank means none.',
            recommended: rec.choice === 'zero',
        });
        options.push({
            choice: 'typical', label: `Fill with the typical value (${amount(med, money)})`,
            result: result(sum + b * med, n + b ? (sum + b * med) / (n + b) : null),
            effect: `Adds ${count(b)} estimated values: the total grows by ${amount(b * med, money)} that was never recorded, and the numbers look more certain than they are.`,
            recommended: false,
        });
        options.push({
            choice: 'remove', label: 'Leave these rows out',
            result: `${count(profile.rows - b)} rows left`,
            effect: `The whole row goes from every answer, not just this number.${lost}`,
            recommended: false,
        });
    } else if (profile.kind === 'category') {
        const word = profile.fillWord || 'Unknown';
        options.push({
            choice: 'leave', label: `Show them as "${word}"`,
            result: `${count(profile.rows)} rows kept`,
            effect: `Charts by '${name}' get a "${word}" group of ${count(profile.blanks)} rows, and every total still adds up to the file.`,
            recommended: rec.choice === 'leave',
        });
        options.push({
            choice: 'remove', label: 'Leave these rows out',
            result: `${count(profile.rows - profile.blanks)} rows left`,
            effect: `The rows go from every answer, not just from charts by '${name}'.${lost}`,
            recommended: false,
        });
    } else if (profile.kind === 'date') {
        options.push({
            choice: 'leave', label: 'Leave them blank',
            result: `${count(profile.rows)} rows kept`,
            effect: `They count in every total, but cannot appear on a chart over time.`,
            recommended: rec.choice === 'leave',
        });
        options.push({
            choice: 'remove', label: 'Leave these rows out',
            result: `${count(profile.rows - profile.blanks)} rows left`,
            effect: `Totals over time and overall totals then agree, but the rows go from every answer.${lost}`,
            recommended: false,
        });
    }

    const why = profile.kind === 'number'
        ? `A blank is not a number, so it changes totals and averages depending on what it means.`
        : profile.kind === 'category'
            ? `Rows with no '${name}' cannot be put in any group, so they need a place.`
            : `Rows with no '${name}' cannot be placed in time.`;
    return { column: profile.column, headline, why, because: rec.because, options, current: profile.choice, share };
}

/** Columns worth a decision, most blanks first. */
export function blankCards(profiles: BlankProfile[] | undefined, currencyOf?: (column: string) => string | undefined): BlankCard[] {
    return (profiles || [])
        .filter(p => p.kind !== 'other' && p.blanks > 0)
        .map(p => blankCard(p, currencyOf))
        .sort((a, b) => b.share - a.share);
}
