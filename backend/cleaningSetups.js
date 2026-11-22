/**
 * Saved cleaning setups, kept with the person's account.
 *
 * A setup is the cleaning for one kind of recurring file: the steps, checks,
 * blank-cell choices and column kinds, plus the file's column names. It never
 * holds rows. Keeping it with the account means it survives a cleared browser
 * or a new computer, and the people who look after a client's data can keep
 * it up to date.
 *
 * Every setup is checked and trimmed on the way in: known fields only, column
 * kinds from a fixed list, sizes capped, and anything that could carry rows
 * (rows, raw rows, sample rows, preview tables) removed wherever it appears.
 * The newest version wins; a deleted setup leaves a marker so other computers
 * delete it too.
 */

const MAX_SETUP_BYTES = 256 * 1024;
const MAX_SETUPS = 500;
const MAX_SHARES = 200;
const MAX_COLUMNS = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KINDS = new Set(['METRIC', 'DIMENSION', 'DATE', 'BOOLEAN', 'ID', 'UNKNOWN']);
/** Fields that could carry a person's rows: never stored, at any depth. */
const ROW_FIELDS = new Set(['rows', 'rawRows', 'sampleRows', 'removedRowSamples', 'stepBase', 'data', 'preTransformRows', 'relatedTables']);

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0);

