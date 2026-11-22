/**
 * Azure data pipelines: each client's own Azure storage, where their Azure
 * Data Factory pipeline cleans every file that arrives.
 *
 *   incoming/  ← a file lands here (from QuickInsight or put there by the client)
 *   ADF pipeline (storage-event trigger) cleans it
 *   cleaned/   → the cleaned file appears here; QuickInsight opens it
 *
 * The server never sees the data. It keeps the storage account's access key
 * (encrypted at rest, never sent to a browser) and hands out short-lived,
 * narrowly scoped links (SAS): write-only for one new file in the incoming
 * folder, read-only for one file in the cleaned folder. The browser moves the
 * file to and from Azure itself. Listing the cleaned folder (names, sizes,
 * dates) is done here, so the key never leaves the server.
 *
 * Admins add a pipeline and choose which accounts use it (typically the
 * client's own logins); those accounts can open its cleaned files and, when
 * switched on, have their uploads go through it.
 */
const crypto = require('crypto');

const SAS_VERSION = '2022-11-02';
const UPLOAD_LINK_MS = 15 * 60 * 1000;
const DOWNLOAD_LINK_MS = 10 * 60 * 1000;
const LIST_LINK_MS = 2 * 60 * 1000;
const MAX_PIPELINES = 50;
const MAX_USERS = 200;
const OPENABLE = /\.(csv|xlsx|xls)$/i;

const ACCOUNT_RE = /^[a-z0-9]{3,24}$/;
const CONTAINER_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ID_RE = /^pl_[A-Za-z0-9_-]{6,40}$/;

// ─── the access key, encrypted at rest ───────────────────────────────────

function keyFrom(env = process.env) {
    const given = String(env.QI_SECRETS_KEY || '').trim();
    if (given) {
        const raw = /^[0-9a-f]{64}$/i.test(given) ? Buffer.from(given, 'hex') : Buffer.from(given, 'base64');
        if (raw.length === 32) return raw;
    }
    // Otherwise derived from the sign-in secret: changing that secret means
    // entering the access keys again (they cannot be read back).
    const base = env.JWT_SECRET || 'QuickInsight-development-only-do-not-deploy';
    return Buffer.from(crypto.hkdfSync('sha256', base, 'quickinsight', 'azure-pipeline-access-keys', 32));
}

