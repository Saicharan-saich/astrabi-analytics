/**
 * When an average misleads. Sales of 100, 0, 0, 0 average 25, but nobody sold
 * 25: one person sold everything. An average is honest only when values are
 * roughly alike, so when one value dominates or most values are zero we say
 * so, and give the median (the typical value) alongside.
 */

export interface AverageCaution {
    mean: number;
    median: number;
    count: number;
    zeros: number;
    /** Share of the total held by the single largest value (0–1). */
    topShare: number;
    /** e.g. "one value makes up 100% of the total" */
    reason: string;
    message: string;
}

export const formatAverageNumber = (value: number) => Math.abs(value) >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

const fmt = (value: number) => formatAverageNumber(value);
const plural = (word: string) => word === 'person' ? 'people' : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
const listValues = (values: number[]) => {
    const shown = [...values].sort((a, b) => b - a).map(fmt);
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
};

/** "Based on only 4 rows": an average or share from very few values is fragile. */
export function smallSampleNote(count: number, what = 'figure'): string | null {
    if (count >= 30 || count < 1) return null;
    return count < 10
        ? `This ${what} rests on only ${count} row${count === 1 ? '' : 's'}: one more or one fewer could change it a lot.`
        : `This ${what} rests on ${count} rows, so treat it as a rough guide.`;
}

export function averageCaution(values: unknown[], label = 'value'): AverageCaution | null {
    const numbers = values
        .filter(value => value !== null && value !== undefined && value !== '')
        .map(Number)
        .filter(Number.isFinite);
    if (numbers.length < 3) return null;
    const sorted = [...numbers].sort((a, b) => a - b);
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const mean = total / numbers.length;
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const zeros = numbers.filter(value => value === 0).length;
    const allNonNegative = numbers.every(value => value >= 0);
    const topShare = allNonNegative && total > 0 ? sorted[sorted.length - 1] / total : 0;

    const mostlyZero = zeros / numbers.length >= 0.5 && total !== 0;
    const oneDominates = numbers.length >= 3 && topShare >= 0.6;
    const farFromTypical = mean !== 0 && Math.abs(mean - median) / Math.abs(mean) >= 0.5;
    if (!(mostlyZero || oneDominates) || !farFromTypical) return null;

    const reason = oneDominates
        ? `one ${label} makes up ${Math.round(topShare * 100)}% of the total`
        : `${zeros} of ${numbers.length} ${plural(label)} are 0`;
    // With a handful of values, show them: "100, 0, 0 and 0" says it all.
    const listed = numbers.length <= 6
        ? `the ${numbers.length} ${plural(label)} are ${listValues(numbers)}, so `
        : oneDominates ? `of ${numbers.length} ${plural(label)}, ` : '';
    return {
        mean, median, count: numbers.length, zeros, topShare, reason,
        message: `The average (${fmt(mean)}) can mislead here: ${listed}${reason}. The typical ${label} (median) is ${fmt(median)}.`,
    };
}

/** One sentence for an average split by a grouping, naming the first uneven group. */
export function groupedAverageMessage(
    label: string, dimension: string, groupCount: number,
    flagged: { key: string; caution: AverageCaution }[],
): string {
    const first = flagged[0];
    const others = flagged.length > 1 ? ` (${flagged.length} of ${groupCount} ${dimension.replace(/_/g, ' ')} values are like this)` : '';
    return `Averages can mislead here: in ${first.key || '(blank)'}, the average ${label} is ${formatAverageNumber(first.caution.mean)} but ${first.caution.reason}; the typical value (median) is ${formatAverageNumber(first.caution.median)}${others}.`;
}
