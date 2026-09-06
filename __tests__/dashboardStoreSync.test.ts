import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, syncDashboardsFromCloud, resetUserData } from '../store/useAppStore';
import { fetchCloudDashboards } from '../services/dashboardCloudSync';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
import { dashboardFixture } from './helpers/dashboardFixture';

vi.mock('../services/dashboardCloudSync', async importOriginal => ({
    ...await importOriginal<any>(),
    fetchCloudDashboards: vi.fn(),
}));
let storage: Map<string, string>;
beforeEach(() => {
    storage = new Map([['qi_token', 'alice-token']]);
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) || null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    });
    resetUserData();
    vi.mocked(fetchCloudDashboards).mockReset();
});
afterEach(() => { resetUserData(); vi.unstubAllGlobals(); });

describe('dashboard store cloud restoration', () => {
    it('preserves local results and retires the old deletion flag without deleting dashboards', async () => {
        const local = { ...dashboardFixture(), createdAt: 1 };
        useAppStore.setState({
            dashboards: [local], activeDashboardId: local.id, items: local.items, resetLegacyDashboards: true,
        });
        vi.mocked(fetchCloudDashboards).mockResolvedValue([sanitizeDashboard(local) as any]);
        await syncDashboardsFromCloud();
        expect(useAppStore.getState().dashboards).toHaveLength(1);
        expect(useAppStore.getState().items[0].result.data).toHaveLength(175);
        expect(useAppStore.getState().resetLegacyDashboards).toBe(false);
    });
    it('does not restore a previous account when an in-flight pull finishes late', async () => {
        let finish: (rows: any[]) => void = () => {};
        vi.mocked(fetchCloudDashboards).mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const pending = syncDashboardsFromCloud();
        resetUserData();
        storage.set('qi_token', 'bob-token');
        finish([sanitizeDashboard(dashboardFixture()) as any]);
        await pending;
        expect(useAppStore.getState().dashboards).toEqual([]);
        expect(useAppStore.getState().items).toEqual([]);
    });
});
