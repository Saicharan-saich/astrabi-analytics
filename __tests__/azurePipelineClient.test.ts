import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickCleaned, runThroughPipeline, type AzurePipeline } from '../services/azurePipeline';

const T = Date.UTC(2026, 10, 22, 13, 0, 0);
const pipeline: AzurePipeline = { id: 'pl_abcdefgh', name: 'Acme Ltd', account: 'acmedata', container: 'sales', incoming: 'incoming/', cleaned: 'cleaned/', routeUploads: true };

describe('finding the cleaned file that came from an upload', () => {
    const files = [
        { path: 'cleaned/orders_oct.csv', name: 'orders_oct.csv', size: 1, modified: T - 86_400_000 },
        { path: 'cleaned/clean_Orders_Nov.csv', name: 'clean_Orders_Nov.csv', size: 1, modified: T + 120_000 },
        { path: 'cleaned/other.csv', name: 'other.csv', size: 1, modified: T + 130_000 },
    ];
    it('prefers a new file whose name holds the upload\'s name', () => {
        expect(pickCleaned(files, 'Orders Nov.csv', T)?.name).toBe('clean_Orders_Nov.csv');
    });
    it('takes the only new file when names differ, and waits when it cannot tell', () => {
        expect(pickCleaned(files.slice(0, 2), 'export.csv', T)?.name).toBe('clean_Orders_Nov.csv');
        expect(pickCleaned(files, 'export.csv', T)).toBeNull();
        expect(pickCleaned(files.slice(0, 1), 'orders_oct.csv', T)).toBeNull();
    });
});

describe('sending an upload through the pipeline', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('sends the file straight to Azure, waits for the cleaned file, and reads it from Azure', async () => {
        const calls: string[] = [];
        let polls = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
            const method = init.method || 'GET';
            calls.push(`${method} ${url.replace(/\?.*/, '')}`);
            const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
            if (url.endsWith('/upload-link')) return json({ url: 'https://acmedata.blob.core.windows.net/sales/incoming/x-orders.csv?sig=w', path: 'incoming/x-orders.csv', startedAt: T });
            if (url.startsWith('https://acmedata.blob.core.windows.net/sales/incoming/')) {
                expect((init.headers as any)['x-ms-blob-type']).toBe('BlockBlob');
                return { ok: true, status: 201 };
            }
            if (url.endsWith('/files')) return json({ files: ++polls < 2 ? [] : [{ path: 'cleaned/orders.csv', name: 'orders.csv', size: 20, modified: T + 60_000 }] });
            if (url.endsWith('/download-link')) return json({ url: 'https://acmedata.blob.core.windows.net/sales/cleaned/orders.csv?sig=r' });
            if (url.startsWith('https://acmedata.blob.core.windows.net/sales/cleaned/')) return { ok: true, status: 200, blob: async () => new Blob(['order_id,revenue\n1,10\n'], { type: 'text/csv' }) };
            throw new Error(`unexpected ${url}`);
        }));
        const stages: string[] = [];
        const file = new File(['Order ID,Revenue\n1,"10"\n'], 'orders.csv', { type: 'text/csv' });
        const cleaned = await runThroughPipeline(pipeline, file, p => stages.push(p.stage), { sleep: async () => {}, pollMs: 1 });
        expect(cleaned.name).toBe('orders.csv');
        expect(await cleaned.text()).toBe('order_id,revenue\n1,10\n');
        expect([...new Set(stages)]).toEqual(['sending', 'waiting', 'opening']);
        // The data went only to and from Azure; the server only gave out links.
        const toServer = calls.filter(c => !c.includes('blob.core.windows.net'));
        expect(toServer.every(c => /\/azure-pipelines\/pl_abcdefgh\/(upload-link|files|download-link)$/.test(c))).toBe(true);
    });

    it('says plainly when the browser cannot reach Azure (CORS not set up)', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/upload-link')) return { ok: true, status: 200, json: async () => ({ url: 'https://acmedata.blob.core.windows.net/sales/incoming/x.csv?sig=w', path: 'incoming/x.csv', startedAt: T }) };
            throw new TypeError('Failed to fetch');
        }));
        await expect(runThroughPipeline(pipeline, new File(['a'], 'x.csv'), () => {}, { sleep: async () => {} })).rejects.toThrow(/must allow this website \(CORS\)/);
    });

    it('gives up after the time limit with a pointer to Cleaned files', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url.endsWith('/upload-link')) return { ok: true, status: 200, json: async () => ({ url: 'https://a.blob.core.windows.net/c/incoming/x.csv', path: 'incoming/x.csv', startedAt: Date.now() }) };
            if (url.includes('blob.core.windows.net')) return { ok: true, status: 201 };
            return { ok: true, status: 200, json: async () => ({ files: [] }) };
        }));
        await expect(runThroughPipeline(pipeline, new File(['a'], 'x.csv'), () => {}, { sleep: () => new Promise(r => setTimeout(r, 5)), timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/show under Cleaned files/);
    });
});
