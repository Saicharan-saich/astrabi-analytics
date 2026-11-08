/**
 * The answer guard: before an answer is shown, check that what a person will
 * see agrees with the numbers that were worked out — and repair what does not.
 *
 *   1. A % axis carries only rates; a count or an amount is never drawn as %.
 *   2. Money formatting only on money; never on a count or a rate.
 *   3. A pie or donut only for parts of one whole (shares adding up to 100%,
 *      or plain amounts); separate rates are bars.
 *   4. Nothing plotted is blank, NaN or infinite.
 *   5. The words (headline, summary, key points) carry no internal names
 *      ("originalKey", "Metric, Value"), no "NaN"/"undefined"/"Infinity", and
 *      no snake_case column names.
 *
 * Each problem is repaired in the least surprising way (bars instead of a
 * donut, a plain number format, the sentence left out) and listed, so tests
 * can fail on it and the app can report it.
 */
import type { AnalysisResult, FormattingConfig } from '../types';

export const RATE_NAME = /(^|_)(rate|pct|percent|percentage|share|ratio|proportion)($|_)/i;
const COUNT_NAME = /(^|_)(count|counts|number|num|n|qty|quantity|units|orders|customers|patients|appointments|employees|rows|records|visits)($|_)/i;
const ARC = new Set(['pie', 'doughnut', 'donut', 'polarArea']);
/** Words that must never reach a person. */
const INTERNAL_WORDS = /_?originalKey|\bMetric, Value\b|\bundefined\b|\bNaN\b|\bInfinity\b|\[object Object\]|\bnull\b/;
/** A raw column name: two or more snake_case joins ("no_show_rate_pct"). */
const SNAKE_NAME = /\b[a-z][a-z0-9]*_[a-z0-9]+_[a-z0-9_]+\b/;

export interface GuardProblem {
    rule: 'percent-axis' | 'money-format' | 'arc-not-parts' | 'bad-value' | 'internal-words';
    detail: string;
}

/** True when the values can be slices of one whole (shares adding up to ~100%, or plain amounts). */
export function valuesArePartsOfWhole(rows: Record<string, any>[], key: string): boolean {
    const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
    if (!values.length || values.some(value => value < 0)) return false;
    if (!RATE_NAME.test(key)) return true;
    const sum = values.reduce((total, value) => total + value, 0);
    return Math.abs(sum - 100) <= 1.5 || Math.abs(sum - 1) <= 0.015;
}

/**
 * How a pie or donut's legend should label each slice: its share of the whole,
 * or (for separate rates) its own value — and whether a centre "Total" makes sense.
 */
export function arcLegendMode(key: string, values: number[]): { labels: 'share' | 'own-value'; showTotal: boolean } {
    // Losses can't be slices; separate rates aren't slices of one whole.
    const notSlices = values.some(value => value < 0) || (RATE_NAME.test(key) && !valuesArePartsOfWhole(values.map(value => ({ [key]: value })), key));
    return notSlices ? { labels: 'own-value', showTotal: false } : { labels: 'share', showTotal: !RATE_NAME.test(key) };
}

const isPercentFormat = (format?: string) => format === 'percent' || format === 'percent_points';
const isMoneyFormat = (format?: string) => /^currency/.test(String(format || ''));

/** Check what will be drawn; return the repaired presentation and the problems found. */
export function guardAnswer(
    presented: { analysis: AnalysisResult; formatting: FormattingConfig },
    text: { headline?: string; summary?: string; insights?: string[] } = {},
): { analysis: AnalysisResult; formatting: FormattingConfig; text: { headline?: string; summary?: string; insights?: string[] }; problems: GuardProblem[] } {
    const problems: GuardProblem[] = [];
    let analysis = presented.analysis;
    let formatting = presented.formatting;
    const rows = (analysis.data || []) as Record<string, any>[];
    const y = analysis.yKey;
    const dual = analysis.config?.axisMode === 'dual';
    const plotted = [y, ...(dual ? [] : (analysis.secondaryYKeys || []))].filter(Boolean) as string[];

    // 1. % axis: only rates on it.
    if (isPercentFormat(formatting.numberFormat)) {
        const notRates = plotted.filter(key => !RATE_NAME.test(key));
        if (notRates.length) {
            problems.push({ rule: 'percent-axis', detail: `${notRates.join(', ')} drawn on a % axis` });
            if (!RATE_NAME.test(y)) formatting = { ...formatting, numberFormat: 'auto' };
            else analysis = { ...analysis, secondaryYKeys: (analysis.secondaryYKeys || []).filter(key => RATE_NAME.test(key)) };
        }
    }
    // 2. Money format only on money.
    if (isMoneyFormat(formatting.numberFormat) && (RATE_NAME.test(y) || COUNT_NAME.test(y))) {
        problems.push({ rule: 'money-format', detail: `${y} is not money but is shown with a currency` });
        formatting = { ...formatting, numberFormat: RATE_NAME.test(y) ? 'percent_points' : 'auto' };
    }
    // 3. Pies and donuts only for parts of one whole.
    if (ARC.has(String(analysis.vis)) && !valuesArePartsOfWhole(rows, y)) {
        problems.push({ rule: 'arc-not-parts', detail: `${y} values are not parts of one whole` });
        analysis = { ...analysis, vis: (rows.length > 6 ? 'horizontalBar' : 'bar') as any };
    }
    // 4. Nothing plotted is blank, NaN or infinite (except gaps a line may skip).
    const badKey = plotted.find(key => rows.some(row => row[key] !== null && row[key] !== undefined && typeof row[key] !== 'string' && !Number.isFinite(Number(row[key]))));
    if (badKey) problems.push({ rule: 'bad-value', detail: `${badKey} has a value that is not a number` });

    // 5. Words a person reads: column names become words; a sentence with an
    //    internal name or NaN in it is left out.
    const words = (name: string) => name.replace(/_(pct|percent|percentage)\b/g, '').replace(/_/g, ' ');
    const repair = (line?: string): string | undefined => {
        if (!line) return line;
        const sentences = line.split(/(?<=[.!?])\s+/).filter(sentence => !INTERNAL_WORDS.test(sentence));
        return sentences.join(' ').replace(new RegExp(SNAKE_NAME.source, 'g'), words).trim() || undefined;
    };
    const fixedText = { ...text };
    for (const field of ['headline', 'summary'] as const) {
        const before = text[field];
        if (before && (INTERNAL_WORDS.test(before) || SNAKE_NAME.test(before))) {
            problems.push({ rule: 'internal-words', detail: `${field}: "${before.slice(0, 80)}"` });
            fixedText[field] = repair(before);
        }
    }
    if (text.insights?.some(line => INTERNAL_WORDS.test(line) || SNAKE_NAME.test(line))) {
        problems.push({ rule: 'internal-words', detail: 'a key point names internal columns' });
        fixedText.insights = text.insights.map(repair).filter((line): line is string => Boolean(line));
    }
    return { analysis, formatting, text: fixedText, problems };
}
