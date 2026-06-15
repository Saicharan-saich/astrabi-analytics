/**
 * dataCleaningEngine.ts — Comprehensive Data Cleaning Operations
 *
 * Provides all user-facing cleaning tools:
 *   1. Duplicate detection & removal
 *   2. Missing value imputation
 *   3. String normalization
 *   4. Outlier detection & handling
 *   5. Find & replace (text + regex)
 *   6. Column split & merge
 *   7. Data validation rules
 *   8. Data quality scoring
 */

// ╔══════════════════════════════════════════════════════════════════╗
// ║  TYPES                                                          ║
// ╚══════════════════════════════════════════════════════════════════╝

export type ImputeStrategy = 'mean' | 'median' | 'mode' | 'custom' | 'forward_fill' | 'backward_fill' | 'drop_row' | 'zero';
export type DedupKeep = 'first' | 'last' | 'none';
export type OutlierMethod = 'iqr' | 'zscore';
export type OutlierAction = 'remove' | 'cap' | 'flag' | 'nullify';
export type CaseMode = 'lower' | 'upper' | 'title' | 'sentence';
export type ValidationRuleType = 'range' | 'pattern' | 'enum' | 'not_null' | 'unique' | 'custom_expr';

export interface CleaningResult {
    data: Record<string, any>[];
    rowsBefore: number;
    rowsAfter: number;
    changes: number;
    log: CleaningLogEntry;
}

export interface CleaningLogEntry {
    operation: string;
    column?: string;
    details: string;
    rowsAffected: number;
    timestamp: number;
    preview?: { before: any; after: any }[];
}

export interface DuplicateGroup {
    key: string;
    rows: Record<string, any>[];
    indices: number[];
}

export interface OutlierResult {
    column: string;
    method: OutlierMethod;
    lowerBound: number;
    upperBound: number;
    outlierCount: number;
    outlierIndices: number[];
    outlierValues: number[];
}

export interface ValidationRule {
    column: string;
    type: ValidationRuleType;
    params: Record<string, any>;
    message?: string;
}

export interface ValidationResult {
    rule: ValidationRule;
    violations: { rowIndex: number; value: any }[];
    passRate: number;
}

export interface ColumnQuality {
    column: string;
    completeness: number;    // % non-null
    uniqueness: number;      // % unique values
    validity: number;        // % passing validation rules
    consistency: number;     // % matching dominant format
    overallScore: number;    // weighted average
    nullCount: number;
    duplicateValueCount: number;
    outlierCount: number;
    topValues: { value: string; count: number }[];
    dataType: string;
}

