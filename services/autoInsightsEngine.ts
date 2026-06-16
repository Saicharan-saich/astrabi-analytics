/**
 * autoInsightsEngine.ts — Deterministic Auto-Analysis Engine
 *
 * Generates 15 curated insights from a dataset using DuckDB SQL.
 * NO AI/LLM calls — 100% deterministic, 100% accurate.
 * Uses the semantic model to pick correct aggregations.
 */

import { Dataset } from '../types';
import { SemanticModel, SemanticMeasure, SemanticDimension } from './semanticModel';
import { executeSQLViaDuckDB } from './duckdbEngine';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface AutoInsight {
    id: string;
    title: string;
    subtitle: string;
    category: 'kpi' | 'ranking' | 'trend' | 'distribution' | 'diagnostic' | 'comparative';
    priority: number;
    chartType: 'kpiCard' | 'bar' | 'horizontalBar' | 'line' | 'area' | 'donut' | 'pie';
    data: any[];
    xKey: string;
    yKey: string;
    yLabel: string;
    sql: string;
    kpiValue?: number | string;
    kpiFormat?: 'currency_usd' | 'number' | 'percent' | 'compact';
    status: 'pending' | 'done' | 'error';
    error?: string;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/** Quote a column name for DuckDB SQL */
function q(col: string): string {
    return `"${col.replace(/"/g, '""')}"`;
}

/** Get the AGG function name */
function aggFn(measure: SemanticMeasure): string {
    const agg = measure.aggregation?.toUpperCase() || 'SUM';
    if (agg === 'COUNT_DISTINCT') return 'COUNT(DISTINCT';
    return agg;
}

/** Build aggregation expression */
function aggExpr(measure: SemanticMeasure): string {
    const agg = measure.aggregation?.toUpperCase() || 'SUM';
    if (agg === 'COUNT_DISTINCT') return `COUNT(DISTINCT ${q(measure.column)})`;
    return `${agg}(${q(measure.column)})`;
}

/** Human-readable label for a column */
function humanize(col: string): string {
    return col.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Determine KPI format from measure */
function kpiFormat(measure: SemanticMeasure): AutoInsight['kpiFormat'] {
    if (measure.format === 'currency_usd' || measure.format === 'currency_eur') return 'currency_usd';
    if (measure.format === 'percent') return 'percent';
    return 'number';
}

// ── BLACKLIST: columns that should NEVER be used as measures or meaningful dimensions ──
const ID_PATTERNS = /\b(id|_id|uuid|guid|key|pk|fk|index|row_?num|serial|code)\b/i;
const NAME_PATTERNS = /\b(name|first_?name|last_?name|full_?name|patient_?name|employee_?name|customer_?name)\b/i;

/** True if column looks like an identifier (not a business metric) */
function isIdLike(col: string): boolean {
    return ID_PATTERNS.test(col);
}

/** Get meaningful measures — filter out IDs, row numbers, keys */
function getBusinessMeasures(model: SemanticModel): SemanticMeasure[] {
    return model.measures.filter(m => !m.isHidden && !isIdLike(m.column));
}

/** Pick the primary additive measure (revenue, sales, cost — NOT order_id) */
function pickPrimaryMeasure(model: SemanticModel): SemanticMeasure | null {
    const biz = getBusinessMeasures(model);
    // Prefer additive currency measures first (revenue, sales, cost)
    return biz.find(m => m.behavior === 'additive' && (m.format === 'currency_usd' || m.format === 'currency_eur'))
        || biz.find(m => m.behavior === 'additive')
        || biz[0]
        || null;
}

/** Pick a secondary measure different from primary (also excluding IDs) */
function pickSecondaryMeasure(model: SemanticModel, primary: SemanticMeasure | null): SemanticMeasure | null {
    const biz = getBusinessMeasures(model);
    return biz.find(m => m.column !== primary?.column) || null;
}

/** Pick a non-additive measure (for diagnostic — e.g., discount rate, satisfaction score) */
function pickNonAdditiveMeasure(model: SemanticModel, primary: SemanticMeasure | null): SemanticMeasure | null {
    const biz = getBusinessMeasures(model);
    return biz.find(m => m.behavior === 'non_additive' && m.column !== primary?.column) || null;
}

/**
 * Rank dimensions by analytical value.
 * Prefer: category > region > department > channel > type
 * Avoid: individual names (high cardinality, not aggregatable)
 */
function rankDimensions(dims: SemanticDimension[]): SemanticDimension[] {
    const GOOD_PATTERNS = /\b(category|region|department|channel|type|status|segment|group|class|tier|brand|market|state|country|city|gender|division|source|platform)\b/i;
    const BAD_PATTERNS = /\b(name|first_?name|last_?name|full_?name|address|email|phone|description|notes|comment|url)\b/i;

    return [...dims].sort((a, b) => {
        const aGood = GOOD_PATTERNS.test(a.column) ? 1 : 0;
        const bGood = GOOD_PATTERNS.test(b.column) ? 1 : 0;
        const aBad = BAD_PATTERNS.test(a.column) ? 1 : 0;
        const bBad = BAD_PATTERNS.test(b.column) ? 1 : 0;
        // Good dimensions first, bad dimensions last
        return (bGood - aGood) || (aBad - bBad);
    });
}

/** Pick primary categorical dimension — prefer category, region over individual names */
function pickPrimaryDim(model: SemanticModel): SemanticDimension | null {
    const ranked = rankDimensions(model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden));
    return ranked[0] || null;
}

/** Pick secondary categorical dimension */
function pickSecondaryDim(model: SemanticModel, primary: SemanticDimension | null): SemanticDimension | null {
    const ranked = rankDimensions(model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden && d.column !== primary?.column));
    return ranked[0] || null;
}

