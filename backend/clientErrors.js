/**
 * Error reports from people's browsers, so crashes are seen and fixed.
 *
 * A report holds the error message, where in the code it happened, the page
 * path and the app version. Anything in quotes is removed from the message
 * and the stack first (error messages can repeat a value from the data, such
 * as "Cannot read 'Acme Ltd'"), long numbers and email addresses are masked,
 * and everything is cut to a fixed size. Reports are deleted after 30 days.
 */

const MAX_MESSAGE = 300;
const MAX_STACK = 2000;

/** Remove anything that could be a value from the person's data. */
function scrub(text, max) {
    return String(text ?? '')
        .replace(/(["'`])(?:(?!\1)[^\n]){0,500}\1/g, '"…"')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b\d{5,}\b/g, '[number]')
        .replace(/[?#][^\s)]*/g, '')
        .slice(0, max);
}

function cleanReport(body) {
    const report = body && typeof body === 'object' ? body : {};
    const message = scrub(report.message, MAX_MESSAGE).trim();
    if (!message) return null;
    return {
        message,
        stack: scrub(report.stack, MAX_STACK),
        path: String(report.path || '').replace(/[?#].*$/, '').slice(0, 120),
        release: String(report.release || '').replace(/[^\w.:-]/g, '').slice(0, 40),
        kind: ['error', 'unhandledrejection', 'render'].includes(report.kind) ? report.kind : 'error',
    };
}

function createClientErrorService({ getPool }) {
    async function ensureTables() {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS client_errors (
                id SERIAL PRIMARY KEY,
                user_id TEXT,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                stack TEXT,
                path TEXT,
                release TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        try { await pool.query('CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors (created_at)'); } catch { /* exists */ }
    }

    async function record(userId, body) {
        const pool = getPool();
        const report = cleanReport(body);
        if (!pool || !report) return false;
        await pool.query(
            'INSERT INTO client_errors (user_id, kind, message, stack, path, release) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId || null, report.kind, report.message, report.stack, report.path, report.release],
        );
        return true;
    }

    /** The most frequent errors of the last `days` days, for the admin. */
    async function summary(days = 7) {
        const pool = getPool();
        if (!pool) return [];
        const { rows } = await pool.query(`
            SELECT message, kind, COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS people,
                   MAX(created_at) AS last_seen, MAX(release) AS release, (ARRAY_AGG(stack ORDER BY created_at DESC))[1] AS stack
            FROM client_errors WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
            GROUP BY message, kind ORDER BY count DESC LIMIT 50
        `, [days]);
        return rows;
    }

    async function purge(days = 30) {
        const pool = getPool();
        if (!pool) return 0;
        return (await pool.query(`DELETE FROM client_errors WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [days])).rowCount || 0;
    }

    return { ensureTables, record, summary, purge };
}

function registerClientErrorRoutes(app, service, { rateLimit, optionalUser, requireAdmin }) {
    const limit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { success: false } });
    app.post('/api/client-errors', limit, async (req, res) => {
        try {
            await service.record(optionalUser(req)?.userId, req.body);
        } catch (error) {
            console.error('[ClientErrors] Could not store a report:', error.message);
        }
        res.status(204).end();
    });
    app.get('/api/admin/client-errors', async (req, res) => {
        const admin = await requireAdmin(req);
        if (!admin) return res.status(403).json({ success: false, error: 'Admins only' });
        try {
            res.json({ success: true, errors: await service.summary(Math.min(30, Math.max(1, Number(req.query.days) || 7))) });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Could not read error reports' });
        }
    });
}

module.exports = { createClientErrorService, registerClientErrorRoutes, scrub, cleanReport };
