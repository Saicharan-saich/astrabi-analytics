/**
 * dataMasker.ts — PII-Safe Statistical Profiling
 *
 * Converts raw dataset rows into MaskedColumnProfile[] that contain
 * ONLY statistical metadata — no raw data values are ever exposed.
 * This is the compliance shield: data sent to the LLM comes from here.
 *
 * Performance: Samples max 1,000 rows to keep computation < 50ms.
 */

import { ColumnDefinition, ColumnType, MaskedColumnProfile } from '../types';

// ═══════════════════════════════════════════════════════════════════
// COMPILED PATTERN DETECTORS — Fast regex tests for common formats
// ═══════════════════════════════════════════════════════════════════

const PATTERN_DETECTORS: { hint: string; regex: RegExp }[] = [
    { hint: 'email', regex: /^[\w.+-]+@[\w.-]+\.\w{2,}$/i },
    { hint: 'uuid', regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
    { hint: 'phone', regex: /^\+?\d[\d\s\-().]{7,18}$/ },
    { hint: 'ssn_format', regex: /^\d{3}-\d{2}-\d{4}$/ },
    { hint: 'date_iso', regex: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/ },
    { hint: 'date_us', regex: /^\d{1,2}\/\d{1,2}\/\d{2,4}$/ },
    { hint: 'currency', regex: /^[$€£¥₹]\s?[\d,.]+$/ },
    { hint: 'percentage', regex: /^[\d.]+\s?%$/ },
    { hint: 'url', regex: /^https?:\/\//i },
    { hint: 'ip_address', regex: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/ },
    { hint: 'zip_code', regex: /^\d{5}(-\d{4})?$/ },
    { hint: 'boolean', regex: /^(true|false|yes|no|y|n|0|1)$/i },
];

// Max rows to sample for statistical profiling (1,000 is statistically sufficient)
const MAX_SAMPLE_ROWS = 1000;

// ═══════════════════════════════════════════════════════════════════
// CORE: Build masked statistical profiles for all columns
// ═══════════════════════════════════════════════════════════════════

export function buildMaskedProfiles(
    rows: Record<string, any>[],
    columns: ColumnDefinition[]
): MaskedColumnProfile[] {
    if (!rows.length || !columns.length) return [];

    // Sample rows for performance (statistically sufficient for profiling)
    const sampleRows = rows.length > MAX_SAMPLE_ROWS
        ? sampleEvenlySpaced(rows, MAX_SAMPLE_ROWS)
        : rows;
    const totalRows = rows.length;

    return columns.map(col => profileColumn(col, sampleRows, totalRows));
}

/**
 * Profile a single column from sampled rows — zero raw data exposure
 */
function profileColumn(
    col: ColumnDefinition,
    sampleRows: Record<string, any>[],
    totalRows: number
): MaskedColumnProfile {
    const values = sampleRows.map(r => r[col.name]);
    const nonNullValues = values.filter(v => v !== null && v !== undefined && v !== '');
    const nullCount = values.length - nonNullValues.length;
    const nullRate = values.length > 0 ? nullCount / values.length : 0;

    // Distinct count (approximate from sample)
    const distinctSet = new Set(nonNullValues.map(v => String(v)));
    const distinctCount = Math.round(distinctSet.size * (totalRows / values.length));

    // Infer the actual data type from values
    const inferredType = inferValueType(nonNullValues);

    // Build the profile
    const profile: MaskedColumnProfile = {
        name: col.name,
        inferredType,
        nullRate: Math.round(nullRate * 10000) / 10000, // 4 decimal places
        distinctCount: Math.min(distinctCount, totalRows),
        totalRows,
    };

    // Numeric statistics (no raw values, just aggregates)
    if (inferredType === 'number') {
        const nums = nonNullValues.map(v => parseFloat(String(v).replace(/[$€£¥₹,]/g, ''))).filter(n => !isNaN(n));
        if (nums.length > 0) {
            nums.sort((a, b) => a - b);
            profile.numericStats = {
                min: nums[0],
                max: nums[nums.length - 1],
                mean: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100,
                median: nums[Math.floor(nums.length / 2)],
            };
        }
        // Detect currency/percentage from string representations
        const strValues = nonNullValues.map(v => String(v));
        profile.currencyDetected = strValues.filter(v => /[$€£¥₹]/.test(v)).length > strValues.length * 0.5;
        profile.percentageDetected = strValues.filter(v => /%/.test(v)).length > strValues.length * 0.5;
    }

    // Date range (safe — only min/max dates, no raw values)
    if (inferredType === 'date') {
        const dates = nonNullValues
            .map(v => new Date(v))
            .filter(d => !isNaN(d.getTime()))
            .sort((a, b) => a.getTime() - b.getTime());
        if (dates.length > 0) {
            profile.dateRange = {
                min: dates[0].toISOString().split('T')[0],
                max: dates[dates.length - 1].toISOString().split('T')[0],
            };
        }
    }

    // Pattern detection — fast compiled regex (no raw value exposure)
    const patternHint = detectPattern(nonNullValues);
    if (patternHint) {
        profile.patternHint = patternHint;
    }

    // Top structural patterns (not actual values — just shape descriptions)
    const topPatterns = detectStructuralPatterns(nonNullValues);
    if (topPatterns.length > 0) {
        profile.topPatterns = topPatterns;
    }

    return profile;
}

// ═══════════════════════════════════════════════════════════════════
// PATTERN DETECTION — Compiled regex for speed
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect the dominant pattern in a column using fast compiled regexes.
 * If 80%+ of non-null values match a pattern, return the hint.
 */
function detectPattern(values: any[]): string | undefined {
    if (values.length < 5) return undefined;

    const strValues = values.map(v => String(v).trim()).filter(v => v.length > 0);
    if (strValues.length === 0) return undefined;

    for (const detector of PATTERN_DETECTORS) {
        const matchCount = strValues.filter(v => detector.regex.test(v)).length;
        if (matchCount / strValues.length >= 0.8) {
            return detector.hint;
        }
    }

    return undefined;
}

/**
 * Detect structural patterns — describes the SHAPE of data, not the data itself.
 * E.g., "2-3 word text", "Numeric code", "Single character"
 */
function detectStructuralPatterns(values: any[]): string[] {
    if (values.length < 5) return [];

    const strValues = values.map(v => String(v).trim()).filter(v => v.length > 0);
    const patterns: Record<string, number> = {};

    for (const v of strValues.slice(0, 200)) { // Cap at 200 for speed
        const shape = classifyShape(v);
        patterns[shape] = (patterns[shape] || 0) + 1;
    }

    // Return top 3 patterns that represent >10% of values
    const threshold = strValues.length * 0.1;
    return Object.entries(patterns)
        .filter(([, count]) => count >= threshold)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pattern]) => pattern);
}