/** A copy of plain JSON with row-carrying fields removed at any depth. */
function withoutRows(value, depth = 0) {
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.slice(0, 2000).map(item => withoutRows(item, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (ROW_FIELDS.has(key) || key.startsWith('__')) continue;
            out[key] = withoutRows(item, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string') return value.slice(0, 2000);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return null;
}

/** The setup as it may be stored, or null when it is not a setup. */
function cleanSetup(input) {
    if (!input || typeof input !== 'object') return null;
    const id = text(input.id, 80);
    const name = text(input.name, 120).trim();
    if (!ID_RE.test(id) || !name) return null;
    if (!Array.isArray(input.headers) || !Array.isArray(input.columns)) return null;
    const headers = input.headers.filter(h => typeof h === 'string').slice(0, MAX_COLUMNS).map(h => h.slice(0, 200));
    const columns = input.columns
        .filter(c => c && typeof c.name === 'string' && KINDS.has(c.type))
        .slice(0, MAX_COLUMNS)
        .map(c => ({ name: c.name.slice(0, 200), type: c.type }));
    const etlOptions = input.etlOptions && typeof input.etlOptions === 'object' && !Array.isArray(input.etlOptions) ? withoutRows(input.etlOptions) : {};
    const columnTypes = {};
    if (input.columnTypes && typeof input.columnTypes === 'object') {
        for (const [column, kind] of Object.entries(input.columnTypes).slice(0, MAX_COLUMNS)) {
            if (KINDS.has(kind)) columnTypes[column.slice(0, 200)] = kind;
        }
    }
    const setup = {
        id, name, headers, columns, etlOptions,
        createdAt: number(input.createdAt) || Date.now(),
        updatedAt: number(input.updatedAt) || Date.now(),
        ...(Object.keys(columnTypes).length ? { columnTypes } : {}),
        ...(typeof input.notes === 'string' && input.notes.trim() ? { notes: input.notes.slice(0, 2000) } : {}),
        timesUsed: number(input.timesUsed),
        ...(number(input.lastUsedAt) ? { lastUsedAt: number(input.lastUsedAt) } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(setup)) > MAX_SETUP_BYTES) return null;
    return setup;
}

function createCleaningSetupService({ getPool }) {
    async function ensureTables() {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cleaning_setups (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id TEXT NOT NULL,
                setup JSONB NOT NULL DEFAULT '{}',
                updated_ms BIGINT NOT NULL,
                deleted BOOLEAN NOT NULL DEFAULT false,
                saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, id)
            )
        `);
        // Which other accounts receive each setup (the client's own logins).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cleaning_setup_shares (
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                setup_id TEXT NOT NULL,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (owner_id, setup_id, user_id)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS cleaning_setup_shares_user ON cleaning_setup_shares (user_id)');
    }

    /** The person's setups, and the ids of the ones they deleted (with when). */
    async function list(userId) {
        const pool = getPool();
        if (!pool) return { setups: [], deleted: [] };
        const { rows } = await pool.query('SELECT id, setup, updated_ms, deleted FROM cleaning_setups WHERE user_id = $1 ORDER BY updated_ms DESC LIMIT $2', [userId, MAX_SETUPS * 2]);
        const shared = await pool.query('SELECT setup_id, user_id FROM cleaning_setup_shares WHERE owner_id = $1', [userId]);
        const shares = {};
        for (const row of shared.rows) (shares[row.setup_id] = shares[row.setup_id] || []).push(row.user_id);
        return {
            setups: rows.filter(r => !r.deleted).map(r => r.setup),
            deleted: rows.filter(r => r.deleted).map(r => ({ id: r.id, at: Number(r.updated_ms) })),
            shares,
        };
    }

    /** Choose which accounts receive one of this admin's setups (replaces the list). */
    async function setShares(ownerId, setupId, userIds) {
        const pool = getPool();
        if (!pool) return { status: 503, body: { error: 'Sharing is not available right now' } };
        if (!ID_RE.test(String(setupId || ''))) return { status: 400, body: { error: 'Not a setup id' } };
        if (!Array.isArray(userIds) || userIds.length > MAX_SHARES || userIds.some(id => typeof id !== 'string' || id.length > 120)) {
            return { status: 400, body: { error: `Pick up to ${MAX_SHARES} accounts` } };
        }
        const own = await pool.query('SELECT 1 FROM cleaning_setups WHERE user_id = $1 AND id = $2 AND NOT deleted', [ownerId, setupId]);
        if (!own.rows.length) return { status: 404, body: { error: 'Save the setup to your account first' } };
        const wanted = [...new Set(userIds)].filter(id => id !== ownerId);
        const found = wanted.length ? (await pool.query('SELECT id FROM users WHERE id = ANY($1::text[])', [wanted])).rows.map(r => r.id) : [];
        if (found.length !== wanted.length) return { status: 400, body: { error: 'One of those accounts no longer exists' } };
        await pool.query('DELETE FROM cleaning_setup_shares WHERE owner_id = $1 AND setup_id = $2', [ownerId, setupId]);
        for (const id of found) {
            await pool.query('INSERT INTO cleaning_setup_shares (owner_id, setup_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [ownerId, setupId, id]);
        }
        return { status: 200, body: { success: true, userIds: found } };
    }

    /** The setups other accounts shared with this person (latest versions; deleted ones drop out). */
    async function sharedWith(userId) {
        const pool = getPool();
        if (!pool) return { setups: [] };
        const { rows } = await pool.query(`
            SELECT c.setup, u.name AS owner_name
            FROM cleaning_setup_shares s
            JOIN cleaning_setups c ON c.user_id = s.owner_id AND c.id = s.setup_id AND NOT c.deleted
            JOIN users u ON u.id = s.owner_id
            WHERE s.user_id = $1
            ORDER BY c.updated_ms DESC
            LIMIT $2
        `, [userId, MAX_SETUPS]);
        return { setups: rows.map(r => ({ ...r.setup, sharedBy: r.owner_name || 'your data team' })) };
    }

    /** Store a setup unless a newer version is already stored. */
    async function save(userId, input) {
        const pool = getPool();
        if (!pool) return { status: 503, body: { error: 'Saving to your account is not available right now' } };
        const setup = cleanSetup(input);
        if (!setup) return { status: 400, body: { error: 'Not a cleaning setup, or too large' } };
        const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cleaning_setups WHERE user_id = $1 AND NOT deleted', [userId]);
        if ((rows[0]?.n || 0) >= MAX_SETUPS) return { status: 400, body: { error: `An account can keep up to ${MAX_SETUPS} setups` } };
        const result = await pool.query(`
            INSERT INTO cleaning_setups (user_id, id, setup, updated_ms, deleted, saved_at)
            VALUES ($1, $2, $3, $4, false, NOW())
            ON CONFLICT (user_id, id) DO UPDATE SET setup = EXCLUDED.setup, updated_ms = EXCLUDED.updated_ms, deleted = false, saved_at = NOW()
            WHERE cleaning_setups.updated_ms <= EXCLUDED.updated_ms
        `, [userId, setup.id, JSON.stringify(setup), setup.updatedAt]);
        return { status: 200, body: { success: true, id: setup.id, stored: (result.rowCount || 0) > 0 } };
    }

    /** Delete a setup, leaving a marker so other computers delete it too. */
    async function remove(userId, id, at) {
        const pool = getPool();
        if (!pool) return { status: 503, body: { error: 'Saving to your account is not available right now' } };
        if (!ID_RE.test(String(id || ''))) return { status: 400, body: { error: 'Not a setup id' } };
        const when = number(at) || Date.now();
        const marked = await pool.query(`
            INSERT INTO cleaning_setups (user_id, id, setup, updated_ms, deleted, saved_at)
            VALUES ($1, $2, '{}', $3, true, NOW())
            ON CONFLICT (user_id, id) DO UPDATE SET setup = '{}', updated_ms = EXCLUDED.updated_ms, deleted = true, saved_at = NOW()
            WHERE cleaning_setups.updated_ms <= EXCLUDED.updated_ms
        `, [userId, id, when]);
        // Deleted (not an older delete arriving late): it stops reaching the accounts it was shared with.
        if ((marked?.rowCount || 0) > 0) await pool.query('DELETE FROM cleaning_setup_shares WHERE owner_id = $1 AND setup_id = $2', [userId, id]);
        return { status: 200, body: { success: true } };
    }

    return { ensureTables, list, save, remove, setShares, sharedWith };
}

function registerCleaningSetupRoutes(app, service, { requireAuthenticatedUser }) {
    const send = (res, result) => res.status(result.status).json(result.body);
    // Cleaning is admin-only: other roles can neither read nor change setups.
    // The role comes from the database on every request (see requireAuthenticatedUser).
    const onlyAdmins = (req, res, next) => (req.authUser?.role === 'admin' ? next() : res.status(403).json({ error: 'Cleaning setups are for admins only' }));
    // Setups an admin shared with this account: every role may read these (read-only),
    // so the client's own logins clean their uploads with them.
    app.get('/api/cleaning-setups/shared', requireAuthenticatedUser, async (req, res) => {
        try { res.json(await service.sharedWith(req.authUser.userId)); }
        catch (error) { res.status(500).json({ error: 'Could not read the setups shared with you' }); }
    });
    app.put('/api/cleaning-setups/:id/shares', requireAuthenticatedUser, onlyAdmins, async (req, res) => {
        try { send(res, await service.setShares(req.authUser.userId, req.params.id, req.body?.userIds)); }
        catch (error) { res.status(500).json({ error: 'Could not share the setup' }); }
    });
    app.get('/api/cleaning-setups', requireAuthenticatedUser, onlyAdmins, async (req, res) => {
        try { res.json(await service.list(req.authUser.userId)); }
        catch (error) { res.status(500).json({ error: 'Could not read your setups' }); }
    });
    app.put('/api/cleaning-setups/:id', requireAuthenticatedUser, onlyAdmins, async (req, res) => {
        try {
            if (req.body?.id !== req.params.id) return res.status(400).json({ error: 'The setup id does not match' });
            send(res, await service.save(req.authUser.userId, req.body));
        } catch (error) { res.status(500).json({ error: 'Could not save the setup' }); }
    });
    app.delete('/api/cleaning-setups/:id', requireAuthenticatedUser, onlyAdmins, async (req, res) => {
        try { send(res, await service.remove(req.authUser.userId, req.params.id, req.query.at)); }
        catch (error) { res.status(500).json({ error: 'Could not delete the setup' }); }
    });
}

module.exports = { createCleaningSetupService, registerCleaningSetupRoutes, cleanSetup, withoutRows };
