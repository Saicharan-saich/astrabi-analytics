/**
 * Account lifecycle: sessions that last, password reset by email, and the
 * UK GDPR rights a customer can use without contacting anyone — download
 * everything held about them, and delete their account.
 *
 * Sessions: a signed token valid for 30 days, renewed silently when the app
 * checks it after a day, so someone using the app is never logged out mid-work.
 * "Log out everywhere", a password change and a reset all end every session
 * at once (session_version).
 */
const crypto = require('crypto');
const { sendEmail, simpleEmail } = require('./mailer');

const SESSION_DAYS = 30;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
const RESET_MINUTES = 60;
const MIN_PASSWORD = 8;

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function createAccountService({ jwt, secret, bcrypt, rounds, getPool, isProduction, appUrl }) {
    const issueToken = (user) => jwt.sign(
        { userId: user.id, email: user.email, role: user.role, sv: Number(user.session_version) || 1 },
        secret,
        { expiresIn: `${SESSION_DAYS}d` },
    );

    /** A fresh token when the one presented is more than a day old (sliding session). */
    const renewedToken = (decoded, user) => {
        const age = Math.floor(Date.now() / 1000) - Number(decoded.iat || 0);
        return age > RENEW_AFTER_SECONDS ? issueToken(user) : null;
    };

    const passwordProblem = (password) => {
        if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
        if (password.length > 200) return 'Password is too long';
        return null;
    };

    async function ensureTables() {
        const pool = getPool();
        if (!pool) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        try { await pool.query('CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id)'); } catch { /* exists */ }
    }

    /** Start a reset. Always reports success, so the form cannot reveal who has an account. */
    async function requestReset(email) {
        const pool = getPool();
        if (!pool) return { ok: false, status: 503, error: 'Database connection not available' };
        const emailNorm = String(email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) return { ok: false, status: 400, error: 'Enter a valid email address' };
        const { rows } = await pool.query('SELECT id, email, name, is_active FROM users WHERE email = $1', [emailNorm]);
        const user = rows[0];
        if (user && user.is_active !== false) {
            // One live link per account: older unused links stop working.
            await pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);
            const token = crypto.randomBytes(32).toString('base64url');
            await pool.query(
                `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
                [sha256(token), user.id, String(RESET_MINUTES)],
            );
            const link = `${appUrl().replace(/\/$/, '')}/?reset=${encodeURIComponent(token)}`;
            const mail = simpleEmail({
                heading: 'Reset your QuickInsight password',
                lines: [`Hi ${user.name || 'there'},`, `Someone asked to reset the password for ${user.email}. The link below works once, for the next ${RESET_MINUTES} minutes.`, 'If this wasn’t you, you can ignore this email: your password stays the same.'],
                buttonText: 'Choose a new password',
                buttonUrl: link,
                footer: 'QuickInsight · quickinsight.co.uk',
            });
            await sendEmail({ to: user.email, subject: 'Reset your QuickInsight password', ...mail });
        }
        return { ok: true };
    }

    /** Finish a reset: new password, every session ended, a fresh one returned. */
    async function completeReset(token, password) {
        const pool = getPool();
        if (!pool) return { ok: false, status: 503, error: 'Database connection not available' };
        const problem = passwordProblem(password);
        if (problem) return { ok: false, status: 400, error: problem };
        if (typeof token !== 'string' || token.length < 20) return { ok: false, status: 400, error: 'This reset link is not valid. Ask for a new one.' };
        const { rows } = await pool.query(
            `SELECT r.user_id, u.email, u.name, u.role, u.is_active FROM password_resets r JOIN users u ON u.id = r.user_id
             WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > NOW()`,
            [sha256(token)],
        );
        const found = rows[0];
        if (!found || found.is_active === false) return { ok: false, status: 400, error: 'This reset link has expired or was already used. Ask for a new one.' };
        const hash = await bcrypt.hash(password, rounds);
        const updated = await pool.query(
            'UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING id, email, name, role, session_version',
            [hash, found.user_id],
        );
        await pool.query('UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1', [sha256(token)]);
        const user = updated.rows[0];
        return { ok: true, token: issueToken(user), user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    }

    /** Everything held about one person, as one JSON document. */
    async function exportAccount(userId) {
        const pool = getPool();
        const one = async (sql) => { try { return (await pool.query(sql, [userId])).rows; } catch { return []; } };
        const [profile] = await one('SELECT id, email, name, role, is_active, daily_ai_limit, created_at FROM users WHERE id = $1');
        return {
            exportedAt: new Date().toISOString(),
            note: 'Everything QuickInsight stores about your account on its server. Your uploaded files are not here: they stay in your own browser and are never sent to the server.',
            profile: profile || null,
            dashboards: await one('SELECT id, name, dataset_id, items, layout, filters, formatting, created_at, updated_at FROM dashboards WHERE user_id = $1 ORDER BY created_at'),
            aiUsage: await one('SELECT action, tokens_used, model, created_at FROM usage_logs WHERE user_id = $1 ORDER BY created_at'),
            activity: await one('SELECT action, details, created_at FROM user_activities WHERE user_id = $1 ORDER BY created_at'),
            billing: await one('SELECT plan, status, trial_ends_at, current_period_end, created_at, updated_at FROM subscriptions WHERE user_id = $1'),
        };
    }

    /** Delete an account and everything stored with it. The last admin cannot delete themselves. */
    async function deleteAccount(userId, password) {
        const pool = getPool();
        if (!pool) return { ok: false, status: 503, error: 'Database connection not available' };
        const { rows } = await pool.query('SELECT id, role, password_hash FROM users WHERE id = $1', [userId]);
        const user = rows[0];
        if (!user) return { ok: false, status: 404, error: 'Account not found' };
        if (!(await bcrypt.compare(String(password || ''), user.password_hash))) return { ok: false, status: 401, error: 'Password is incorrect' };
        if (user.role === 'admin') {
            const admins = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND is_active <> false`);
            if (admins.rows[0].n <= 1) return { ok: false, status: 400, error: 'You are the only admin. Make someone else an admin before deleting this account.' };
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const sql of [
                'DELETE FROM usage_logs WHERE user_id = $1',
                'DELETE FROM user_activities WHERE user_id = $1',
                'UPDATE benchmark_runs SET created_by = NULL WHERE created_by = $1',
            ]) await client.query(sql, [userId]);
            // Billing rows and reset links go with the user (ON DELETE CASCADE), as do dashboards.
            await client.query('DELETE FROM users WHERE id = $1', [userId]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        return { ok: true };
    }

    /**
     * What the privacy policy promises about keeping logs: AI usage logs for
     * LOG_RETENTION_DAYS (30), the account activity log for
     * ACTIVITY_RETENTION_DAYS (365), and used or expired reset links for a day.
     */
    const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 30);
    const ACTIVITY_RETENTION_DAYS = Math.max(1, Number(process.env.ACTIVITY_RETENTION_DAYS) || 365);
    async function purgeOldRecords() {
        const pool = getPool();
        if (!pool) return null;
        const removed = {};
        const run = async (name, sql, params) => {
            try { removed[name] = (await pool.query(sql, params)).rowCount || 0; } catch (error) { removed[name] = `failed: ${error.message}`; }
        };
        await run('usage_logs', `DELETE FROM usage_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [LOG_RETENTION_DAYS]);
        await run('user_activities', `DELETE FROM user_activities WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [ACTIVITY_RETENTION_DAYS]);
        await run('password_resets', `DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL '1 day' OR used_at < NOW() - INTERVAL '1 day'`, []);
        return removed;
    }

    return { issueToken, renewedToken, passwordProblem, ensureTables, requestReset, completeReset, exportAccount, deleteAccount, purgeOldRecords, SESSION_DAYS, MIN_PASSWORD, LOG_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS };
}

