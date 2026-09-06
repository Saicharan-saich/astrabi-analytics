import type { AnalysisResult, DashboardItem, Dataset } from '../types';
import { sanitizeDashboard, dashboardRecipeKey } from '../shared/dashboardPrivacy.mjs';
import { validateReadOnlySQL } from './ai-sql/sqlSafety';

/** Keep complete local answers when the cloud recipe is unchanged. */
export function restoreDashboardItems(cloudItems: DashboardItem[], localItems: DashboardItem[]): DashboardItem[] {
    const safeItems = sanitizeDashboard({ items: cloudItems }).items as DashboardItem[];
    return safeItems.map(item => {
        const local = localItems.find(candidate => candidate.id === item.id
            && candidate.result.needsLocalData !== true
            && dashboardRecipeKey(candidate) === dashboardRecipeKey(item));
        if (!local) return item;
        const cached = local.result;
        return {
            ...item,
            result: {
                ...item.result, data: cached.data, kpi: cached.kpi, growth: cached.growth,
                insight: cached.insight, validation: cached.validation, confidence: cached.confidence,
                warnings: cached.warnings, explainability: cached.explainability, needsLocalData: false,
            },
        };
    });
}

/** Execute a saved card locally; never ask the LLM to recreate its query. */
export async function rebuildDashboardItem(item: DashboardItem, dataset: Dataset): Promise<DashboardItem> {
    const previous = item.result;
    let fresh: AnalysisResult;
    if (previous.aiSqlRefresh || previous.queryConfig?.aiSql) {
        const sql = previous.aiSqlRefresh?.sql || previous.queryConfig.aiSql;
        const safe = validateReadOnlySQL(sql);
        if (!safe.ok) throw new Error(safe.reason);
        const { refreshPinnedAISQLResult } = await import('./ai-sql/pinnedResult');
        fresh = await refreshPinnedAISQLResult(dataset, previous);
    } else if (!previous.queryConfig && previous.sql) {
        // Auto-built dashboards already store executable SQL and chart-shaped
        // column names. Their insight IDs are not Question Builder registry IDs.
        const safe = validateReadOnlySQL(previous.sql);
        if (!safe.ok) throw new Error(safe.reason);
        const { executeSQLViaDuckDB } = await import('./duckdbEngine');
        const { sanitizeRows } = await import('./autoInsightsEngine');
        const execution = await executeSQLViaDuckDB(
            sanitizeRows(dataset.rows), safe.sql, dataset.timeContext, dataset.relatedTables,
        );
        if (execution.error) throw new Error(execution.error);
        fresh = {
            ...previous, data: execution.data, insight: '',
            kpi: previous.vis === 'kpiCard' || previous.vis === 'kpi'
                ? execution.data[0]?.[previous.yKey] : undefined,
        };
    } else {
        const config = previous.queryConfig || previous.config;
        if (!config?.questionId) throw new Error('This visual needs its original analysis to be pinned again.');
        const { runAnalysis } = await import('./analysisEngine');
        fresh = await runAnalysis(dataset, {
            ...config, asOfDate: dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || '',
        });
        if (fresh.error) throw new Error(fresh.error);
        fresh = { ...fresh, vis: previous.vis || fresh.vis, formatting: previous.formatting, queryConfig: config };
    }
    return {
        ...item, result: { ...fresh, needsLocalData: false },
        datasetId: dataset.id, datasetName: dataset.name, datasetVersion: dataset.version, pinnedAt: Date.now(),
    };
}
