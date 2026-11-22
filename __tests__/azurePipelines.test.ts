/**
 * Azure data pipelines: the access key stays encrypted on the server, the
 * browser gets narrow short-lived links, and only the right accounts get them.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

const az = require('../backend/azurePipelines.js');
const KEY = Buffer.alloc(64, 7).toString('base64');
const NOW = Date.UTC(2026, 10, 22, 13, 15, 1);

describe('short-lived Azure links', () => {
    it('signs a blob link in the service SAS format (version 2020-12-06 and later)', () => {
        const sas = az.serviceSas({ account: 'acmedata', container: 'sales', blob: 'incoming/a b.csv', permissions: 'cw', accountKey: KEY, now: NOW, ttlMs: 15 * 60_000 });
        expect(sas.stringToSign.split('\n')).toEqual([
            'cw', '2026-11-22T13:10:01Z', '2026-11-22T13:30:01Z', '/blob/acmedata/sales/incoming/a b.csv',
            '', '', 'https', '2022-11-02', 'b', '', '', '', '', '', '', '',
        ]);
        const q = new URLSearchParams(sas.query);
        expect(Object.fromEntries(q)).toMatchObject({ sv: '2022-11-02', spr: 'https', sr: 'b', sp: 'cw', st: '2026-11-22T13:10:01Z', se: '2026-11-22T13:30:01Z' });
        const expected = crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(sas.stringToSign, 'utf8').digest('base64');
        expect(q.get('sig')).toBe(expected);
        const container = az.serviceSas({ account: 'acmedata', container: 'sales', permissions: 'l', accountKey: KEY, now: NOW, ttlMs: 60_000 });
        expect(container.stringToSign.split('\n')[3]).toBe('/blob/acmedata/sales');
        expect(new URLSearchParams(container.query).get('sr')).toBe('c');
    });

    it('keeps the access key encrypted, readable only with the server key', () => {
        const key = az.keyFrom({ JWT_SECRET: 'x' });
        const sealed = az.sealSecret(KEY, key);
        expect(sealed).not.toContain(KEY);
        expect(az.openSecret(sealed, key)).toBe(KEY);
        expect(() => az.openSecret(sealed, az.keyFrom({ JWT_SECRET: 'y' }))).toThrow();
        expect(az.keyFrom({ QI_SECRETS_KEY: 'ab'.repeat(32) })).toEqual(Buffer.from('ab'.repeat(32), 'hex'));
    });
});

describe('what an admin types', () => {
    const ok = { name: 'Acme Ltd', account: 'AcmeData', container: 'sales', incoming: 'incoming', cleaned: '/cleaned/', key: KEY };
    it('accepts a sensible pipeline and tidies the folders', () => {
        expect(az.cleanPipeline(ok).value).toMatchObject({ account: 'acmedata', incoming: 'incoming/', cleaned: 'cleaned/', routeUploads: true });
    });
    it('refuses bad names, overlapping folders and keys that are not keys', () => {
        expect(az.cleanPipeline({ ...ok, account: 'acme-data' }).error).toMatch(/storage account name/);
        expect(az.cleanPipeline({ ...ok, container: 'Sales' === 'x' ? '' : 'a' }).error).toMatch(/container name/);
        expect(az.cleanPipeline({ ...ok, cleaned: 'incoming/cleaned' }).error).toMatch(/must be separate/);
        expect(az.cleanPipeline({ ...ok, incoming: '../x' }).error).toMatch(/Folders are paths/);
        expect(az.cleanPipeline({ ...ok, key: 'hunter2' }).error).toMatch(/access key/);
        expect(az.cleanPipeline({ ...ok, key: '' }, { requireKey: false }).value?.key).toBe('');
    });
    it('names uploads safely inside the incoming folder', () => {
        expect(az.incomingName('incoming/', '../../Orders Nov (final).csv', NOW)).toBe('incoming/20261122-131501-Orders_Nov_final.csv');
    });
    it('reads names, sizes and dates from the blob list, skipping folders', () => {
        const xml = `<EnumerationResults><Blobs><Blob><Name>cleaned/a&amp;b.csv</Name><Properties><Last-Modified>Sun, 22 Nov 2026 13:20:00 GMT</Last-Modified><Content-Length>2048</Content-Length></Properties></Blob><Blob><Name>cleaned/</Name><Properties><Content-Length>0</Content-Length></Properties></Blob></Blobs></EnumerationResults>`;
        expect(az.parseBlobList(xml)).toEqual([{ path: 'cleaned/a&b.csv', name: 'a&b.csv', size: 2048, modified: Date.UTC(2026, 10, 22, 13, 20) }]);
        expect(az.azureProblem(403, '<Code>AuthenticationFailed</Code>')).toMatch(/did not accept the access key/);
    });
});

/** Just enough of Postgres for the pipeline service. */
function fakePool() {
    const pipelines: any[] = []; const users: any[] = []; const people = ['eng', 'client', 'other'];
    return {
        pipelines, users,
        async query(sql: string, p: any[] = []) {
            if (/^\s*CREATE/.test(sql)) return { rows: [] };
            if (sql.includes('INSERT INTO azure_pipelines')) { pipelines.push({ id: p[0], owner_id: p[1], name: p[2], account: p[3], container: p[4], incoming_prefix: p[5], cleaned_prefix: p[6], route_uploads: p[7], secret: p[8] }); return { rows: [] }; }
            if (sql.includes('SELECT COUNT(*)::int AS n FROM azure_pipelines')) return { rows: [{ n: pipelines.filter(x => x.owner_id === p[0]).length }] };
            if (sql.includes('SELECT p.* FROM azure_pipelines p\n            WHERE p.id = $1')) return { rows: pipelines.filter(x => x.id === p[0] && (x.owner_id === p[1] || users.some(u => u.pipeline_id === x.id && u.user_id === p[1]))) };
            if (sql.includes('SELECT id FROM users')) return { rows: people.filter(x => p[0].includes(x)).map(id => ({ id })) };
            if (sql.includes('DELETE FROM azure_pipeline_users')) { for (let i = users.length - 1; i >= 0; i--) if (users[i].pipeline_id === p[0]) users.splice(i, 1); return { rows: [] }; }
            if (sql.includes('INSERT INTO azure_pipeline_users')) { users.push({ pipeline_id: p[0], user_id: p[1] }); return { rows: [] }; }
            if (sql.includes('SELECT * FROM azure_pipelines WHERE owner_id')) return { rows: pipelines.filter(x => x.owner_id === p[0]) };
            if (sql.includes('SELECT pipeline_id, user_id FROM azure_pipeline_users')) return { rows: users.filter(u => p[0].includes(u.pipeline_id)) };
            if (sql.includes('JOIN azure_pipeline_users u')) return { rows: pipelines.filter(x => users.some(u => u.pipeline_id === x.id && u.user_id === p[0])) };
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

describe('the pipeline service', () => {
    const admin = { userId: 'eng', role: 'admin' };
    const client = { userId: 'client', role: 'contributor' };
    const stranger = { userId: 'other', role: 'contributor' };
    const listing = `<EnumerationResults><Blobs>
        <Blob><Name>cleaned/orders_nov.csv</Name><Properties><Last-Modified>Sun, 22 Nov 2026 13:20:00 GMT</Last-Modified><Content-Length>900</Content-Length></Properties></Blob>
        <Blob><Name>cleaned/_SUCCESS</Name><Properties><Last-Modified>Sun, 22 Nov 2026 13:20:00 GMT</Last-Modified><Content-Length>0</Content-Length></Properties></Blob>
        <Blob><Name>cleaned/orders_oct.xlsx</Name><Properties><Last-Modified>Sat, 21 Nov 2026 09:00:00 GMT</Last-Modified><Content-Length>800</Content-Length></Properties></Blob>
    </Blobs></EnumerationResults>`;

    async function setUp(fetchImpl: any = async () => ({ ok: true, status: 200, text: async () => listing })) {
        const pool = fakePool();
        const service = az.createAzurePipelineService({ getPool: () => pool, fetchImpl, secretKey: az.keyFrom({ JWT_SECRET: 't' }), now: () => NOW });
        const made = await service.create(admin, { name: 'Acme Ltd', account: 'acmedata', container: 'sales', incoming: 'incoming/', cleaned: 'cleaned/', key: KEY });
        expect(made.status).toBe(200);
        const id = made.body.pipeline.id;
        return { pool, service, id };
    }

    it('never stores or returns the key in the clear', async () => {
        const { pool, service } = await setUp();
        expect(pool.pipelines[0].secret).not.toContain(KEY);
        expect(JSON.stringify(await service.list(admin))).not.toContain(KEY);
    });

    it('gives the client only what it was shared, and narrow links', async () => {
        const { service, id } = await setUp();
        expect((await service.files(client, id)).status).toBe(404);
        expect((await service.setUsers(admin, id, ['client'])).body.userIds).toEqual(['client']);
        expect((await service.list(client)).pipelines.map((p: any) => p.name)).toEqual(['Acme Ltd']);
        expect((await service.list(client)).pipelines[0]).not.toHaveProperty('userIds');
        expect((await service.files(stranger, id)).status).toBe(404);

        const files = await service.files(client, id);
        expect(files.body.files.map((f: any) => f.name)).toEqual(['orders_nov.csv', 'orders_oct.xlsx']);

        const up = await service.uploadLink(client, id, 'Orders Nov.csv');
        expect(up.body.path).toBe('incoming/20261122-131501-Orders_Nov.csv');
        expect(new URL(up.body.url).searchParams.get('sp')).toBe('cw');
        expect(new URL(up.body.url).hostname).toBe('acmedata.blob.core.windows.net');
        expect((await service.uploadLink(client, id, 'notes.pdf')).status).toBe(400);

        const down = await service.downloadLink(client, id, 'cleaned/orders_nov.csv');
        expect(new URL(down.body.url).searchParams.get('sp')).toBe('r');
        expect((await service.downloadLink(client, id, 'incoming/raw.csv')).status).toBe(400);
        expect((await service.downloadLink(client, id, 'cleaned/../incoming/raw.csv')).status).toBe(400);
    });

    it('only the admin who added it can change, share or test it', async () => {
        const { service, id } = await setUp();
        await service.setUsers(admin, id, ['client']);
        expect((await service.setUsers(client, id, ['other'])).status).toBe(404);
        expect((await service.update(client, id, { name: 'x' })).status).toBe(404);
        expect((await service.remove(client, id)).status).toBe(404);
        expect((await service.test(admin, id)).body).toEqual({ ok: true, message: 'Connected. 3 files in incoming/, 2 cleaned files ready to open in cleaned/.' });
    });

    it('says plainly when Azure refuses the key', async () => {
        const { service, id } = await setUp(async () => ({ ok: false, status: 403, text: async () => '<Error><Code>AuthenticationFailed</Code></Error>' }));
        expect((await service.test(admin, id)).body).toEqual({ ok: false, message: expect.stringMatching(/did not accept the access key/) });
        expect((await service.files(admin, id)).status).toBe(502);
    });
});
