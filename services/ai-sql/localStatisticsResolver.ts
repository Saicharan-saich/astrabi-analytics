/**
 * localStatisticsResolver.ts — DuckDB-Computed Evidence Engine
 *
 * Computes real statistical evidence from the dataset via DuckDB-WASM.
 * The LLM NEVER guesses thresholds — this engine provides:
 *   - Mean, median, percentiles per metric
 *   - Cardinality and top values per dimension
 *   - Time range boundaries
 *   - Distribution shape detection
 *   - Category value fuzzy matching
 *
 * All evidence is cached per dataset to avoid redundant queries.
 */

import { executeSQLViaDuckDB } from '../duckdbEngine';
import { SemanticModel, SemanticField } from './types';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface MetricStats {
    column: string;
    mean: number;
    median: number;
    stddev: number;
    p25: number;
    p75: number;
    p90: number;
    p99: number;
    min: number;
    max: number;
    nullRate: number;
    nonNullCount: number;
    /** Coefficient of variation — lower = more stable */
    stability: number;
    /** Detected distribution shape */
    distribution: 'normal' | 'skewed_right' | 'skewed_left' | 'uniform' | 'unknown';
}

export interface DimensionStats {
    column: string;
    cardinality: number;
    topValues: { value: string; count: number; pct: number }[];
    nullRate: number;
    avgGroupSize: number;
}

export interface TimeStats {
    column: string;
    minDate: string;
    maxDate: string;
    spanDays: number;
    distinctDates: number;
    /** Detected grain: daily, weekly, monthly, etc. */
    detectedGrain: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'irregular';
}

