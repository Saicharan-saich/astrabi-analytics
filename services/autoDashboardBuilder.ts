/**
 * Auto-Dashboard Builder
 * ──────────────────────
 * Turns the auto-generated insights into a ready-to-use dashboard with zero
 * manual pinning. Powers the "do very little, get a lot" journey:
 *   - auto-built on the first upload, and
 *   - one-click "Build / Rebuild" everywhere after.
 *
 * It reuses the existing autoInsightsEngine (chart-ready AutoInsights) and the
 * dashboard store actions — it invents no new analysis.
 */

import { Dataset, AnalysisResult, DashboardItem, FormattingConfig } from '../types';
import { generateAutoInsights } from './autoInsightsEngine';
import { useAppStore } from '../store/useAppStore';

/** Max cards on an auto-built dashboard — enough to be rich, not overwhelming. */
const MAX_CARDS = 12;
/** Cap on KPI tiles so the top row stays scannable. */
const MAX_KPIS = 4;

function genId(): string {
    return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Is an insight worth putting on the dashboard? */
function isUsable(i: { chartType: string; status: string; data: any[]; kpiValue?: any }): boolean {
    if (i.status === 'error') return false;
    if (i.chartType === 'kpiCard') return i.kpiValue !== undefined && i.kpiValue !== null;
    return Array.isArray(i.data) && i.data.length > 0;
}

export interface AutoDashboardResult {
    dashboardId: string;
    count: number;
}

/**
 * Generate insights for the dataset and assemble them into a fresh dashboard.
 * Returns the new dashboard id and how many cards were added (0 if none).
 */
export async function buildAutoDashboard(
    dataset: Dataset,
    opts?: { name?: string; onProgress?: (msg: string) => void }
): Promise<AutoDashboardResult> {
    opts?.onProgress?.('Analyzing your data…');
    const insights = await generateAutoInsights(dataset);

    const usable = insights
        .filter(isUsable)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    // Keep KPI tiles up top (capped) then the highest-priority charts.
    const kpis = usable.filter(i => i.chartType === 'kpiCard').slice(0, MAX_KPIS);
    // Dedupe charts: two cards showing the same metric × dimension × chart type
    // (e.g. two identical "SUM of sales by ship_mode") is the #1 thing that makes
    // an auto-dashboard look broken. Keep the first (highest-priority) of each.
    const seen = new Set<string>();
    const charts = usable.filter(i => i.chartType !== 'kpiCard').filter(i => {
        const cfg: any = i.config || {};
        const sig = [
            i.chartType,
            (cfg.metric || i.yKey || '').toString().toLowerCase(),
            (cfg.dimension || i.xKey || '').toString().toLowerCase(),
            (cfg.aggregation || '').toString().toLowerCase(),
            (i.title || '').toString().toLowerCase().trim(),
        ].join('|');
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    });
    const chosen = [...kpis, ...charts].slice(0, MAX_CARDS);

    opts?.onProgress?.('Building your dashboard…');

    const store = useAppStore.getState();
    const dashName = opts?.name || `${dataset.name || 'Dataset'} — Overview`;
    const dashboardId = store.createDashboard(dashName);

    let chartIndex = 0;
    for (const insight of chosen) {
        // Per-card formatting: only label charts that stay readable. Dense
        // time-series (line/area) and many-bar charts get NO per-point labels;
        // small bars / donuts keep them. This is what stops the "brainless",
        // label-smothered visuals.
        const pointCount = Array.isArray(insight.data) ? insight.data.length : 0;
        const isBar = insight.chartType === 'bar' || insight.chartType === 'horizontalBar';
        const showLabels = insight.chartType === 'donut' || insight.chartType === 'pie'
            || (isBar && pointCount <= 8);
        const formatting: FormattingConfig = {
            colorMode: 'vibrant',
            numberFormat: insight.kpiFormat === 'currency_usd' ? 'currency_usd'
                : insight.kpiFormat === 'percent' ? 'percent' : 'auto',
            fontSize: 'md',
            headerSize: 'md',
            headerBold: true,
            showLabels: true,
            showDataLabels: showLabels,
            dataLabelMode: showLabels ? 'primary' : 'off',
            tableCalculations: [],
        };

        const result: AnalysisResult = {
            data: insight.data,
            xKey: insight.xKey,
            yKey: insight.yKey,
            yLabel: insight.title,
            insight: insight.subtitle,
            sql: insight.sql,
            // Real config so the card opens/edits in the Question Builder.
            config: { ...(insight.config || {}), questionId: insight.id, questionLabel: insight.title } as any,
            vis: insight.chartType as any,
            kpi: insight.kpiValue,
            formatting,
        };

        // KPIs are half-width tiles; give the first couple of charts full width
        // as "hero" rows, the rest half so they pair up neatly.
        let width: 'full' | 'half' = 'half';
        if (insight.chartType !== 'kpiCard') {
            width = chartIndex < 2 ? 'full' : 'half';
            chartIndex++;
        }

        const item: DashboardItem = {
            id: genId(),
            title: insight.title,
            result,
            width,
            datasetVersion: dataset.version,
            datasetId: dataset.id,
            datasetName: dataset.name,
        };
        store.addItemToDashboard(dashboardId, item);
    }

    store.setActiveDashboard(dashboardId);
    return { dashboardId, count: chosen.length };
}