export interface DataQualityReport {
    overallScore: number;
    totalRows: number;
    totalColumns: number;
    columns: ColumnQuality[];
    issues: { severity: 'critical' | 'warning' | 'info'; message: string; column?: string }[];
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  1. DUPLICATE DETECTION & REMOVAL                               ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Find duplicate rows based on specified key columns.
 * If no keys specified, uses ALL columns (exact row duplicates).
 */
export function findDuplicates(
    data: Record<string, any>[],
    keyColumns?: string[]
): DuplicateGroup[] {
    const groups = new Map<string, { rows: Record<string, any>[]; indices: number[] }>();

    data.forEach((row, idx) => {
        const key = keyColumns
            ? keyColumns.map(k => String(row[k] ?? '')).join('|||')
            : Object.values(row).map(v => String(v ?? '')).join('|||');

        if (!groups.has(key)) {
            groups.set(key, { rows: [], indices: [] });
        }
        groups.get(key)!.rows.push(row);
        groups.get(key)!.indices.push(idx);
    });

    // Only return groups with more than 1 row (actual duplicates)
    return Array.from(groups.entries())
        .filter(([, g]) => g.rows.length > 1)
        .map(([key, g]) => ({ key, rows: g.rows, indices: g.indices }));
}

/**
 * Remove duplicate rows.
 * @param keep - 'first' keeps the first occurrence, 'last' keeps the last, 'none' removes all duplicates
 */
export function removeDuplicates(
    data: Record<string, any>[],
    keyColumns?: string[],
    keep: DedupKeep = 'first'
): CleaningResult {
    const groups = findDuplicates(data, keyColumns);
    const indicesToRemove = new Set<number>();

    groups.forEach(group => {
        if (keep === 'none') {
            group.indices.forEach(i => indicesToRemove.add(i));
        } else if (keep === 'first') {
            group.indices.slice(1).forEach(i => indicesToRemove.add(i));
        } else {
            group.indices.slice(0, -1).forEach(i => indicesToRemove.add(i));
        }
    });

    const cleaned = data.filter((_, idx) => !indicesToRemove.has(idx));

    return {
        data: cleaned,
        rowsBefore: data.length,
        rowsAfter: cleaned.length,
        changes: indicesToRemove.size,
        log: {
            operation: 'Remove Duplicates',
            details: `Removed ${indicesToRemove.size} duplicate rows (keep: ${keep}, keys: ${keyColumns?.join(', ') || 'all columns'})`,
            rowsAffected: indicesToRemove.size,
            timestamp: Date.now(),
            preview: groups.slice(0, 3).map(g => ({
                before: g.rows[0],
                after: keep === 'none' ? null : g.rows[keep === 'first' ? 0 : g.rows.length - 1]
            }))
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  2. MISSING VALUE IMPUTATION                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

/** Get numeric values from a column, excluding nulls */
function getNumericValues(data: Record<string, any>[], column: string): number[] {
    return data
        .map(r => r[column])
        .filter(v => v != null && v !== '' && !isNaN(Number(v)))
        .map(Number);
}

/** Calculate median of sorted numeric array */
function median(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Calculate mode (most frequent value) */
function mode(values: any[]): any {
    const freq = new Map<string, number>();
    values.forEach(v => {
        const key = String(v);
        freq.set(key, (freq.get(key) || 0) + 1);
    });
    let maxCount = 0;
    let modeVal: any = null;
    freq.forEach((count, key) => {
        if (count > maxCount) { maxCount = count; modeVal = key; }
    });
    return modeVal;
}

/**
 * Impute missing values in a column using the specified strategy.
 */
export function imputeMissing(
    data: Record<string, any>[],
    column: string,
    strategy: ImputeStrategy,
    customValue?: any
): CleaningResult {
    const isNull = (v: any) => v == null || v === '' || v === 'null' || v === 'NULL' || v === 'N/A';
    let fillValue: any;
    let changes = 0;

    // Calculate fill value based on strategy
    switch (strategy) {
        case 'mean': {
            const nums = getNumericValues(data, column);
            fillValue = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
            fillValue = Math.round(fillValue * 100) / 100;
            break;
        }
        case 'median': {
            const nums = getNumericValues(data, column).sort((a, b) => a - b);
            fillValue = median(nums);
            break;
        }
        case 'mode': {
            const nonNull = data.map(r => r[column]).filter(v => !isNull(v));
            fillValue = mode(nonNull);
            break;
        }
        case 'custom': {
            fillValue = customValue ?? '';
            break;
        }
        case 'zero': {
            fillValue = 0;
            break;
        }
        case 'drop_row': {
            const cleaned = data.filter(r => !isNull(r[column]));
            return {
                data: cleaned,
                rowsBefore: data.length,
                rowsAfter: cleaned.length,
                changes: data.length - cleaned.length,
                log: {
                    operation: 'Drop Rows (Missing)',
                    column,
                    details: `Dropped ${data.length - cleaned.length} rows where "${column}" was null/empty`,
                    rowsAffected: data.length - cleaned.length,
                    timestamp: Date.now()
                }
            };
        }
        case 'forward_fill':
        case 'backward_fill': {
            const result = data.map(r => ({ ...r }));
            if (strategy === 'forward_fill') {
                let lastValid: any = null;
                for (let i = 0; i < result.length; i++) {
                    if (!isNull(result[i][column])) {
                        lastValid = result[i][column];
                    } else if (lastValid != null) {
                        result[i][column] = lastValid;
                        changes++;
                    }
                }
            } else {
                let lastValid: any = null;
                for (let i = result.length - 1; i >= 0; i--) {
                    if (!isNull(result[i][column])) {
                        lastValid = result[i][column];
                    } else if (lastValid != null) {
                        result[i][column] = lastValid;
                        changes++;
                    }
                }
            }
            return {
                data: result,
                rowsBefore: data.length,
                rowsAfter: result.length,
                changes,
                log: {
                    operation: `Impute (${strategy})`,
                    column,
                    details: `Filled ${changes} missing values in "${column}" using ${strategy.replace('_', ' ')}`,
                    rowsAffected: changes,
                    timestamp: Date.now()
                }
            };
        }
    }

    // Apply fill value
    const result = data.map(row => {
        if (isNull(row[column])) {
            changes++;
            return { ...row, [column]: fillValue };
        }
        return { ...row };
    });

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes,
        log: {
            operation: `Impute (${strategy})`,
            column,
            details: `Filled ${changes} missing values in "${column}" with ${strategy === 'custom' ? `"${fillValue}"` : `${strategy} = ${fillValue}`}`,
            rowsAffected: changes,
            timestamp: Date.now(),
            preview: [{ before: null, after: fillValue }]
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  3. STRING NORMALIZATION                                        ║
// ╚══════════════════════════════════════════════════════════════════╝

/** Convert string to Title Case */
function toTitleCase(s: string): string {
    return s.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
}

/** Convert string to Sentence Case */
function toSentenceCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Normalize string values in a column.
 */
export function normalizeStrings(
    data: Record<string, any>[],
    column: string,
    options: {
        trim?: boolean;
        caseMode?: CaseMode;
        deduplicateSpaces?: boolean;
        removeSpecialChars?: boolean;
    } = {}
): CleaningResult {
    const { trim = true, caseMode, deduplicateSpaces = true, removeSpecialChars = false } = options;
    let changes = 0;

    const result = data.map(row => {
        let val = row[column];
        if (val == null || typeof val !== 'string') return { ...row };

        const original = val;

        if (trim) val = val.trim();
        if (deduplicateSpaces) val = val.replace(/\s+/g, ' ');
        if (removeSpecialChars) val = val.replace(/[^\w\s\-.,]/g, '');

        if (caseMode) {
            switch (caseMode) {
                case 'lower': val = val.toLowerCase(); break;
                case 'upper': val = val.toUpperCase(); break;
                case 'title': val = toTitleCase(val); break;
                case 'sentence': val = toSentenceCase(val); break;
            }
        }

        if (val !== original) changes++;
        return { ...row, [column]: val };
    });

    const ops: string[] = [];
    if (trim) ops.push('trim');
    if (deduplicateSpaces) ops.push('deduplicate spaces');
    if (caseMode) ops.push(`${caseMode} case`);
    if (removeSpecialChars) ops.push('remove special chars');

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes,
        log: {
            operation: 'String Normalization',
            column,
            details: `Normalized ${changes} values in "${column}" (${ops.join(', ')})`,
            rowsAffected: changes,
            timestamp: Date.now()
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  4. OUTLIER DETECTION & HANDLING                                ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Detect outliers using IQR or Z-score method.
 */
export function detectOutliers(
    data: Record<string, any>[],
    column: string,
    method: OutlierMethod = 'iqr',
    threshold: number = 1.5 // IQR multiplier or Z-score threshold
): OutlierResult {
    const values = getNumericValues(data, column);
    const sorted = [...values].sort((a, b) => a - b);

    let lowerBound: number;
    let upperBound: number;

    if (method === 'iqr') {
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        lowerBound = q1 - threshold * iqr;
        upperBound = q3 + threshold * iqr;
    } else {
        // Z-score method
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
        const std = Math.sqrt(variance);
        lowerBound = mean - threshold * std;
        upperBound = mean + threshold * std;
    }

    const outlierIndices: number[] = [];
    const outlierValues: number[] = [];

    data.forEach((row, idx) => {
        const v = Number(row[column]);
        if (!isNaN(v) && (v < lowerBound || v > upperBound)) {
            outlierIndices.push(idx);
            outlierValues.push(v);
        }
    });

    return { column, method, lowerBound, upperBound, outlierCount: outlierIndices.length, outlierIndices, outlierValues };
}

/**
 * Handle outliers with specified action.
 */
export function handleOutliers(
    data: Record<string, any>[],
    column: string,
    method: OutlierMethod = 'iqr',
    action: OutlierAction = 'cap',
    threshold: number = 1.5
): CleaningResult {
    const detection = detectOutliers(data, column, method, threshold);
    const outlierSet = new Set(detection.outlierIndices);
    let changes = 0;

    let result: Record<string, any>[];

    switch (action) {
        case 'remove':
            result = data.filter((_, idx) => !outlierSet.has(idx));
            changes = outlierSet.size;
            break;

        case 'cap':
            result = data.map((row, idx) => {
                if (!outlierSet.has(idx)) return { ...row };
                const v = Number(row[column]);
                changes++;
                return {
                    ...row,
                    [column]: v < detection.lowerBound ? detection.lowerBound : detection.upperBound
                };
            });
            break;

        case 'nullify':
            result = data.map((row, idx) => {
                if (!outlierSet.has(idx)) return { ...row };
                changes++;
                return { ...row, [column]: null };
            });
            break;

        case 'flag':
            result = data.map((row, idx) => ({
                ...row,
                [`${column}_outlier`]: outlierSet.has(idx)
            }));
            changes = outlierSet.size;
            break;

        default:
            result = [...data];
    }

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes,
        log: {
            operation: 'Outlier Handling',
            column,
            details: `${action === 'remove' ? 'Removed' : action === 'cap' ? 'Capped' : action === 'nullify' ? 'Nullified' : 'Flagged'} ${detection.outlierCount} outliers in "${column}" (${method.toUpperCase()}, threshold: ${threshold}). Bounds: [${detection.lowerBound.toFixed(2)}, ${detection.upperBound.toFixed(2)}]`,
            rowsAffected: changes,
            timestamp: Date.now(),
            preview: detection.outlierValues.slice(0, 5).map(v => ({
                before: v,
                after: action === 'cap' ? (v < detection.lowerBound ? detection.lowerBound : detection.upperBound) :
                       action === 'remove' ? '(removed)' :
                       action === 'nullify' ? null : `${v} [flagged]`
            }))
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  5. FIND & REPLACE                                              ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Find and replace values in a column.
 */
export function findAndReplace(
    data: Record<string, any>[],
    column: string,
    find: string,
    replace: string,
    options: { useRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {}
): CleaningResult {
    const { useRegex = false, caseSensitive = false, wholeWord = false } = options;
    let changes = 0;

    let pattern: RegExp;
    if (useRegex) {
        pattern = new RegExp(find, caseSensitive ? 'g' : 'gi');
    } else {
        const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wordBoundary = wholeWord ? '\\b' : '';
        pattern = new RegExp(`${wordBoundary}${escaped}${wordBoundary}`, caseSensitive ? 'g' : 'gi');
    }

    const result = data.map(row => {
        const val = row[column];
        if (val == null) return { ...row };

        const str = String(val);
        const newVal = str.replace(pattern, replace);
        if (newVal !== str) changes++;
        return { ...row, [column]: newVal };
    });

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes,
        log: {
            operation: 'Find & Replace',
            column,
            details: `Replaced "${find}" → "${replace}" in "${column}" (${changes} changes, ${useRegex ? 'regex' : 'text'}, ${caseSensitive ? 'case-sensitive' : 'case-insensitive'})`,
            rowsAffected: changes,
            timestamp: Date.now()
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  6. COLUMN SPLIT & MERGE                                        ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Split a column into multiple columns by delimiter.
 */
export function splitColumn(
    data: Record<string, any>[],
    column: string,
    delimiter: string,
    newColumnNames?: string[],
    maxSplits?: number
): CleaningResult {
    // Determine max parts
    let maxParts = 0;
    data.forEach(row => {
        const val = String(row[column] ?? '');
        const parts = maxSplits ? val.split(delimiter, maxSplits + 1) : val.split(delimiter);
        maxParts = Math.max(maxParts, parts.length);
    });

    const colNames = newColumnNames || Array.from({ length: maxParts }, (_, i) => `${column}_${i + 1}`);

    const result = data.map(row => {
        const val = String(row[column] ?? '');
        const parts = maxSplits ? val.split(delimiter, maxSplits + 1) : val.split(delimiter);
        const newRow = { ...row };
        colNames.forEach((name, i) => {
            newRow[name] = parts[i]?.trim() ?? null;
        });
        return newRow;
    });

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes: data.length,
        log: {
            operation: 'Split Column',
            column,
            details: `Split "${column}" by "${delimiter}" into ${colNames.length} columns: ${colNames.join(', ')}`,
            rowsAffected: data.length,
            timestamp: Date.now()
        }
    };
}

/**
 * Merge multiple columns into a single column.
 */
export function mergeColumns(
    data: Record<string, any>[],
    columns: string[],
    newColumnName: string,
    separator: string = ' ',
    dropOriginals: boolean = false
): CleaningResult {
    const result = data.map(row => {
        const merged = columns.map(c => String(row[c] ?? '')).filter(Boolean).join(separator);
        const newRow = { ...row, [newColumnName]: merged };
        if (dropOriginals) {
            columns.forEach(c => { if (c !== newColumnName) delete newRow[c]; });
        }
        return newRow;
    });

    return {
        data: result,
        rowsBefore: data.length,
        rowsAfter: result.length,
        changes: data.length,
        log: {
            operation: 'Merge Columns',
            details: `Merged [${columns.join(', ')}] → "${newColumnName}" (separator: "${separator}")`,
            rowsAffected: data.length,
            timestamp: Date.now()
        }
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  7. DATA VALIDATION RULES                                       ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Validate data against a set of rules.
 */
export function validateData(
    data: Record<string, any>[],
    rules: ValidationRule[]
): ValidationResult[] {
    return rules.map(rule => {
        const violations: { rowIndex: number; value: any }[] = [];

        data.forEach((row, idx) => {
            const val = row[rule.column];
            let valid = true;

            switch (rule.type) {
                case 'not_null':
                    valid = val != null && val !== '' && val !== 'null';
                    break;
                case 'unique':
                    // Handled separately below
                    valid = true;
                    break;
                case 'range': {
                    const num = Number(val);
                    const { min, max } = rule.params;
                    valid = !isNaN(num) && (min == null || num >= min) && (max == null || num <= max);
                    break;
                }
                case 'pattern': {
                    const regex = new RegExp(rule.params.pattern);
                    valid = val != null && regex.test(String(val));
                    break;
                }
                case 'enum': {
                    const allowed = new Set(rule.params.values as string[]);
                    valid = val != null && allowed.has(String(val));
                    break;
                }
                case 'custom_expr': {
                    try {
                        // Simple expression evaluation (safe: no eval, uses comparison)
                        const expr = rule.params.expression as string;
                        if (expr.includes('>')) {
                            const threshold = Number(expr.split('>')[1].trim());
                            valid = Number(val) > threshold;
                        } else if (expr.includes('<')) {
                            const threshold = Number(expr.split('<')[1].trim());
                            valid = Number(val) < threshold;
                        }
                    } catch { valid = true; }
                    break;
                }
            }

            if (!valid) {
                violations.push({ rowIndex: idx, value: val });
            }
        });

        // Handle 'unique' rule: check for duplicate values
        if (rule.type === 'unique') {
            const seen = new Map<string, number>();
            data.forEach((row, idx) => {
                const key = String(row[rule.column] ?? '');
                if (seen.has(key)) {
                    violations.push({ rowIndex: idx, value: row[rule.column] });
                } else {
                    seen.set(key, idx);
                }
            });
        }

        return {
            rule,
            violations,
            passRate: data.length > 0 ? ((data.length - violations.length) / data.length) * 100 : 100
        };
    });
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  8. DATA QUALITY SCORING                                        ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Generate a comprehensive data quality report for the entire dataset.
 */
export function generateQualityReport(
    data: Record<string, any>[],
    columns?: string[]
): DataQualityReport {
    if (data.length === 0) {
        return { overallScore: 0, totalRows: 0, totalColumns: 0, columns: [], issues: [] };
    }

    const colNames = columns || Object.keys(data[0]);
    const issues: DataQualityReport['issues'] = [];
    const columnReports: ColumnQuality[] = [];

    colNames.forEach(col => {
        const values = data.map(r => r[col]);
        const nonNull = values.filter(v => v != null && v !== '' && v !== 'null' && v !== 'N/A');
        const nullCount = values.length - nonNull.length;
        const completeness = values.length > 0 ? (nonNull.length / values.length) * 100 : 0;

        // Uniqueness
        const uniqueValues = new Set(nonNull.map(v => String(v)));
        const uniqueness = nonNull.length > 0 ? (uniqueValues.size / nonNull.length) * 100 : 0;
        const duplicateValueCount = nonNull.length - uniqueValues.size;

        // Top values
        const valueCounts = new Map<string, number>();
        nonNull.forEach(v => {
            const key = String(v);
            valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
        });
        const topValues = Array.from(valueCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, count]) => ({ value, count }));

        // Detect data type
        const numericCount = values.filter(v => v != null && !isNaN(Number(v))).length;
        const isNumeric = numericCount > values.length * 0.8;

        // Outlier count (for numeric columns)
        let outlierCount = 0;
        if (isNumeric && nonNull.length > 10) {
            try {
                const detection = detectOutliers(data, col, 'iqr', 1.5);
                outlierCount = detection.outlierCount;
            } catch { /* skip */ }
        }

        // Consistency: % of values matching the dominant format
        let consistency = 100;
        if (isNumeric) {
            const intCount = nonNull.filter(v => Number.isInteger(Number(v))).length;
            const floatCount = nonNull.length - intCount;
            consistency = Math.max(intCount, floatCount) / nonNull.length * 100;
        } else {
            // Check case consistency for strings
            const lower = nonNull.filter(v => String(v) === String(v).toLowerCase()).length;
            const upper = nonNull.filter(v => String(v) === String(v).toUpperCase()).length;
            const title = nonNull.filter(v => {
                const s = String(v);
                return s === s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
            }).length;
            const maxConsistent = Math.max(lower, upper, title);
            consistency = nonNull.length > 0 ? (maxConsistent / nonNull.length) * 100 : 100;
        }

        // Overall score (weighted)
        const overallScore = (completeness * 0.35 + Math.min(uniqueness, 100) * 0.15 + consistency * 0.25 + (100 - Math.min((outlierCount / Math.max(nonNull.length, 1)) * 100, 100)) * 0.25);

        columnReports.push({
            column: col,
            completeness: Math.round(completeness * 100) / 100,
            uniqueness: Math.round(uniqueness * 100) / 100,
            validity: 100, // No rules applied yet
            consistency: Math.round(consistency * 100) / 100,
            overallScore: Math.round(overallScore * 100) / 100,
            nullCount,
            duplicateValueCount,
            outlierCount,
            topValues,
            dataType: isNumeric ? 'numeric' : 'text'
        });

        // Generate issues
        if (completeness < 80) {
            issues.push({
                severity: completeness < 50 ? 'critical' : 'warning',
                message: `Column "${col}" has ${nullCount} missing values (${(100 - completeness).toFixed(1)}% null)`,
                column: col
            });
        }

        if (outlierCount > 0 && isNumeric) {
            issues.push({
                severity: outlierCount > nonNull.length * 0.1 ? 'critical' : 'warning',
                message: `Column "${col}" has ${outlierCount} statistical outliers`,
                column: col
            });
        }

        if (consistency < 70 && !isNumeric) {
            issues.push({
                severity: 'warning',
                message: `Column "${col}" has inconsistent formatting (${consistency.toFixed(0)}% consistent)`,
                column: col
            });
        }

        if (uniqueness < 5 && nonNull.length > 100) {
            issues.push({
                severity: 'info',
                message: `Column "${col}" has very low cardinality (${uniqueValues.size} unique values) — good candidate for dimension/category`,
                column: col
            });
        }
    });

    const overallScore = columnReports.length > 0
        ? columnReports.reduce((acc, c) => acc + c.overallScore, 0) / columnReports.length
        : 0;

    return {
        overallScore: Math.round(overallScore * 100) / 100,
        totalRows: data.length,
        totalColumns: colNames.length,
        columns: columnReports,
        issues: issues.sort((a, b) => {
            const sev = { critical: 0, warning: 1, info: 2 };
            return sev[a.severity] - sev[b.severity];
        })
    };
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  9. CLEANING HISTORY (UNDO/REDO SUPPORT)                       ║
// ╚══════════════════════════════════════════════════════════════════╝

export class CleaningHistory {
    private history: { data: Record<string, any>[]; log: CleaningLogEntry }[] = [];
    private pointer: number = -1;

    /** Save a snapshot */
    push(data: Record<string, any>[], log: CleaningLogEntry) {
        // Remove any future history (if we undid and then did something new)
        this.history = this.history.slice(0, this.pointer + 1);
        this.history.push({ data: data.map(r => ({ ...r })), log });
        this.pointer = this.history.length - 1;
    }

    /** Undo last operation */
    undo(): { data: Record<string, any>[]; log: CleaningLogEntry } | null {
        if (this.pointer <= 0) return null;
        this.pointer--;
        return this.history[this.pointer];
    }

    /** Redo last undone operation */
    redo(): { data: Record<string, any>[]; log: CleaningLogEntry } | null {
        if (this.pointer >= this.history.length - 1) return null;
        this.pointer++;
        return this.history[this.pointer];
    }

    canUndo(): boolean { return this.pointer > 0; }
    canRedo(): boolean { return this.pointer < this.history.length - 1; }
    getHistory(): CleaningLogEntry[] { return this.history.map(h => h.log); }
}
