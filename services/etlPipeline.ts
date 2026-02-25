/**
 * etlPipeline.ts — Robust 20-Step Auto-Detecting ETL Pipeline
 *
 * Each step:
 *  1. Detects whether it is needed for the data
 *  2. Applies the transformation only if needed
 *  3. Logs applied/skipped status with detailed reasons
 */

import { ColumnDefinition, ColumnType, ETLLog, TimeContext } from '../types';
import { inferColumnType } from './analysisEngine';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const NULL_TOKENS = new Set([
    '', 'null', 'none', 'n/a', 'na', 'nan', '-', '--', 'undefined', 'missing',
    '#n/a', '#ref!', '#value!', '#null!', '#name?', '#div/0!',
]);

function isNullish(v: any): boolean {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' && NULL_TOKENS.has(v.trim().toLowerCase())) return true;
    return false;
}

function excelDateToJSDate(serial: number): Date {
    const utcDays = Math.floor(serial - 25569);
    return new Date(utcDays * 86400 * 1000);
}

function log(
    step: string,
    stepNumber: number,
    status: 'applied' | 'skipped' | 'info',
    details: string,
    extras?: Partial<ETLLog>
): ETLLog {
    return { step, stepNumber, status, details, timestamp: Date.now(), ...extras };
}

// ─── Pipeline Context ──────────────────────────────────────────────────────────

export interface ETLResult {
    rows: any[];
    columns: ColumnDefinition[];
    logs: ETLLog[];
    timeContext?: TimeContext;
    qualityScore: number;  // 0–100
    summary: {
        totalRowsBefore: number;
        totalRowsAfter: number;
        totalColumnsOriginal: number;
        totalColumnsFinal: number;
        rowsRemoved: number;
        columnsRemoved: number;
        nullsFixed: number;
        duplicatesRemoved: number;
        typeCastCount: number;
    };
}

// ─── The Pipeline ──────────────────────────────────────────────────────────────