export interface DatasetStatistics {
    metrics: Record<string, MetricStats>;
    dimensions: Record<string, DimensionStats>;
    timeStats: TimeStats | null;
    totalRows: number;
    computedAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════════

const statsCache = new Map<string, DatasetStatistics>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(datasetName: string): string {
    return `stats_${datasetName}`;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function q(col: string): string {
    return `"${col.replace(/"/g, '""')}"`;
}

async function safeQuery(sql: string): Promise<any[]> {
    try {
        return await executeSQLViaDuckDB(sql);
    } catch (err) {
        console.warn('[LocalStats] Query failed:', sql, err);
        return [];
    }
}

function detectDistribution(mean: number, median: number, stddev: number, p25: number, p75: number): MetricStats['distribution'] {
    if (stddev === 0) return 'uniform';
    const skewness = (mean - median) / stddev;
    if (Math.abs(skewness) < 0.3) return 'normal';
    if (skewness > 0.3) return 'skewed_right';
    if (skewness < -0.3) return 'skewed_left';
    return 'unknown';
}

function detectTimeGrain(spanDays: number, distinctDates: number): TimeStats['detectedGrain'] {
    if (distinctDates === 0 || spanDays === 0) return 'irregular';
    const avgGap = spanDays / distinctDates;
    if (avgGap <= 1.5) return 'daily';
    if (avgGap <= 8) return 'weekly';
    if (avgGap <= 35) return 'monthly';
    if (avgGap <= 100) return 'quarterly';
    if (avgGap <= 400) return 'yearly';
    return 'irregular';
}

// ═══════════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute comprehensive statistics for a dataset using DuckDB.
 * Results are cached for 5 minutes to avoid redundant queries.
 */
export async function resolveLocalStatistics(
    datasetName: string,
    semanticModel: SemanticModel
): Promise<DatasetStatistics> {
    // Check cache
    const cacheKey = getCacheKey(datasetName);
    const cached = statsCache.get(cacheKey);
    if (cached && (Date.now() - cached.computedAt) < CACHE_TTL_MS) {
        console.log('[LocalStats] Returning cached statistics');
        return cached;
    }

    console.log('[LocalStats] Computing fresh statistics via DuckDB...');
    const startTime = performance.now();

    const metricFields = semanticModel.fields.filter(f => f.role === 'metric' && f.physicalType === 'number');
    const dimFields = semanticModel.fields.filter(f => f.role === 'dimension' && f.physicalType === 'string');
    const dateField = semanticModel.fields.find(f => f.physicalType === 'date');

    // ─── Total Row Count ─────────────────────────────────────────
    const countResult = await safeQuery('SELECT COUNT(*) as cnt FROM data');
    const totalRows = countResult[0]?.cnt ?? 0;

    // ─── Metric Statistics ───────────────────────────────────────
    const metrics: Record<string, MetricStats> = {};

    for (const field of metricFields.slice(0, 15)) { // Cap at 15 metrics for performance
        const col = q(field.name);
        const sql = `
            SELECT
                AVG(${col})::DOUBLE AS mean,
                MEDIAN(${col})::DOUBLE AS median,
                STDDEV_SAMP(${col})::DOUBLE AS stddev,
                QUANTILE_CONT(${col}, 0.25)::DOUBLE AS p25,
                QUANTILE_CONT(${col}, 0.75)::DOUBLE AS p75,
                QUANTILE_CONT(${col}, 0.90)::DOUBLE AS p90,
                QUANTILE_CONT(${col}, 0.99)::DOUBLE AS p99,
                MIN(${col})::DOUBLE AS min_val,
                MAX(${col})::DOUBLE AS max_val,
                COUNT(${col}) AS non_null,
                COUNT(*) AS total
            FROM data
            WHERE ${col} IS NOT NULL
        `;

        const rows = await safeQuery(sql);
        if (rows.length > 0) {
            const r = rows[0];
            const mean = r.mean ?? 0;
            const median = r.median ?? 0;
            const stddev = r.stddev ?? 0;
            const nonNull = r.non_null ?? 0;
            const total = r.total ?? totalRows;

            metrics[field.name] = {
                column: field.name,
                mean,
                median,
                stddev,
                p25: r.p25 ?? 0,
                p75: r.p75 ?? 0,
                p90: r.p90 ?? 0,
                p99: r.p99 ?? 0,
                min: r.min_val ?? 0,
                max: r.max_val ?? 0,
                nullRate: total > 0 ? 1 - (nonNull / total) : 0,
                nonNullCount: nonNull,
                stability: mean !== 0 ? stddev / Math.abs(mean) : 0,
                distribution: detectDistribution(mean, median, stddev, r.p25 ?? 0, r.p75 ?? 0),
            };
        }
    }

    // ─── Dimension Statistics ────────────────────────────────────
    const dimensions: Record<string, DimensionStats> = {};

    for (const field of dimFields.slice(0, 10)) { // Cap at 10 dimensions
        const col = q(field.name);

        // Cardinality + null rate
        const cardSql = `
            SELECT
                COUNT(DISTINCT ${col}) AS cardinality,
                COUNT(*) - COUNT(${col}) AS null_count,
                COUNT(*) AS total
            FROM data
        `;
        const cardRows = await safeQuery(cardSql);

        // Top values
        const topSql = `
            SELECT ${col} AS val, COUNT(*) AS cnt
            FROM data
            WHERE ${col} IS NOT NULL
            GROUP BY ${col}
            ORDER BY cnt DESC
            LIMIT 10
        `;
        const topRows = await safeQuery(topSql);

        if (cardRows.length > 0) {
            const c = cardRows[0];
            const cardinality = c.cardinality ?? 0;
            const total = c.total ?? totalRows;
            const nullCount = c.null_count ?? 0;

            dimensions[field.name] = {
                column: field.name,
                cardinality,
                topValues: topRows.map(r => ({
                    value: String(r.val ?? ''),
                    count: r.cnt ?? 0,
                    pct: total > 0 ? ((r.cnt ?? 0) / total) * 100 : 0,
                })),
                nullRate: total > 0 ? nullCount / total : 0,
                avgGroupSize: cardinality > 0 ? (total - nullCount) / cardinality : 0,
            };
        }
    }

    // ─── Time Statistics ─────────────────────────────────────────
    let timeStats: TimeStats | null = null;

    if (dateField) {
        const col = q(dateField.name);
        const timeSql = `
            SELECT
                MIN(${col})::VARCHAR AS min_date,
                MAX(${col})::VARCHAR AS max_date,
                DATEDIFF('day', MIN(${col}), MAX(${col})) AS span_days,
                COUNT(DISTINCT ${col}::DATE) AS distinct_dates
            FROM data
            WHERE ${col} IS NOT NULL
        `;
        const timeRows = await safeQuery(timeSql);

        if (timeRows.length > 0 && timeRows[0].min_date) {
            const t = timeRows[0];
            const spanDays = t.span_days ?? 0;
            const distinctDates = t.distinct_dates ?? 0;

            timeStats = {
                column: dateField.name,
                minDate: t.min_date,
                maxDate: t.max_date,
                spanDays,
                distinctDates,
                detectedGrain: detectTimeGrain(spanDays, distinctDates),
            };
        }
    }

    // ─── Build Result ────────────────────────────────────────────
    const result: DatasetStatistics = {
        metrics,
        dimensions,
        timeStats,
        totalRows,
        computedAt: Date.now(),
    };

    // Cache it
    statsCache.set(cacheKey, result);

    const elapsed = Math.round(performance.now() - startTime);
    console.log(`[LocalStats] Computed: ${Object.keys(metrics).length} metrics, ${Object.keys(dimensions).length} dimensions, time=${timeStats ? 'yes' : 'no'} (${elapsed}ms)`);

    return result;
}

// ═══════════════════════════════════════════════════════════════════
// TARGETED QUERIES
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute a specific threshold for a metric using a DuckDB expression.
 * Used by the ambiguity resolver to evaluate policy thresholds.
 */
export async function computeThreshold(
    metricColumn: string,
    statExpression: string
): Promise<number | null> {
    const sql = `SELECT (${statExpression})::DOUBLE AS threshold FROM data`;
    const rows = await safeQuery(sql);
    return rows.length > 0 ? (rows[0].threshold ?? null) : null;
}

/**
 * Fuzzy-match a category value against actual values in a dimension column.
 * Handles case mismatches like "technology" vs "Technology".
 */
export async function matchCategoryValue(
    dimensionColumn: string,
    searchValue: string
): Promise<{ exactMatch: string | null; fuzzyMatches: string[] }> {
    const col = q(dimensionColumn);
    const escaped = searchValue.replace(/'/g, "''");

    // Exact match
    const exactSql = `SELECT DISTINCT ${col} AS val FROM data WHERE ${col} = '${escaped}' LIMIT 1`;
    const exactRows = await safeQuery(exactSql);

    if (exactRows.length > 0) {
        return { exactMatch: String(exactRows[0].val), fuzzyMatches: [] };
    }

    // Case-insensitive match
    const fuzzySql = `SELECT DISTINCT ${col} AS val FROM data WHERE LOWER(${col}) LIKE '%${escaped.toLowerCase()}%' LIMIT 5`;
    const fuzzyRows = await safeQuery(fuzzySql);

    return {
        exactMatch: null,
        fuzzyMatches: fuzzyRows.map(r => String(r.val)),
    };
}

/** Clear the statistics cache */
export function clearStatsCache(): void {
    statsCache.clear();
}