function sealSecret(text, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function openSecret(sealed, key) {
    const [v, iv, tag, data] = String(sealed || '').split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ─── short-lived links (service SAS, signed with the account key) ────────

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const encodePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

/**
 * A service SAS for one blob (sr=b) or the container (sr=c).
 * String-to-sign for version 2020-12-06 and later.
 */
function serviceSas({ account, container, blob = '', permissions, accountKey, now = Date.now(), ttlMs }) {
    const st = iso(now - 5 * 60 * 1000);
    const se = iso(now + ttlMs);
    const sr = blob ? 'b' : 'c';
    const resource = `/blob/${account}/${container}${blob ? `/${blob}` : ''}`;
    const stringToSign = [
        permissions, st, se, resource,
        '', // signedIdentifier
        '', // signedIP
        'https', SAS_VERSION, sr,
        '', // signedSnapshotTime
        '', // signedEncryptionScope
        '', '', '', '', '', // rscc rscd rsce rscl rsct
    ].join('\n');
    const sig = crypto.createHmac('sha256', Buffer.from(accountKey, 'base64')).update(stringToSign, 'utf8').digest('base64');
    const query = new URLSearchParams({ sv: SAS_VERSION, spr: 'https', st, se, sr, sp: permissions, sig });
    return { query: query.toString(), stringToSign, expiresAt: se };
}

function blobUrl(account, container, blob, sas) {
    return `https://${account}.blob.core.windows.net/${container}/${encodePath(blob)}?${sas}`;
}

// ─── checking what an admin typed ────────────────────────────────────────

function folder(value, fallback) {
    let f = String(value ?? fallback).trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!f) return '';
    if (f.length > 200 || f.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f?#%]/.test(f)) return null;
    if (!f.endsWith('/')) f += '/';
    return f.replace(/\/{2,}/g, '/');
}

/** A pipeline as typed by an admin, checked; `key` may be omitted on update. */
function cleanPipeline(input = {}, { requireKey = true } = {}) {
    const name = String(input.name || '').trim().slice(0, 120);
    const account = String(input.account || '').trim().toLowerCase();
    const container = String(input.container || '').trim().toLowerCase();
    const incoming = folder(input.incoming, 'incoming/');
    const cleaned = folder(input.cleaned, 'cleaned/');
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!name) return { error: 'Give the pipeline a name, e.g. the client\'s name' };
    if (!ACCOUNT_RE.test(account)) return { error: 'The storage account name is 3–24 lowercase letters and numbers' };
    if (!CONTAINER_RE.test(container)) return { error: 'The container name is 3–63 lowercase letters, numbers and single hyphens' };
    if (incoming === null || cleaned === null) return { error: 'Folders are paths inside the container, like incoming/ or sales/cleaned/' };
    if (incoming === cleaned || (incoming && cleaned.startsWith(incoming)) || (cleaned && incoming.startsWith(cleaned))) {
        return { error: 'The incoming and cleaned folders must be separate, or the pipeline would clean its own output' };
    }
    if (requireKey || key) {
        const raw = key ? Buffer.from(key, 'base64') : Buffer.alloc(0);
        if (raw.length < 32 || raw.toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, '')) return { error: 'Paste the storage account\'s access key (key1 or key2, from Access keys in the Azure portal)' };
    }
    return { value: { name, account, container, incoming, cleaned, routeUploads: input.routeUploads !== false, key } };
}

/** A safe blob name for an upload: incoming/2026-11-22-131501-orders_nov.csv */
function incomingName(prefix, fileName, now = Date.now()) {
    const base = String(fileName || 'upload.csv').split(/[\\/]/).pop().normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(-120) || 'upload.csv';
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return `${prefix}${stamp}-${base}`;
}

/** Blob names, sizes and dates from Azure's List Blobs XML. */
function parseBlobList(xml) {
    const out = [];
    const tag = (block, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block); return m ? m[1] : ''; };
    const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    for (const m of String(xml).matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        const path = unescape(tag(m[1], 'Name'));
        const size = Number(tag(m[1], 'Content-Length')) || 0;
        const modified = Date.parse(tag(m[1], 'Last-Modified')) || 0;
        if (path && !path.endsWith('/')) out.push({ path, name: path.split('/').pop(), size, modified });
    }
    return out;
}

/** Azure's error, in plain words. */
function azureProblem(status, body) {
    const code = /<Code>([^<]+)<\/Code>/.exec(String(body || ''))?.[1] || '';
    if (code === 'AuthenticationFailed' || status === 403) return 'Azure did not accept the access key. Check the storage account name and paste key1 or key2 again.';
    if (code === 'ContainerNotFound' || status === 404) return 'That container does not exist in the storage account.';
    if (code === 'AuthorizationPermissionMismatch') return 'The key does not allow this. Use the storage account\'s access key (key1 or key2).';
    return `Azure answered ${status}${code ? ` (${code})` : ''}.`;
}

// ─── the service ─────────────────────────────────────────────────────────