export function runETLPipeline(
    rawData: any[],
    fileName: string,
    columnTypeOverrides?: Record<string, ColumnType>
): ETLResult {
    const logs: ETLLog[] = [];
    const totalRowsBefore = rawData.length;
    let rows = rawData.map(r => ({ ...r })); // shallow clone
    let columns: ColumnDefinition[] = [];

    if (!rows || rows.length === 0) {
        return {
            rows: [], columns: [], logs: [], qualityScore: 0,
            summary: { totalRowsBefore: 0, totalRowsAfter: 0, totalColumnsOriginal: 0, totalColumnsFinal: 0, rowsRemoved: 0, columnsRemoved: 0, nullsFixed: 0, duplicatesRemoved: 0, typeCastCount: 0 }
        };
    }

    const totalColumnsOriginal = Object.keys(rows[0]).length;
    let nullsFixed = 0;
    let duplicatesRemoved = 0;
    let typeCastCount = 0;
    let columnsRemoved = 0;

    // ─── STEP 1: Header Normalization ─────────────────────────────────────────
    {
        const headerMap: Record<string, string> = {};
        let renamedCount = 0;
        Object.keys(rows[0]).forEach(h => {
            const normalized = h.trim().toLowerCase().replace(/[\s\W]+/g, '_').replace(/^_+|_+$/g, '') || `col_${Math.random().toString(36).substr(2, 5)}`;
            headerMap[h] = normalized;
            if (h !== normalized) renamedCount++;
        });

        rows = rows.map(row => {
            const newRow: any = {};
            Object.keys(row).forEach(k => newRow[headerMap[k] || k] = row[k]);
            return newRow;
        });

        logs.push(log('Header Normalization', 1, 'applied',
            `Normalized ${Object.keys(headerMap).length} column headers to snake_case. ${renamedCount} renamed.`,
            { affectedColumns: Object.values(headerMap) }
        ));
    }

    // ─── STEP 1.5: Auto-Merge Name Columns ────────────────────────────────────
    {
        const keys = Object.keys(rows[0] || {});
        const lowerKeys = keys.map(k => k.toLowerCase());

        // Detect first_name / last_name patterns
        const firstNameCol = keys.find((k, i) =>
            ['first_name', 'firstname', 'first', 'given_name', 'givenname'].includes(lowerKeys[i])
        );
        const lastNameCol = keys.find((k, i) =>
            ['last_name', 'lastname', 'last', 'surname', 'family_name', 'familyname'].includes(lowerKeys[i])
        );
        const middleNameCol = keys.find((k, i) =>
            ['middle_name', 'middlename', 'middle', 'middle_initial'].includes(lowerKeys[i])
        );

        if (firstNameCol && lastNameCol) {
            // Determine merged column name
            // If columns are like "customer_first_name" → merge to "customer_name"
            // Otherwise default to "full_name"
            const isCustomer = firstNameCol.toLowerCase().includes('customer') || lastNameCol.toLowerCase().includes('customer');
            const mergedColName = isCustomer ? 'customer_name' : 'full_name';

            rows = rows.map(row => {
                const first = (row[firstNameCol] || '').toString().trim();
                const last = (row[lastNameCol] || '').toString().trim();
                const middle = middleNameCol ? (row[middleNameCol] || '').toString().trim() : '';

                // Build full name: "First Middle Last" or "First Last"
                const parts = [first, middle, last].filter(p => p.length > 0);
                const fullName = parts.join(' ');

                // Create new row without the original name-part columns
                const newRow: any = {};
                for (const [k, v] of Object.entries(row)) {
                    if (k === firstNameCol || k === lastNameCol || (middleNameCol && k === middleNameCol)) continue;
                    newRow[k] = v;
                }
                newRow[mergedColName] = fullName || 'Unknown';
                return newRow;
            });

            const removedCols = middleNameCol
                ? `${firstNameCol}, ${middleNameCol}, ${lastNameCol}`
                : `${firstNameCol}, ${lastNameCol}`;

            logs.push(log('Auto-Merge Name Columns', 1, 'applied',
                `Merged ${removedCols} → '${mergedColName}' (${rows.length} rows). Original columns removed.`,
                { affectedColumns: [firstNameCol, lastNameCol, ...(middleNameCol ? [middleNameCol] : []), mergedColName] }
            ));
        } else {
            logs.push(log('Auto-Merge Name Columns', 1, 'skipped',
                'No first_name + last_name column pair detected.'
            ));
        }
    }

    // ─── STEP 2: Duplicate Column Removal ─────────────────────────────────────
    {
        const keys = Object.keys(rows[0]);
        const seen = new Set<string>();
        const dupes: string[] = [];
        keys.forEach(k => {
            if (seen.has(k)) dupes.push(k);
            else seen.add(k);
        });

        if (dupes.length > 0) {
            // Keep first occurrence, drop subsequent
            rows = rows.map(row => {
                const newRow: any = {};
                const added = new Set<string>();
                Object.keys(row).forEach(k => {
                    if (!added.has(k)) { newRow[k] = row[k]; added.add(k); }
                });
                return newRow;
            });
            columnsRemoved += dupes.length;
            logs.push(log('Duplicate Column Removal', 2, 'applied',
                `Removed ${dupes.length} duplicate column(s): ${dupes.join(', ')}`,
                { affectedColumns: dupes }
            ));
        } else {
            logs.push(log('Duplicate Column Removal', 2, 'skipped',
                'No duplicate column names found.'
            ));
        }
    }

    // ─── STEP 3: Empty Column Removal ─────────────────────────────────────────
    {
        const allKeys = Object.keys(rows[0]);
        const emptyCols: string[] = [];
        allKeys.forEach(key => {
            const filledCount = rows.filter(r => !isNullish(r[key])).length;
            if (filledCount / rows.length < 0.05) emptyCols.push(key);
        });

        if (emptyCols.length > 0) {
            rows = rows.map(row => {
                const newRow: any = {};
                Object.keys(row).forEach(k => { if (!emptyCols.includes(k)) newRow[k] = row[k]; });
                return newRow;
            });
            columnsRemoved += emptyCols.length;
            logs.push(log('Empty Column Removal', 3, 'applied',
                `Removed ${emptyCols.length} column(s) with >95% empty values: ${emptyCols.join(', ')}`,
                { affectedColumns: emptyCols }
            ));
        } else {
            logs.push(log('Empty Column Removal', 3, 'skipped',
                'All columns have sufficient data (>5% fill rate).'
            ));
        }
    }

    // ─── STEP 4: Empty Row Removal ────────────────────────────────────────────
    {
        const before = rows.length;
        const activeKeys = Object.keys(rows[0]);
        rows = rows.filter(row => activeKeys.some(k => !isNullish(row[k])));
        const removed = before - rows.length;

        if (removed > 0) {
            logs.push(log('Empty Row Removal', 4, 'applied',
                `Removed ${removed} completely empty row(s).`,
                { rowsBefore: before, rowsAfter: rows.length, affectedRows: removed }
            ));
        } else {
            logs.push(log('Empty Row Removal', 4, 'skipped',
                'No completely empty rows found.'
            ));
        }
    }

    // ─── STEP 5: Whitespace Trimming ──────────────────────────────────────────
    {
        let trimCount = 0;
        const trimmedCols = new Set<string>();
        rows = rows.map(row => {
            const newRow: any = {};
            Object.keys(row).forEach(k => {
                const v = row[k];
                if (typeof v === 'string') {
                    const trimmed = v.trim();
                    if (trimmed !== v) { trimCount++; trimmedCols.add(k); }
                    newRow[k] = trimmed;
                } else {
                    newRow[k] = v;
                }
            });
            return newRow;
        });

        if (trimCount > 0) {
            logs.push(log('Whitespace Trimming', 5, 'applied',
                `Trimmed whitespace in ${trimCount} cell(s) across ${trimmedCols.size} column(s).`,
                { affectedColumns: [...trimmedCols], affectedRows: trimCount }
            ));
        } else {
            logs.push(log('Whitespace Trimming', 5, 'skipped',
                'No leading/trailing whitespace detected in string values.'
            ));
        }
    }

    // ─── STEP 6: Null/NA Standardization ──────────────────────────────────────
    {
        let standardized = 0;
        const affectedCols = new Set<string>();
        rows = rows.map(row => {
            const newRow: any = {};
            Object.keys(row).forEach(k => {
                const v = row[k];
                if (typeof v === 'string' && NULL_TOKENS.has(v.toLowerCase().trim()) && v.trim() !== '') {
                    newRow[k] = null;
                    standardized++;
                    nullsFixed++;
                    affectedCols.add(k);
                } else {
                    newRow[k] = row[k];
                }
            });
            return newRow;
        });

        if (standardized > 0) {
            logs.push(log('Null/NA Standardization', 6, 'applied',
                `Converted ${standardized} placeholder value(s) (N/A, null, -, etc.) to null across ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: standardized }
            ));
        } else {
            logs.push(log('Null/NA Standardization', 6, 'skipped',
                'No placeholder null values (N/A, null, -, etc.) detected.'
            ));
        }
    }

    // ─── STEP 7: Exact Duplicate Row Removal ──────────────────────────────────
    {
        const before = rows.length;
        const seen = new Set<string>();
        rows = rows.filter(row => {
            const key = JSON.stringify(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const removed = before - rows.length;
        duplicatesRemoved = removed;

        if (removed > 0) {
            logs.push(log('Exact Duplicate Row Removal', 7, 'applied',
                `Removed ${removed} exact duplicate row(s).`,
                { rowsBefore: before, rowsAfter: rows.length, affectedRows: removed }
            ));
        } else {
            logs.push(log('Exact Duplicate Row Removal', 7, 'skipped',
                'No exact duplicate rows found.'
            ));
        }
    }

    // ─── STEP 8: Type Inference ───────────────────────────────────────────────
    {
        const sample = rows.slice(0, 100);
        const activeKeys = Object.keys(rows[0] || {});
        columns = activeKeys.map(key => {
            let detectedType = inferColumnType(key, sample.map(r => r[key]));

            // Apply user overrides
            if (columnTypeOverrides && columnTypeOverrides[key]) {
                const override = columnTypeOverrides[key];
                if (detectedType !== override) {
                    logs.push(log('User Override', 8, 'info',
                        `Column '${key}' changed from ${detectedType} to ${override} (manual override).`,
                        { affectedColumns: [key] }
                    ));
                }
                detectedType = override;
            }

            return { name: key, type: detectedType, originalType: 'string' };
        });

        const metrics = columns.filter(c => c.type === ColumnType.METRIC).length;
        const dates = columns.filter(c => c.type === ColumnType.DATE).length;
        const dims = columns.filter(c => c.type === ColumnType.DIMENSION).length;
        const ids = columns.filter(c => c.type === ColumnType.ID).length;

        logs.push(log('Type Inference', 8, 'applied',
            `Classified ${columns.length} columns: ${metrics} metric(s), ${dates} date(s), ${dims} dimension(s), ${ids} ID(s).`,
            { affectedColumns: columns.map(c => c.name) }
        ));
    }

    // ─── STEP 9: Currency Symbol Removal ──────────────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        let cleaned = 0;
        const affectedCols = new Set<string>();

        rows = rows.map(row => {
            const newRow: any = { ...row };
            metricCols.forEach(col => {
                const v = newRow[col];
                if (typeof v === 'string' && /[$€£¥₹₩₫₽¢]/.test(v)) {
                    const stripped = v.replace(/[$€£¥₹₩₫₽¢,\s]/g, '');
                    const num = parseFloat(stripped);
                    newRow[col] = isNaN(num) ? 0 : num;
                    cleaned++;
                    affectedCols.add(col);
                    typeCastCount++;
                }
            });
            return newRow;
        });

        if (cleaned > 0) {
            logs.push(log('Currency Symbol Removal', 9, 'applied',
                `Stripped currency symbols from ${cleaned} cell(s) in ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: cleaned }
            ));
        } else {
            logs.push(log('Currency Symbol Removal', 9, 'skipped',
                'No currency symbols ($, €, £, etc.) found in metric columns.'
            ));
        }
    }

    // ─── STEP 10: Percentage Symbol Handling ──────────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        let converted = 0;
        const affectedCols = new Set<string>();

        rows = rows.map(row => {
            const newRow: any = { ...row };
            metricCols.forEach(col => {
                const v = newRow[col];
                if (typeof v === 'string' && v.includes('%')) {
                    const num = parseFloat(v.replace(/%/g, '').trim());
                    if (!isNaN(num)) {
                        newRow[col] = num; // Keep as percentage number (e.g., 45.3 for "45.3%")
                        converted++;
                        affectedCols.add(col);
                        typeCastCount++;
                    }
                }
            });
            return newRow;
        });

        if (converted > 0) {
            logs.push(log('Percentage Symbol Handling', 10, 'applied',
                `Removed % symbol and converted ${converted} value(s) to numeric in ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: converted }
            ));
        } else {
            logs.push(log('Percentage Symbol Handling', 10, 'skipped',
                'No percentage symbols (%) found in metric columns.'
            ));
        }
    }

    // ─── STEP 11: Numeric String Casting ──────────────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        let casted = 0;

        rows = rows.map(row => {
            const newRow: any = { ...row };
            metricCols.forEach(col => {
                const v = newRow[col];
                if (typeof v === 'string') {
                    const stripped = v.replace(/[,\s]/g, '');
                    const num = parseFloat(stripped);
                    newRow[col] = isNaN(num) ? 0 : num;
                    casted++;
                    typeCastCount++;
                } else if (typeof v !== 'number') {
                    newRow[col] = 0;
                }
            });
            return newRow;
        });

        if (casted > 0) {
            logs.push(log('Numeric String Casting', 11, 'applied',
                `Cast ${casted} string value(s) to numbers in ${metricCols.length} metric column(s).`,
                { affectedColumns: metricCols, affectedRows: casted }
            ));
        } else {
            logs.push(log('Numeric String Casting', 11, 'skipped',
                'All metric columns already contain numeric values.'
            ));
        }
    }

    // ─── STEP 12: Date Standardization ────────────────────────────────────────
    {
        const dateCols = columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);
        let converted = 0;
        let minDate = '';
        let maxDate = '';
        let maxOrderDate = '';

        if (dateCols.length > 0) {
            // DEBUG: Log raw date values BEFORE any conversion
            dateCols.forEach(col => {
                const rawSamples = rows.slice(0, 5).map(r => r[col]);
                console.log(`[ETL Step12 DEBUG] Column "${col}" — first 5 raw values: ${JSON.stringify(rawSamples)}`);
            });
            rows = rows.map(row => {
                const newRow: any = { ...row };
                dateCols.forEach(col => {
                    const v = newRow[col];
                    let isoDate: string | null = null;

                    if (v === null || v === undefined || v === '') {
                        newRow[col] = null;
                        return;
                    }

                    // 1. JS Date object (most common with cellDates: true)
                    if (v instanceof Date) {
                        if (!isNaN(v.getTime())) {
                            const year = v.getUTCFullYear();
                            if (year >= 1900 && year <= 2100) {
                                isoDate = v.toISOString().split('T')[0];
                            }
                        }
                    }
                    // 2. String values (ISO, US format, etc.)
                    else if (typeof v === 'string') {
                        if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
                            isoDate = v.substring(0, 10);
                        } else {
                            const d = new Date(v);
                            if (!isNaN(d.getTime())) {
                                const year = d.getUTCFullYear();
                                if (year >= 1900 && year <= 2100) {
                                    isoDate = d.toISOString().split('T')[0];
                                }
                            }
                        }
                    }
                    // 3. Excel serial number (fallback only — cellDates should handle this)
                    else if (typeof v === 'number' && v > 1 && v < 100000) {
                        try {
                            const jsDate = excelDateToJSDate(v);
                            const year = jsDate.getUTCFullYear();
                            if (year >= 1900 && year <= 2100) {
                                isoDate = jsDate.toISOString().split('T')[0];
                            }
                        } catch { isoDate = null; }
                    }

                    if (isoDate) {
                        if (String(v) !== isoDate) converted++;
                        newRow[col] = isoDate;

                        if (!minDate || isoDate < minDate) minDate = isoDate;
                        if (!maxDate || isoDate > maxDate) maxDate = isoDate;
                        if (col.includes('order_date') || col === 'date') {
                            if (!maxOrderDate || isoDate > maxOrderDate) maxOrderDate = isoDate;
                        }
                    } else {
                        newRow[col] = null;
                    }
                });
                return newRow;
            });

            // DEBUG: Log converted dates — last 5 values + computed range
            dateCols.forEach(col => {
                const last5 = rows.slice(-5).map(r => r[col]);
                console.log(`[ETL Step12 AFTER] Column "${col}" — last 5 converted: ${JSON.stringify(last5)}`);
            });
            console.log(`[ETL Step12 RESULT] minDate="${minDate}", maxDate="${maxDate}", maxOrderDate="${maxOrderDate}"`);

            logs.push(log('Date Standardization', 12, 'applied',
                `Standardized ${converted} date value(s) to ISO format (YYYY-MM-DD) across ${dateCols.length} column(s).` +
                (minDate ? ` Range: ${minDate} → ${maxDate}` : ''),
                { affectedColumns: dateCols, affectedRows: converted }
            ));
        } else {
            logs.push(log('Date Standardization', 12, 'skipped',
                'No date columns detected in dataset.'
            ));
        }
    }

    // ─── STEP 13: Boolean Normalization ───────────────────────────────────────
    {
        let normalized = 0;
        const affectedCols = new Set<string>();
        const boolMap: Record<string, boolean> = {
            'true': true, 'false': false, 'yes': true, 'no': false,
            't': true, 'f': false, 'y': true, 'n': false,
            '1': true, '0': false
        };

        const dimCols = columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name);

        dimCols.forEach(col => {
            // Detect if this column is boolean-like (>80% of values are bool tokens)
            const vals = rows.map(r => r[col]).filter(v => v !== null && v !== undefined);
            const boolCount = vals.filter(v => typeof v === 'string' && boolMap[v.toLowerCase().trim()] !== undefined).length;
            if (vals.length > 0 && boolCount / vals.length > 0.8) {
                rows.forEach(row => {
                    const v = row[col];
                    if (typeof v === 'string' && boolMap[v.toLowerCase().trim()] !== undefined) {
                        row[col] = boolMap[v.toLowerCase().trim()];
                        normalized++;
                        affectedCols.add(col);
                    }
                });
            }
        });

        if (normalized > 0) {
            logs.push(log('Boolean Normalization', 13, 'applied',
                `Normalized ${normalized} boolean value(s) (Yes/No/TRUE/FALSE → true/false) in ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: normalized }
            ));
        } else {
            logs.push(log('Boolean Normalization', 13, 'skipped',
                'No boolean-like text columns detected (requires >80% boolean values).'
            ));
        }
    }

    // ─── STEP 14: Metric Null Imputation ──────────────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        let imputed = 0;
        const affectedCols = new Set<string>();

        rows.forEach(row => {
            metricCols.forEach(col => {
                if (row[col] === null || row[col] === undefined || isNaN(row[col])) {
                    row[col] = 0;
                    imputed++;
                    nullsFixed++;
                    affectedCols.add(col);
                }
            });
        });

        if (imputed > 0) {
            logs.push(log('Metric Null Imputation', 14, 'applied',
                `Imputed ${imputed} null/NaN metric value(s) to 0 in ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: imputed }
            ));
        } else {
            logs.push(log('Metric Null Imputation', 14, 'skipped',
                'No null or NaN values found in metric columns.'
            ));
        }
    }

    // ─── STEP 15: Outlier Detection (Flag Only) ──────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        const outlierReport: string[] = [];

        metricCols.forEach(col => {
            const values = rows.map(r => r[col]).filter(v => typeof v === 'number' && !isNaN(v)).sort((a, b) => a - b);
            if (values.length < 10) return; // Too few values for meaningful IQR

            const q1 = values[Math.floor(values.length * 0.25)];
            const q3 = values[Math.floor(values.length * 0.75)];
            const iqr = q3 - q1;
            if (iqr === 0) return;

            const lower = q1 - 1.5 * iqr;
            const upper = q3 + 1.5 * iqr;
            const outlierCount = values.filter(v => v < lower || v > upper).length;

            if (outlierCount > 0) {
                outlierReport.push(`${col}: ${outlierCount} outlier(s) outside [${lower.toFixed(1)}, ${upper.toFixed(1)}]`);
            }
        });

        if (outlierReport.length > 0) {
            logs.push(log('Outlier Detection', 15, 'info',
                `Flagged outliers (not removed) in ${outlierReport.length} column(s): ${outlierReport.join('; ')}`,
                { affectedColumns: outlierReport.map(r => r.split(':')[0]) }
            ));
        } else {
            logs.push(log('Outlier Detection', 15, 'skipped',
                'No significant outliers detected using IQR method (or too few data points).'
            ));
        }
    }

    // ─── STEP 16: Categorical Consistency ─────────────────────────────────────
    {
        const dimCols = columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name);
        let fixedCount = 0;
        const affectedCols = new Set<string>();

        rows.forEach(row => {
            dimCols.forEach(col => {
                const v = row[col];
                if (typeof v === 'string') {
                    const cleaned = v.trim().replace(/\s+/g, ' ');
                    if (cleaned !== v) {
                        row[col] = cleaned;
                        fixedCount++;
                        affectedCols.add(col);
                    }
                }
            });
        });

        if (fixedCount > 0) {
            logs.push(log('Categorical Consistency', 16, 'applied',
                `Standardized whitespace in ${fixedCount} dimension value(s) across ${affectedCols.size} column(s).`,
                { affectedColumns: [...affectedCols], affectedRows: fixedCount }
            ));
        } else {
            logs.push(log('Categorical Consistency', 16, 'skipped',
                'All dimension values already have consistent formatting.'
            ));
        }
    }

    // ─── STEP 17: Leading Zero Preservation ───────────────────────────────────
    {
        const idCols = columns.filter(c => c.type === ColumnType.ID).map(c => c.name);
        let preserved = 0;

        if (idCols.length > 0) {
            rows.forEach(row => {
                idCols.forEach(col => {
                    const v = row[col];
                    // Convert numbers back to strings for ID columns to preserve format
                    if (typeof v === 'number') {
                        row[col] = String(v);
                        preserved++;
                    }
                });
            });
        }

        if (preserved > 0) {
            logs.push(log('Leading Zero Preservation', 17, 'applied',
                `Preserved ${preserved} ID value(s) as strings to prevent numeric coercion.`,
                { affectedColumns: idCols, affectedRows: preserved }
            ));
        } else {
            logs.push(log('Leading Zero Preservation', 17, 'skipped',
                idCols.length === 0 ? 'No ID columns detected.' : 'All ID values already stored as strings.'
            ));
        }
    }

    // ─── STEP 18: Negative Value Audit ────────────────────────────────────────
    {
        const metricCols = columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
        // Revenue/sales/price columns that typically should not be negative
        const positiveExpected = metricCols.filter(c => {
            const l = c.toLowerCase();
            return ['price', 'revenue', 'sales', 'quantity', 'qty', 'units', 'count'].some(k => l.includes(k));
        });

        const negReport: string[] = [];
        positiveExpected.forEach(col => {
            const negCount = rows.filter(r => typeof r[col] === 'number' && r[col] < 0).length;
            if (negCount > 0) negReport.push(`${col}: ${negCount} negative value(s)`);
        });

        if (negReport.length > 0) {
            logs.push(log('Negative Value Audit', 18, 'info',
                `Found unexpected negatives (flagged only, not removed): ${negReport.join('; ')}`,
                { affectedColumns: positiveExpected }
            ));
        } else {
            logs.push(log('Negative Value Audit', 18, 'skipped',
                positiveExpected.length === 0
                    ? 'No typically-positive metric columns (price, revenue, qty) detected.'
                    : 'No unexpected negative values found in revenue/price/quantity columns.'
            ));
        }
    }

    // ─── STEP 19: Data Completeness Audit ─────────────────────────────────────
    {
        const allKeys = Object.keys(rows[0] || {});
        const completeness: { col: string; pct: number }[] = [];
        const lowCompleteness: string[] = [];

        allKeys.forEach(key => {
            const filled = rows.filter(r => r[key] !== null && r[key] !== undefined && r[key] !== '').length;
            const pct = rows.length > 0 ? Math.round((filled / rows.length) * 100) : 0;
            completeness.push({ col: key, pct });
            if (pct < 70) lowCompleteness.push(`${key} (${pct}%)`);
        });

        const avgCompleteness = completeness.reduce((s, c) => s + c.pct, 0) / (completeness.length || 1);

        if (lowCompleteness.length > 0) {
            logs.push(log('Data Completeness Audit', 19, 'info',
                `Average completeness: ${avgCompleteness.toFixed(1)}%. Low completeness columns: ${lowCompleteness.join(', ')}`,
                { affectedColumns: lowCompleteness.map(l => l.split(' (')[0]) }
            ));
        } else {
            logs.push(log('Data Completeness Audit', 19, 'applied',
                `All columns have ≥70% completeness. Average: ${avgCompleteness.toFixed(1)}%.`
            ));
        }
    }

    // ─── STEP 20: Final Summary ───────────────────────────────────────────────
    const totalRowsAfter = rows.length;
    const totalColumnsFinal = Object.keys(rows[0] || {}).length;
    const rowsRemoved = totalRowsBefore - totalRowsAfter;

    // Calculate quality score
    const allKeys = Object.keys(rows[0] || {});
    let completenessScore = 0;
    allKeys.forEach(key => {
        const filled = rows.filter(r => r[key] !== null && r[key] !== undefined && r[key] !== '').length;
        completenessScore += rows.length > 0 ? filled / rows.length : 0;
    });
    completenessScore = allKeys.length > 0 ? (completenessScore / allKeys.length) * 100 : 0;

    const dupePenalty = duplicatesRemoved > 0 ? Math.min(10, (duplicatesRemoved / totalRowsBefore) * 100) : 0;
    const nullPenalty = nullsFixed > 0 ? Math.min(10, (nullsFixed / (totalRowsBefore * allKeys.length)) * 100) : 0;
    const qualityScore = Math.round(Math.max(0, Math.min(100, completenessScore - dupePenalty - nullPenalty)));

    // Build TimeContext from date step data
    // IMPORTANT: defaultAnchorDate MUST be the MAX date of the primary/anchor date column.
    // This is the "Dataset Time Anchor" — defines what "today" means for time-based analysis.
    let timeContext: TimeContext | undefined;
    const dateCols = columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);
    if (dateCols.length > 0) {
        let gMinDate = '';
        let gMaxDate = '';
        // Track max date per individual date column
        const perColumnMax: Record<string, string> = {};

        // Helper: normalize any date value to ISO string (YYYY-MM-DD)
        const toISO = (v: any): string | null => {
            if (!v) return null;
            // 1. JS Date object (from cellDates: true)
            if (v instanceof Date) {
                return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0];
            }
            // 2. Already ISO format string
            if (typeof v === 'string') {
                if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.substring(0, 10);
                // Try parsing common date formats
                const d = new Date(v);
                if (!isNaN(d.getTime())) {
                    const year = d.getUTCFullYear();
                    if (year >= 1900 && year <= 2100) {
                        return d.toISOString().split('T')[0];
                    }
                }
                return null;
            }
            // 3. Skip raw numbers — cellDates: true should have converted serials to Date objects
            if (typeof v === 'number') {
                console.warn(`[ETL TimeContext] Unexpected number in date column: ${v} — skipping`);
                return null;
            }
            return null;
        };

        rows.forEach(row => {
            dateCols.forEach(col => {
                const iso = toISO(row[col]);
                if (iso) {
                    if (!gMinDate || iso < gMinDate) gMinDate = iso;
                    if (!gMaxDate || iso > gMaxDate) gMaxDate = iso;
                    // Track per-column max
                    if (!perColumnMax[col] || iso > perColumnMax[col]) {
                        perColumnMax[col] = iso;
                    }
                }
            });
        });

        if (gMinDate && gMaxDate) {
            // Auto-detect best anchor column by priority
            // Priority: order_date > transaction > invoice > sale_date > date > first date column
            const priorityPatterns = [
                (lc: string) => lc.includes('order') && !lc.includes('ship'),
                (lc: string) => lc.includes('transaction'),
                (lc: string) => lc.includes('invoice'),
                (lc: string) => lc === 'sale_date' || lc === 'sales_date',
                (lc: string) => lc === 'date',
            ];

            let anchorCol = '';
            for (const test of priorityPatterns) {
                const match = dateCols.find(c => test(c.toLowerCase()));
                if (match && perColumnMax[match]) {
                    anchorCol = match;
                    break;
                }
            }
            // Fallback: use the first date column that has data
            if (!anchorCol) {
                anchorCol = dateCols.find(c => perColumnMax[c]) || dateCols[0];
            }

            const anchorDate = perColumnMax[anchorCol] || gMaxDate;

            console.log(`[ETL TimeContext] anchor_column="${anchorCol}", anchor_date="${anchorDate}", all_maxes=`, perColumnMax);

            timeContext = {
                minDate: gMinDate,
                maxDate: gMaxDate,
                defaultAnchorDate: anchorDate,
                anchorDateColumn: anchorCol,
                dateColumnMaxDates: perColumnMax,
            };
        }
    }

    const applied = logs.filter(l => l.status === 'applied').length;
    const skipped = logs.filter(l => l.status === 'skipped').length;
    const flagged = logs.filter(l => l.status === 'info').length;

    logs.push(log('Final Summary', 20, 'applied',
        `Pipeline complete. ${applied} step(s) applied, ${skipped} skipped, ${flagged} flagged. ` +
        `${totalRowsAfter} clean rows from ${totalRowsBefore} original. Data quality: ${qualityScore}/100.`,
        { rowsBefore: totalRowsBefore, rowsAfter: totalRowsAfter }
    ));

    return {
        rows,
        columns,
        logs,
        timeContext,
        qualityScore,
        summary: {
            totalRowsBefore,
            totalRowsAfter,
            totalColumnsOriginal,
            totalColumnsFinal,
            rowsRemoved,
            columnsRemoved,
            nullsFixed,
            duplicatesRemoved,
            typeCastCount,
        }
    };
}