/** The account routes. `requireUser` is the server's authenticated-user middleware. */
function registerAccountRoutes(app, service, { requireUser, rateLimit, onSignedOutEverywhere = () => {} }) {
    const resetLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many reset requests. Try again in a few minutes.' } });
    const send = (res, result, ok = (r) => r) => result.ok ? res.json({ success: true, ...ok(result) }) : res.status(result.status || 400).json({ success: false, error: result.error });

    app.post('/api/auth/forgot-password', resetLimit, async (req, res) => {
        try {
            const result = await service.requestReset(req.body?.email);
            send(res, result, () => ({ message: 'If that email has an account, a reset link is on its way.' }));
        } catch (error) {
            console.error('[Accounts] Reset request failed:', error.message);
            res.status(500).json({ success: false, error: 'Could not start the reset. Please try again.' });
        }
    });

    app.post('/api/auth/reset-password', resetLimit, async (req, res) => {
        try {
            const result = await service.completeReset(req.body?.token, req.body?.password);
            if (result.ok) onSignedOutEverywhere(result.user.id);
            send(res, result, r => ({ token: r.token, user: r.user }));
        } catch (error) {
            console.error('[Accounts] Reset failed:', error.message);
            res.status(500).json({ success: false, error: 'Could not reset the password. Please try again.' });
        }
    });

    app.get('/api/auth/account-export', requireUser, async (req, res) => {
        try {
            const data = await service.exportAccount(req.authUser.userId);
            res.setHeader('Content-Disposition', 'attachment; filename="quickinsight-account-data.json"');
            res.json(data);
        } catch (error) {
            console.error('[Accounts] Export failed:', error.message);
            res.status(500).json({ success: false, error: 'Could not prepare your data. Please try again.' });
        }
    });

    app.post('/api/auth/delete-account', requireUser, async (req, res) => {
        try {
            if (req.body?.confirm !== 'DELETE') return res.status(400).json({ success: false, error: 'Type DELETE to confirm' });
            const result = await service.deleteAccount(req.authUser.userId, req.body?.password);
            if (result.ok) onSignedOutEverywhere(req.authUser.userId);
            send(res, result, () => ({ message: 'Your account and everything stored with it has been deleted.' }));
        } catch (error) {
            console.error('[Accounts] Delete failed:', error.message);
            res.status(500).json({ success: false, error: 'Could not delete the account. Please try again.' });
        }
    });
}

module.exports = { createAccountService, registerAccountRoutes, sha256 };
