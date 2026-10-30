import type { Dataset, DashboardDefinition, DashboardItem } from '../types';
import { resolveDashboardFilterSource } from './dashboardFilterSource';

/**
 * Can this visual be shown right now?
 *  - Yes when its source dataset is loaded (it can be recomputed and filtered).
 *  - Otherwise only when it carries its own stored result AND no dashboard
 *    filter needs the source rows. Cards restored from the cloud
 *    (`needsLocalData`) never carry rows, so they need their dataset.
 */
export function isItemPresentable(
    item: DashboardItem,
    current: Dataset | undefined,
    datasets: Dataset[],
    dashboardFilterCount: number,
): boolean {
    if (resolveDashboardFilterSource(item, current, datasets)) return true;
    if (item.result?.needsLocalData) return false;
    if (dashboardFilterCount > 0 && !item.ignoreGlobalFilter) return false;
    return Array.isArray(item.result?.data) && item.result.data.length > 0;
}

export interface DashboardReadiness {
    id: string;
    name: string;
    total: number;
    ready: number;
    /** Names of datasets that would need loading to show the rest. */
    missingDatasets: string[];
}

export function summariseDashboardReadiness(
    dashboard: DashboardDefinition,
    current: Dataset | undefined,
    datasets: Dataset[],
): DashboardReadiness {
    const filterCount = Array.isArray(dashboard.filters) ? dashboard.filters.length : 0;
    let ready = 0;
    const missing = new Set<string>();
    for (const item of dashboard.items || []) {
        if (isItemPresentable(item, current, datasets, filterCount)) ready += 1;
        else missing.add(item.datasetName || 'an unloaded dataset');
    }
    return { id: dashboard.id, name: dashboard.name, total: (dashboard.items || []).length, ready, missingDatasets: [...missing] };
}