function createAzurePipelineService({ getPool, fetchImpl = (...args) => fetch(...args), secretKey = keyFrom(), now = () => Date.now() }) {
    async function ensureTables() {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS azure_pipelines (
                id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                account TEXT NOT NULL,
                container TEXT NOT NULL,
                incoming_prefix TEXT NOT NULL,
                cleaned_prefix TEXT NOT NULL,
                route_uploads BOOLEAN NOT NULL DEFAULT true,
                secret TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS azure_pipeline_users (
                pipeline_id TEXT NOT NULL REFERENCES azure_pipelines(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (pipeline_id, user_id)
            )
        `);
    }

    const publicView = (row, users) => ({
        id: row.id, name: row.name, account: row.account, container: row.container,
        incoming: row.incoming_prefix, cleaned: row.cleaned_prefix, routeUploads: row.route_uploads,
        ...(users ? { userIds: users } : {}),
    });

    /** The pipeline if this person may use it (its admin, or an account it was shared with). */
    async function usable(id, user) {
        const pool = getPool();
        if (!pool || !ID_RE.test(String(id || ''))) return null;
        const { rows } = await pool.query(`
            SELECT p.* FROM azure_pipelines p
            WHERE p.id = $1 AND (p.owner_id = $2 OR EXISTS (SELECT 1 FROM azure_pipeline_users u WHERE u.pipeline_id = p.id AND u.user_id = $2))
        `, [id, user.userId]);
        return rows[0] || null;
    }
    async function owned(id, user) {
        const row = await usable(id, user);
        return row && row.owner_id === user.userId && user.role === 'admin' ? row : null;
    }

    async function list(user) {
        const pool = getPool();
        if (!pool) return { pipelines: [] };
        if (user.role === 'admin') {
            const { rows } = await pool.query('SELECT * FROM azure_pipelines WHERE owner_id = $1 ORDER BY name', [user.userId]);
            const users = await pool.query('SELECT pipeline_id, user_id FROM azure_pipeline_users WHERE pipeline_id = ANY($1::text[])', [rows.map(r => r.id)]);
            const by = {};
            for (const u of users.rows) (by[u.pipeline_id] = by[u.pipeline_id] || []).push(u.user_id);
            return { pipelines: rows.map(r => ({ ...publicView(r, by[r.id] || []), mine: true })) };
        }
        const { rows } = await pool.query(`
            SELECT p.* FROM azure_pipelines p JOIN azure_pipeline_users u ON u.pipeline_id = p.id
            WHERE u.user_id = $1 ORDER BY p.name
        `, [user.userId]);
        return { pipelines: rows.map(r => publicView(r)) };
    }

    async function create(user, input) {
        const pool = getPool();
        if (!pool) return { status: 503, body: { error: 'Not available right now' } };
        const checked = cleanPipeline(input);
        if (checked.error) return { status: 400, body: { error: checked.error } };
        const count = await pool.query('SELECT COUNT(*)::int AS n FROM azure_pipelines WHERE owner_id = $1', [user.userId]);
        if ((count.rows[0]?.n || 0) >= MAX_PIPELINES) return { status: 400, body: { error: `An account can keep up to ${MAX_PIPELINES} pipelines` } };
        const v = checked.value;
        const id = `pl_${crypto.randomBytes(9).toString('base64url')}`;
        await pool.query(`
            INSERT INTO azure_pipelines (id, owner_id, name, account, container, incoming_prefix, cleaned_prefix, route_uploads, secret)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [id, user.userId, v.name, v.account, v.container, v.incoming, v.cleaned, v.routeUploads, sealSecret(v.key, secretKey)]);
        return { status: 200, body: { success: true, pipeline: { ...publicView({ id, name: v.name, account: v.account, container: v.container, incoming_prefix: v.incoming, cleaned_prefix: v.cleaned, route_uploads: v.routeUploads }, []), mine: true } } };
    }

    async function update(user, id, input) {
        const pool = getPool();
        const row = await owned(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        const checked = cleanPipeline({ incoming: row.incoming_prefix, cleaned: row.cleaned_prefix, ...input }, { requireKey: false });
        if (checked.error) return { status: 400, body: { error: checked.error } };
        const v = checked.value;
        await pool.query(`
            UPDATE azure_pipelines SET name = $2, account = $3, container = $4, incoming_prefix = $5, cleaned_prefix = $6, route_uploads = $7,
                secret = COALESCE($8, secret), updated_at = NOW()
            WHERE id = $1
        `, [id, v.name, v.account, v.container, v.incoming, v.cleaned, v.routeUploads, v.key ? sealSecret(v.key, secretKey) : null]);
        return { status: 200, body: { success: true } };
    }

    async function remove(user, id) {
        const pool = getPool();
        const row = await owned(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        await pool.query('DELETE FROM azure_pipelines WHERE id = $1', [id]);
        return { status: 200, body: { success: true } };
    }

    async function setUsers(user, id, userIds) {
        const pool = getPool();
        const row = await owned(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        if (!Array.isArray(userIds) || userIds.length > MAX_USERS || userIds.some(u => typeof u !== 'string' || u.length > 120)) return { status: 400, body: { error: `Pick up to ${MAX_USERS} accounts` } };
        const wanted = [...new Set(userIds)].filter(u => u !== user.userId);
        const found = wanted.length ? (await pool.query('SELECT id FROM users WHERE id = ANY($1::text[])', [wanted])).rows.map(r => r.id) : [];
        if (found.length !== wanted.length) return { status: 400, body: { error: 'One of those accounts no longer exists' } };
        await pool.query('DELETE FROM azure_pipeline_users WHERE pipeline_id = $1', [id]);
        for (const u of found) await pool.query('INSERT INTO azure_pipeline_users (pipeline_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u]);
        return { status: 200, body: { success: true, userIds: found } };
    }

    const accountKeyOf = (row) => openSecret(row.secret, secretKey);

    /** Names, sizes and dates of the files under a folder (no data). */
    async function listFolder(row, prefix) {
        const sas = serviceSas({ account: row.account, container: row.container, permissions: 'l', accountKey: accountKeyOf(row), now: now(), ttlMs: LIST_LINK_MS });
        const params = new URLSearchParams({ restype: 'container', comp: 'list', prefix, maxresults: '1000' });
        const res = await fetchImpl(`https://${row.account}.blob.core.windows.net/${row.container}?${params}&${sas.query}`, { headers: { 'x-ms-version': SAS_VERSION } });
        const text = await res.text();
        if (!res.ok) return { error: azureProblem(res.status, text) };
        return { files: parseBlobList(text) };
    }

    async function files(user, id) {
        const row = await usable(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        try {
            const listed = await listFolder(row, row.cleaned_prefix);
            if (listed.error) return { status: 502, body: { error: listed.error } };
            const shown = listed.files.filter(f => OPENABLE.test(f.name)).sort((a, b) => b.modified - a.modified).slice(0, 200);
            return { status: 200, body: { files: shown, skipped: listed.files.length - shown.length } };
        } catch {
            return { status: 502, body: { error: 'Could not reach Azure. Try again in a moment.' } };
        }
    }

    async function test(user, id) {
        const row = await owned(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        try {
            const cleaned = await listFolder(row, row.cleaned_prefix);
            if (cleaned.error) return { status: 200, body: { ok: false, message: cleaned.error } };
            const incoming = await listFolder(row, row.incoming_prefix);
            if (incoming.error) return { status: 200, body: { ok: false, message: incoming.error } };
            const openable = cleaned.files.filter(f => OPENABLE.test(f.name)).length;
            return { status: 200, body: { ok: true, message: `Connected. ${incoming.files.length} file${incoming.files.length === 1 ? '' : 's'} in ${row.incoming_prefix || 'the container'}, ${openable} cleaned file${openable === 1 ? '' : 's'} ready to open in ${row.cleaned_prefix || 'the container'}.` } };
        } catch {
            return { status: 200, body: { ok: false, message: 'Could not reach Azure from QuickInsight. Check the storage account name.' } };
        }
    }

    async function uploadLink(user, id, fileName) {
        const row = await usable(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        if (!row.route_uploads) return { status: 400, body: { error: 'Uploads are not sent through this pipeline' } };
        if (!OPENABLE.test(String(fileName || ''))) return { status: 400, body: { error: 'Only CSV and Excel files go through the pipeline' } };
        const path = incomingName(row.incoming_prefix, fileName, now());
        // Create and write this one new file; nothing can be read or listed with it.
        const sas = serviceSas({ account: row.account, container: row.container, blob: path, permissions: 'cw', accountKey: accountKeyOf(row), now: now(), ttlMs: UPLOAD_LINK_MS });
        return { status: 200, body: { url: blobUrl(row.account, row.container, path, sas.query), path, startedAt: now(), expiresAt: sas.expiresAt } };
    }

    async function downloadLink(user, id, path) {
        const row = await usable(id, user);
        if (!row) return { status: 404, body: { error: 'No such pipeline' } };
        const p = String(path || '');
        if (!p.startsWith(row.cleaned_prefix) || p.split('/').includes('..') || !OPENABLE.test(p) || p.length > 1024) return { status: 400, body: { error: 'Only files in the cleaned folder can be opened' } };
        const sas = serviceSas({ account: row.account, container: row.container, blob: p, permissions: 'r', accountKey: accountKeyOf(row), now: now(), ttlMs: DOWNLOAD_LINK_MS });
        return { status: 200, body: { url: blobUrl(row.account, row.container, p, sas.query), expiresAt: sas.expiresAt } };
    }

    return { ensureTables, list, create, update, remove, setUsers, files, test, uploadLink, downloadLink };
}

function registerAzurePipelineRoutes(app, service, { requireAuthenticatedUser }) {
    const send = (res, result) => res.status(result.status).json(result.body);
    const onlyAdmins = (req, res, next) => (req.authUser?.role === 'admin' ? next() : res.status(403).json({ error: 'Only admins set up data pipelines' }));
    const guard = (label, fn) => async (req, res) => {
        try { await fn(req, res); } catch (error) { res.status(500).json({ error: `Could not ${label}` }); }
    };
    app.get('/api/azure-pipelines', requireAuthenticatedUser, guard('read the pipelines', async (req, res) => res.json(await service.list(req.authUser))));
    app.post('/api/azure-pipelines', requireAuthenticatedUser, onlyAdmins, guard('add the pipeline', async (req, res) => send(res, await service.create(req.authUser, req.body || {}))));
    app.put('/api/azure-pipelines/:id', requireAuthenticatedUser, onlyAdmins, guard('save the pipeline', async (req, res) => send(res, await service.update(req.authUser, req.params.id, req.body || {}))));
    app.delete('/api/azure-pipelines/:id', requireAuthenticatedUser, onlyAdmins, guard('remove the pipeline', async (req, res) => send(res, await service.remove(req.authUser, req.params.id))));
    app.put('/api/azure-pipelines/:id/users', requireAuthenticatedUser, onlyAdmins, guard('share the pipeline', async (req, res) => send(res, await service.setUsers(req.authUser, req.params.id, req.body?.userIds))));
    app.post('/api/azure-pipelines/:id/test', requireAuthenticatedUser, onlyAdmins, guard('test the pipeline', async (req, res) => send(res, await service.test(req.authUser, req.params.id))));
    app.get('/api/azure-pipelines/:id/files', requireAuthenticatedUser, guard('list the cleaned files', async (req, res) => send(res, await service.files(req.authUser, req.params.id))));
    app.post('/api/azure-pipelines/:id/upload-link', requireAuthenticatedUser, guard('prepare the upload', async (req, res) => send(res, await service.uploadLink(req.authUser, req.params.id, req.body?.fileName))));
    app.post('/api/azure-pipelines/:id/download-link', requireAuthenticatedUser, guard('open the file', async (req, res) => send(res, await service.downloadLink(req.authUser, req.params.id, req.body?.path))));
}

module.exports = {
    createAzurePipelineService, registerAzurePipelineRoutes,
    serviceSas, cleanPipeline, incomingName, parseBlobList, sealSecret, openSecret, keyFrom, azureProblem,
};