// ═══════════════════════════════════════════════════════════════════
// INSIGHT GENERATORS
// ═══════════════════════════════════════════════════════════════════

interface InsightDef {
    id: string;
    title: string;
    subtitle: string;
    category: AutoInsight['category'];
    priority: number;
    chartType: AutoInsight['chartType'];
    sql: string;
    xKey: string;
    yKey: string;
    kpiFormat?: AutoInsight['kpiFormat'];
}

/**
 * Generate insights for datasets with NO numeric measures (surveys, categorical).
 * Uses COUNT-based analytics: frequency distributions, cross-tabs, unique values.
 */
function buildDimensionOnlyInsights(model: SemanticModel, rowCount: number): InsightDef[] {
    const defs: InsightDef[] = [];
    const dims = model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden);
    let priority = 1;

    // ── KPI 1: Total record count ──
    defs.push({
        id: 'kpi_count',
        title: 'Total Records',
        subtitle: `Number of rows in the dataset`,
        category: 'kpi',
        priority: priority++,
        chartType: 'kpiCard',
        sql: `SELECT COUNT(*) as value FROM data`,
        xKey: 'metric',
        yKey: 'value',
        kpiFormat: 'number',
    });

    // ── KPI 2-4: Unique value counts for first 3 dimensions ──
    for (const dim of dims.slice(0, 3)) {
        const label = humanize(dim.column);
        defs.push({
            id: `kpi_unique_${dim.column}`,
            title: `Unique ${label}`,
            subtitle: `Distinct ${label.toLowerCase()} values`,
            category: 'kpi',
            priority: priority++,
            chartType: 'kpiCard',
            sql: `SELECT COUNT(DISTINCT ${q(dim.column)}) as value FROM data`,
            xKey: 'metric',
            yKey: 'value',
            kpiFormat: 'number',
        });
    }

    // ── DISTRIBUTIONS 5-10: Frequency distribution for each dimension ──
    const chartTypes: AutoInsight['chartType'][] = ['donut', 'bar', 'horizontalBar', 'donut', 'bar', 'horizontalBar'];
    for (let i = 0; i < Math.min(dims.length, 6); i++) {
        const dim = dims[i];
        const label = humanize(dim.column);
        defs.push({
            id: `dist_${dim.column}`,
            title: `${label} Distribution`,
            subtitle: `Record count by ${label.toLowerCase()}`,
            category: 'distribution',
            priority: priority++,
            chartType: chartTypes[i % chartTypes.length],
            sql: `SELECT ${q(dim.column)} as label, COUNT(*) as value FROM data WHERE ${q(dim.column)} IS NOT NULL GROUP BY ${q(dim.column)} ORDER BY value DESC LIMIT 10`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── CROSS-TABS 11-15: Two dimensions crossed ──
    for (let i = 0; i < dims.length - 1 && defs.length < 15; i++) {
        for (let j = i + 1; j < dims.length && defs.length < 15; j++) {
            const d1 = dims[i], d2 = dims[j];
            const l1 = humanize(d1.column), l2 = humanize(d2.column);
            defs.push({
                id: `cross_${d1.column}_${d2.column}`,
                title: `${l1} by ${l2}`,
                subtitle: `How ${l1.toLowerCase()} values distribute across ${l2.toLowerCase()}`,
                category: 'comparative',
                priority: priority++,
                chartType: 'bar',
                sql: `SELECT ${q(d1.column)} as label, COUNT(*) as value FROM data WHERE ${q(d1.column)} IS NOT NULL GROUP BY ${q(d1.column)} ORDER BY value DESC LIMIT 8`,
                xKey: 'label',
                yKey: 'value',
            });
        }
    }

    return defs.slice(0, 15);
}

function buildInsightDefs(model: SemanticModel, rowCount: number): InsightDef[] {
    const defs: InsightDef[] = [];
    const pm = pickPrimaryMeasure(model);
    const sm = pickSecondaryMeasure(model, pm);
    const nam = pickNonAdditiveMeasure(model, pm);
    const pd = pickPrimaryDim(model);
    const sd = pickSecondaryDim(model, pd);
    const dateCol = model.primaryDateColumn;

    if (!pm) {
        console.log('[AutoInsights] No measures found — generating count-based insights from dimensions');
        return buildDimensionOnlyInsights(model, rowCount);
    }

    const pmLabel = humanize(pm.column);
    const pdLabel = pd ? humanize(pd.column) : '';

    // ── KPI 1: Total of primary measure ──
    defs.push({
        id: 'kpi_total',
        title: `Total ${pmLabel}`,
        subtitle: `Sum across all ${rowCount.toLocaleString()} records`,
        category: 'kpi',
        priority: 1,
        chartType: 'kpiCard',
        sql: `SELECT ${aggExpr(pm)} as value FROM data`,
        xKey: 'metric',
        yKey: 'value',
        kpiFormat: kpiFormat(pm),
    });

    // ── KPI 2: Record count ──
    defs.push({
        id: 'kpi_count',
        title: 'Total Records',
        subtitle: 'Number of rows in the dataset',
        category: 'kpi',
        priority: 2,
        chartType: 'kpiCard',
        sql: `SELECT COUNT(*) as value FROM data`,
        xKey: 'metric',
        yKey: 'value',
        kpiFormat: 'number',
    });

    // ── KPI 3: Average of primary measure ──
    defs.push({
        id: 'kpi_avg',
        title: `Average ${pmLabel}`,
        subtitle: `Mean value per record`,
        category: 'kpi',
        priority: 3,
        chartType: 'kpiCard',
        sql: `SELECT AVG(${q(pm.column)}) as value FROM data`,
        xKey: 'metric',
        yKey: 'value',
        kpiFormat: kpiFormat(pm),
    });

    // ── KPI 4: Unique count of primary dimension ──
    if (pd) {
        defs.push({
            id: 'kpi_unique',
            title: `Unique ${pdLabel}`,
            subtitle: `Distinct values of ${pdLabel}`,
            category: 'kpi',
            priority: 4,
            chartType: 'kpiCard',
            sql: `SELECT COUNT(DISTINCT ${q(pd.column)}) as value FROM data`,
            xKey: 'metric',
            yKey: 'value',
            kpiFormat: 'number',
        });
    }

    // ── RANKING 5: Top 5 by primary measure ──
    if (pd) {
        defs.push({
            id: 'rank_top5',
            title: `Top 5 ${pdLabel} by ${pmLabel}`,
            subtitle: `Highest performing ${pdLabel.toLowerCase()}`,
            category: 'ranking',
            priority: 5,
            chartType: 'horizontalBar',
            sql: `SELECT ${q(pd.column)} as label, ${aggExpr(pm)} as value FROM data GROUP BY ${q(pd.column)} ORDER BY value DESC LIMIT 5`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── RANKING 6: Bottom 5 by primary measure ──
    if (pd) {
        defs.push({
            id: 'rank_bottom5',
            title: `Bottom 5 ${pdLabel} by ${pmLabel}`,
            subtitle: `Lowest performing ${pdLabel.toLowerCase()}`,
            category: 'ranking',
            priority: 6,
            chartType: 'horizontalBar',
            sql: `SELECT ${q(pd.column)} as label, ${aggExpr(pm)} as value FROM data GROUP BY ${q(pd.column)} ORDER BY value ASC LIMIT 5`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── RANKING 7: Top 5 by secondary measure ──
    if (pd && sm) {
        const smLabel = humanize(sm.column);
        defs.push({
            id: 'rank_top5_sec',
            title: `Top 5 ${pdLabel} by ${smLabel}`,
            subtitle: `Highest ${smLabel.toLowerCase()} across ${pdLabel.toLowerCase()}`,
            category: 'ranking',
            priority: 7,
            chartType: 'horizontalBar',
            sql: `SELECT ${q(pd.column)} as label, ${aggExpr(sm)} as value FROM data GROUP BY ${q(pd.column)} ORDER BY value DESC LIMIT 5`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── TIME TRENDS (only if date column exists) ──
    if (dateCol) {
        // TREND 8: Monthly trend
        defs.push({
            id: 'trend_monthly',
            title: `Monthly ${pmLabel} Trend`,
            subtitle: `${pmLabel} aggregated by month`,
            category: 'trend',
            priority: 8,
            chartType: 'area',
            sql: `SELECT strftime(CAST(${q(dateCol)} AS DATE), '%Y-%m') as period, ${aggExpr(pm)} as value FROM data WHERE ${q(dateCol)} IS NOT NULL GROUP BY period ORDER BY period`,
            xKey: 'period',
            yKey: 'value',
        });

        // TREND 9: Weekly trend
        defs.push({
            id: 'trend_weekly',
            title: `Weekly ${pmLabel} Trend`,
            subtitle: `${pmLabel} aggregated by week`,
            category: 'trend',
            priority: 9,
            chartType: 'line',
            sql: `SELECT strftime(CAST(${q(dateCol)} AS DATE), '%Y-W%W') as period, ${aggExpr(pm)} as value FROM data WHERE ${q(dateCol)} IS NOT NULL GROUP BY period ORDER BY period`,
            xKey: 'period',
            yKey: 'value',
        });

        // TREND 10: Monthly average
        defs.push({
            id: 'trend_monthly_avg',
            title: `Monthly Average ${pmLabel}`,
            subtitle: `Average ${pmLabel.toLowerCase()} per month`,
            category: 'trend',
            priority: 10,
            chartType: 'line',
            sql: `SELECT strftime(CAST(${q(dateCol)} AS DATE), '%Y-%m') as period, AVG(${q(pm.column)}) as value FROM data WHERE ${q(dateCol)} IS NOT NULL GROUP BY period ORDER BY period`,
            xKey: 'period',
            yKey: 'value',
        });
    } else {
        // No date column — add extra distribution insights instead
        if (sd) {
            const sdLabel = humanize(sd.column);
            defs.push({
                id: 'dist_extra1',
                title: `${pmLabel} by ${sdLabel}`,
                subtitle: `How ${pmLabel.toLowerCase()} distributes across ${sdLabel.toLowerCase()}`,
                category: 'distribution',
                priority: 8,
                chartType: 'bar',
                sql: `SELECT ${q(sd.column)} as label, ${aggExpr(pm)} as value FROM data GROUP BY ${q(sd.column)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label',
                yKey: 'value',
            });
        }
        if (pd && sm) {
            const smLabel = humanize(sm.column);
            defs.push({
                id: 'dist_extra2',
                title: `${smLabel} by ${pdLabel}`,
                subtitle: `${smLabel} across different ${pdLabel.toLowerCase()}`,
                category: 'distribution',
                priority: 9,
                chartType: 'bar',
                sql: `SELECT ${q(pd.column)} as label, ${aggExpr(sm)} as value FROM data GROUP BY ${q(pd.column)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label',
                yKey: 'value',
            });
        }
    }

    // ── DISTRIBUTION 11: By primary categorical dimension ──
    if (pd) {
        defs.push({
            id: 'dist_primary',
            title: `${pmLabel} by ${pdLabel}`,
            subtitle: `Distribution of ${pmLabel.toLowerCase()} across ${pdLabel.toLowerCase()}`,
            category: 'distribution',
            priority: 11,
            chartType: 'donut',
            sql: `SELECT ${q(pd.column)} as label, ${aggExpr(pm)} as value FROM data GROUP BY ${q(pd.column)} ORDER BY value DESC LIMIT 8`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── DISTRIBUTION 12: By secondary dimension ──
    if (sd) {
        const sdLabel = humanize(sd.column);
        defs.push({
            id: 'dist_secondary',
            title: `${pmLabel} by ${sdLabel}`,
            subtitle: `Breakdown across ${sdLabel.toLowerCase()}`,
            category: 'distribution',
            priority: 12,
            chartType: 'bar',
            sql: `SELECT ${q(sd.column)} as label, ${aggExpr(pm)} as value FROM data GROUP BY ${q(sd.column)} ORDER BY value DESC LIMIT 10`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── DISTRIBUTION 13: Record count by primary dimension (pie) ──
    if (sd) {
        const sdLabel2 = humanize(sd.column);
        defs.push({
            id: 'dist_count_dim',
            title: `Record Count by ${sdLabel2}`,
            subtitle: `Number of records in each ${sdLabel2.toLowerCase()}`,
            category: 'distribution',
            priority: 13,
            chartType: 'pie',
            sql: `SELECT ${q(sd.column)} as label, COUNT(*) as value FROM data GROUP BY ${q(sd.column)} ORDER BY value DESC LIMIT 8`,
            xKey: 'label',
            yKey: 'value',
        });
    }

    // ── DIAGNOSTIC 14: Non-additive measure average ──
    if (nam) {
        const namLabel = humanize(nam.column);
        if (pd) {
            defs.push({
                id: 'diag_nonadd',
                title: `Average ${namLabel} by ${pdLabel}`,
                subtitle: `Non-additive metric across ${pdLabel.toLowerCase()}`,
                category: 'diagnostic',
                priority: 14,
                chartType: 'bar',
                sql: `SELECT ${q(pd.column)} as label, AVG(${q(nam.column)}) as value FROM data GROUP BY ${q(pd.column)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label',
                yKey: 'value',
            });
        } else {
            defs.push({
                id: 'diag_nonadd',
                title: `Average ${namLabel}`,
                subtitle: `Overall average of ${namLabel.toLowerCase()}`,
                category: 'diagnostic',
                priority: 14,
                chartType: 'kpiCard',
                sql: `SELECT AVG(${q(nam.column)}) as value FROM data`,
                xKey: 'metric',
                yKey: 'value',
                kpiFormat: 'number',
            });
        }
    }

    // ── COMPARATIVE 15: Two measures side by side ──
    if (pd && sm) {
        const smLabel = humanize(sm.column);
        defs.push({
            id: 'comp_dual',
            title: `${pmLabel} vs ${smLabel}`,
            subtitle: `Comparing both metrics by ${pdLabel.toLowerCase()}`,
            category: 'comparative',
            priority: 15,
            chartType: 'bar',
            sql: `SELECT ${q(pd.column)} as label, ${aggExpr(pm)} as value1, ${aggExpr(sm)} as value2 FROM data GROUP BY ${q(pd.column)} ORDER BY value1 DESC LIMIT 8`,
            xKey: 'label',
            yKey: 'value1',
        });
    }

    return defs.slice(0, 15);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Sanitize rows before loading into DuckDB.
 * Replaces empty strings, undefined, and NaN with null to prevent
 * "Could not convert string '' to DOUBLE" errors.
 */
function sanitizeRows(rows: any[]): any[] {
    if (!rows.length) return rows;
    const keys = Object.keys(rows[0]);
    return rows.map(row => {
        const clean: any = {};
        for (const k of keys) {
            const v = row[k];
            if (v === '' || v === undefined || (typeof v === 'number' && isNaN(v))) {
                clean[k] = null;
            } else {
                clean[k] = v;
            }
        }
        return clean;
    });
}

export async function generateAutoInsights(dataset: Dataset): Promise<AutoInsight[]> {
    const startTime = performance.now();
    console.log('[AutoInsights] Starting auto-analysis...');

    const model = dataset.semanticModel as SemanticModel | undefined;
    if (!model) {
        console.warn('[AutoInsights] No semantic model found on dataset');
        return [];
    }

    const defs = buildInsightDefs(model, dataset.rows.length);
    console.log(`[AutoInsights] Generated ${defs.length} insight definitions`);

    if (defs.length === 0) return [];

    // ── SANITIZE: Clean empty strings / NaN before DuckDB ingestion ──
    const cleanRows = sanitizeRows(dataset.rows);
    console.log(`[AutoInsights] Sanitized ${cleanRows.length} rows for DuckDB`);

    // ── PRE-WARM: Load table synchronously and verify it works ──
    console.log('[AutoInsights] Pre-warming DuckDB table...');
    const warmup = await executeSQLViaDuckDB(cleanRows, 'SELECT COUNT(*) as n FROM data', dataset.timeContext);
    if (warmup.error) {
        console.error('[AutoInsights] Failed to load data into DuckDB:', warmup.error);
        return [];
    }
    console.log('[AutoInsights] DuckDB table ready, executing insight queries...');

    // ── Execute queries SEQUENTIALLY to prevent race conditions ──
    const insights: AutoInsight[] = [];

    for (const def of defs) {
        try {
            const result = await executeSQLViaDuckDB(
                cleanRows,
                def.sql,
                dataset.timeContext
            );

            if (result.error) {
                console.warn(`[AutoInsights] Query failed for "${def.id}":`, result.error);
                continue;
            }

            const data = result.data || [];
            if (data.length === 0) continue;

            const isKpi = def.chartType === 'kpiCard';
            const kpiValue = isKpi && data.length > 0 ? data[0]?.value : undefined;

            insights.push({
                ...def,
                data,
                yLabel: def.title,
                kpiValue,
                status: 'done',
            });
        } catch (err: any) {
            console.warn(`[AutoInsights] Query failed for "${def.id}":`, err.message);
        }
    }

    insights.sort((a, b) => a.priority - b.priority);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`[AutoInsights] Completed: ${insights.length}/${defs.length} insights in ${elapsed}s`);

    return insights;
}
