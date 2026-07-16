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

import { Dataset, AnalysisResult, DashboardItem } from '../types';
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
    const charts = usable.filter(i => i.chartType !== 'kpiCard');
    const chosen = [...kpis, ...charts].slice(0, MAX_CARDS);

    opts?.onProgress?.('Building your dashboard…');

    const store = useAppStore.getState();
    const dashName = opts?.name || `${dataset.name || 'Dataset'} — Overview`;
    const dashboardId = store.createDashboard(dashName);

    let chartIndex = 0;
    for (const insight of chosen) {
        const result: AnalysisResult = {
            data: insight.data,
            xKey: insight.xKey,
            yKey: insight.yKey,
            yLabel: insight.title,
            insight: insight.subtitle,
            sql: insight.sql,
            config: { questionId: insight.id, questionLabel: insight.title } as any,
            vis: insight.chartType as any,
            kpi: insight.kpiValue,
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
