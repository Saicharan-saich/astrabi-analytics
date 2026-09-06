import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    saveCloudDashboard, fetchCloudDashboards, pushDashboardToCloud,
    cancelDashboardSync, getDashboardSession, getPendingPushCount, deleteCloudDashboard,
} from '../services/dashboardCloudSync';
import { dashboardFixture } from './helpers/dashboardFixture';

const token = (id: string) => 'header.' + btoa(JSON.stringify({ userId: id })) + '.signature';
let storage: Map<string, string>;
beforeEach(() => {
    storage = new Map([['qi_token', token('alice')]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) || null, setItem: (k: string, v: string) => storage.set(k, v) });
    cancelDashboardSync();
});
afterEach(() => { cancelDashboardSync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dashboard transport privacy and session isolation', () => {
    it('orders a delete after an in-flight save so the save cannot recreate the deleted dashboard', async () => {
        let finishSave: (response: any) => void = () => {};
        const fetcher = vi.fn()
            .mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }))
            .mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetcher);
        const saving = saveCloudDashboard(dashboardFixture());
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const deleting = deleteCloudDashboard('dashboard-a');
        expect(fetcher).toHaveBeenCalledTimes(1);
        finishSave({ ok: true });
        await saving;
        expect(await deleting).toBe(true);
        expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
    });
    it('sends no chart rows or derived outputs in the actual request body', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetcher);
        expect(await saveCloudDashboard(dashboardFixture())).toBe(true);
        const init = fetcher.mock.calls[0][1];
        expect(init.headers.Authorization).toBe('Bearer ' + token('alice'));
        expect(init.body).not.toContain('PRIVATE_');
        expect(JSON.parse(init.body).items[0].result.data).toEqual([]);
    });
    it('does not queue unauthenticated data or send a captured old session after login changes', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const oldSession = getDashboardSession();
        storage.delete('qi_token');
        expect(await saveCloudDashboard(dashboardFixture())).toBe(false);
        expect(getPendingPushCount()).toBe(0);
        storage.set('qi_token', token('bob'));
        expect(await saveCloudDashboard(dashboardFixture(), oldSession)).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('cancels retries after an account switch and never replays Alice data as Bob', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
        vi.stubGlobal('fetch', fetcher);
        const pending = saveCloudDashboard(dashboardFixture());
        await vi.advanceTimersByTimeAsync(1);
        cancelDashboardSync();
        storage.set('qi_token', token('bob'));
        await vi.runAllTimersAsync();
        expect(await pending).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(getPendingPushCount()).toBe(0);
        fetcher.mockResolvedValue({ ok: true });
        await saveCloudDashboard({ ...dashboardFixture(), id: 'bob-card' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('ignores a cloud response that finishes after the user changes', async () => {
        let bodyRequested = false;
        let resolveBody: (body: any) => void = () => {};
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(r => { bodyRequested = true; resolveBody = r; }) }));
        const pending = fetchCloudDashboards();
        await vi.waitFor(() => expect(bodyRequested).toBe(true));
        storage.set('qi_token', token('bob'));
        resolveBody({ dashboards: [dashboardFixture()] });
        expect(await pending).toEqual([]);
    });
    it('uses different legacy default IDs for different users', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetcher);
        const input = { ...dashboardFixture(), id: 'default' };
        await pushDashboardToCloud(input);
        cancelDashboardSync();
        storage.set('qi_token', token('bob'));
        await pushDashboardToCloud(input);
        expect(JSON.parse(fetcher.mock.calls[0][1].body).id).toBe('default-alice');
        expect(JSON.parse(fetcher.mock.calls[1][1].body).id).toBe('default-bob');
    });
});