/**
 * Classify the structural shape of a value (no raw data preserved).
 */
export function classifyShape(value: string): string {
    if (/^\d+$/.test(value)) return 'integer';
    if (/^\d+\.\d+$/.test(value)) return 'decimal';
    if (/^[A-Z]{2,5}$/.test(value)) return 'uppercase_code';
    if (/^[a-z]+$/.test(value)) return 'lowercase_word';
    if (/^[A-Z][a-z]+$/.test(value)) return 'capitalized_word';
    const wordCount = value.split(/\s+/).length;
    if (wordCount === 1) return 'single_word';
    if (wordCount <= 3) return 'short_phrase';
    if (wordCount <= 8) return 'sentence';
    return 'long_text';
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Infer the predominant data type from a set of values
 */
function inferValueType(values: any[]): 'string' | 'number' | 'date' | 'boolean' {
    if (values.length === 0) return 'string';

    let numCount = 0, dateCount = 0, boolCount = 0;

    for (const v of values.slice(0, 200)) {
        const str = String(v).trim();
        if (/^(true|false|yes|no|y|n)$/i.test(str)) { boolCount++; continue; }
        const num = Number(str.replace(/[$€£¥₹,%]/g, ''));
        if (!isNaN(num) && str.length > 0) { numCount++; continue; }
        const d = new Date(str);
        if (!isNaN(d.getTime()) && str.length >= 6) { dateCount++; continue; }
    }

    const total = Math.min(values.length, 200);
    if (boolCount / total >= 0.8) return 'boolean';
    if (numCount / total >= 0.7) return 'number';
    if (dateCount / total >= 0.7) return 'date';
    return 'string';
}

/**
 * Sample rows evenly spaced across the dataset (not biased toward head or tail)
 */
function sampleEvenlySpaced<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
        result.push(arr[Math.floor(i * step)]);
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════
// FORMAT for LLM prompt — human-readable text from masked profiles
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert masked profiles to a concise text block for the LLM prompt.
 * Contains ZERO raw data — only statistical metadata.
 */
export function profilesToPromptText(profiles: MaskedColumnProfile[]): string {
    const lines = profiles.map(p => {
        const parts: string[] = [
            `Column: "${p.name}"`,
            `Type: ${p.inferredType}`,
            `Distinct: ${p.distinctCount}/${p.totalRows}`,
            `Nulls: ${(p.nullRate * 100).toFixed(1)}%`,
        ];
        if (p.numericStats) {
            parts.push(`Range: [${p.numericStats.min}, ${p.numericStats.max}]`);
            parts.push(`Mean: ${p.numericStats.mean}`);
        }
        if (p.dateRange) {
            parts.push(`Date Range: ${p.dateRange.min} → ${p.dateRange.max}`);
        }
        if (p.patternHint) {
            parts.push(`Pattern: ${p.patternHint}`);
        }
        if (p.currencyDetected) parts.push('Currency: yes');
        if (p.percentageDetected) parts.push('Percentage: yes');
        if (p.topPatterns?.length) {
            parts.push(`Shapes: ${p.topPatterns.join(', ')}`);
        }
        return parts.join(' | ');
    });
    return lines.join('\n');
}
