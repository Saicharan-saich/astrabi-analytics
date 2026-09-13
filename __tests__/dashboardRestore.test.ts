import { describe, expect, it } from 'vitest';
import { restoreDashboardItems, rebuildDashboardItem } from '../services/dashboardRestore';
import { ColumnType } from '../types';
// Load the large, lazily imported engine outside the timed test body.
import '../services/analysisEngine';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
import { dashboardFixture } from './helpers/dashboardFixture';

describe('restoring dashboards without cloud result rows', () => {
    it('keeps all 175 local rows plus KPI values while accepting cloud formatting changes', () => {
        const local = dashboardFixture().items;
        const cloud = sanitizeDashboard(dashboardFixture()).items;
        cloud[0].result.formatting.decimals = 0;
        const restored = restoreDashboardItems(cloud, local);
        expect(restored[0].result.data).toHaveLength(175);
        expect(restored[0].result.kpi).toBe(998877);
        expect(restored[0].result.formatting?.decimals).toBe(0);
        expect(restored[0].result.needsLocalData).toBe(false);
    });
    it('marks a new-device restore for local rebuilding without trusting legacy cloud data', () => {
        const restored = restoreDashboardItems(dashboardFixture().items, []);
        expect(restored[0].result.data).toEqual([]);
        expect(restored[0].result.kpi).toBeUndefined();
        expect(restored[0].result.needsLocalData).toBe(true);
    });
    it('does not reuse a cache after the dataset or query changes', () => {
        const local = dashboardFixture().items;
        const cloud = dashboardFixture().items;
        cloud[0].result.queryConfig.aggregation = 'AVG';
        expect(restoreDashboardItems(cloud, local)[0].result.needsLocalData).toBe(true);
        cloud[0].datasetId = 'different-source';
        expect(restoreDashboardItems(cloud, local)[0].result.data).toEqual([]);
        const changedSql = dashboardFixture().items;
        changedSql[0].result.sql = 'SELECT region, AVG(sales) AS sales FROM data GROUP BY region';
        expect(restoreDashboardItems(changedSql, local)[0].result.needsLocalData).toBe(true);
    });
    it('rebuilds a cloud-only builder card from the full local dataset', async () => {
        const input = dashboardFixture();
        input.items[0].result.visualizationMode = 'grid';
        const card = sanitizeDashboard(input).items[0];
        expect(card.result.visualizationMode).toBe('grid');
        const rows = [
            { region: 'North', sales: 10 }, { region: 'North', sales: 20 }, { region: 'South', sales: 40 },
        ];
        const restored = await rebuildDashboardItem(card, {
            id: 'sales-data', name: 'Sales.csv', rows, totalRows: rows.length, etlLogs: [],
            columns: [{ name: 'region', type: ColumnType.DIMENSION, originalType: 'string' },
                { name: 'sales', type: ColumnType.METRIC, originalType: 'number' }],
        });
        const result = restored.result;
        expect(result.needsLocalData).toBe(false);
        const north = result.data.find(row => row[result.xKey] === 'North');
        expect(north[result.yKey]).toBe(30);
        expect(result.vis).toBe('bar');
        expect(result.visualizationMode).toBe('grid');
        expect(result.formatting).toEqual(input.items[0].result.formatting);
    });
});
