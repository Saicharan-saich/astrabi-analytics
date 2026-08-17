require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const sql = require('mssql');
let rawSql = null;
try { rawSql = require('msnodesqlv8'); } catch { console.warn('[Server] msnodesqlv8 not available — Windows Auth SQL disabled'); }
const { Pool: PgPool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const {
    allowedLlmModels,
    assertSafeDatabaseHost,
    createConnectionId,
    validateLlmRequest,
    validatePort,
} = require('./security');
const { parseProviderError } = require('./llmProviderError');

// JWT_SECRET must come from the environment in production. A hard-coded fallback
// would be published the moment this repository goes public, and anyone holding it
// can mint a valid admin token — so refuse to boot rather than run insecurely.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
    console.error('[Auth] FATAL: JWT_SECRET is not set. Refusing to start in production.');
    process.exit(1);
}
if (!process.env.JWT_SECRET) {
    console.warn('[Auth] WARNING: JWT_SECRET not set — using a development-only fallback. '
        + 'Never run this configuration anywhere reachable from the internet.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'QuickInsight-development-only-do-not-deploy';
const BCRYPT_ROUNDS = 12;

// ═══════════════════════════════════════════
// POSTGRESQL USER PERSISTENCE
// ═══════════════════════════════════════════
let authPool = null;
let authDbStatus = 'not_configured';

async function initAuthDatabase() {
    // Try multiple URL env vars that Railway might provide
    const dbUrls = [
        process.env.DATABASE_URL,
        process.env.DATABASE_PUBLIC_URL,
        process.env.POSTGRES_URL,
    ].filter(Boolean);

    if (dbUrls.length === 0) {
        console.warn('[Auth] No database URL found (tried DATABASE_URL, DATABASE_PUBLIC_URL, POSTGRES_URL)');
        authDbStatus = 'no_url';
        return;
    }

    console.log(`[Auth] Found ${dbUrls.length} database URL(s) to try`);

    // Try each URL with both SSL configs
    for (const url of dbUrls) {
        const masked = url.replace(/\/\/[^@]+@/, '//***:***@');
        for (const sslConfig of [false, { rejectUnauthorized: false }]) {
            try {
                const pool = new PgPool({
                    connectionString: url,
                    ssl: sslConfig,
                    max: 5,
                    connectionTimeoutMillis: 10000
                });
                await pool.query('SELECT 1');
                authPool = pool;
                console.log(`[Auth] Connected to PostgreSQL: ${masked} (ssl=${JSON.stringify(sslConfig)})`);
                authDbStatus = 'connected';
                break;
            } catch (err) {
                console.warn(`[Auth] Failed: ${masked} (ssl=${JSON.stringify(sslConfig)}): ${err.message}`);
            }
        }
        if (authPool) break;
    }

    if (!authPool) {
        console.error('[Auth] Could not connect to PostgreSQL with any URL/SSL combination');
        authDbStatus = 'connection_failed';
        return;
    }

    try {
        await authPool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                password_hash TEXT NOT NULL,
                session_version INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // Migrations for existing DBs
        try { await authPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1`); } catch {}
        try { await authPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`); } catch {}
        try { await authPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_ai_limit INTEGER NOT NULL DEFAULT 50`); } catch {}
        console.log('[Auth] PostgreSQL users table ready');

        // Create usage_logs table for tracking AI consumption per user
        await authPool.query(`
            CREATE TABLE IF NOT EXISTS usage_logs (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                user_email TEXT,
                action TEXT NOT NULL,
                tokens_used INTEGER DEFAULT 0,
                model TEXT,
                details TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        try { await authPool.query(`CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_logs (user_id, created_at)`); } catch {}
        console.log('[Auth] Usage tracking table ready');

        // Create dashboards table for cloud persistence
        await authPool.query(`
            CREATE TABLE IF NOT EXISTS dashboards (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT 'My Dashboard',
                dataset_id TEXT,
                items JSONB NOT NULL DEFAULT '[]',
                layout JSONB,
                filters JSONB DEFAULT '[]',
                formatting JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        try { await authPool.query(`CREATE INDEX IF NOT EXISTS idx_dashboards_user ON dashboards (user_id)`); } catch {}
        console.log('[Auth] Dashboards table ready');

        // Global app settings (key → JSON value). Used by admin-controlled
        // features that must apply to ALL users, e.g. tab visibility.
        await authPool.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL DEFAULT '{}',
                updated_by TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('[Auth] App settings table ready');

        // Create user_activities table for global engagement tracking
        await authPool.query(`
            CREATE TABLE IF NOT EXISTS user_activities (
                id SERIAL PRIMARY KEY,
                user_id TEXT NOT NULL,
                user_name TEXT,
                user_email TEXT,
                user_role TEXT,
                action TEXT NOT NULL,
                details TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        try { await authPool.query(`CREATE INDEX IF NOT EXISTS idx_activities_user ON user_activities (user_id)`); } catch {}
        try { await authPool.query(`CREATE INDEX IF NOT EXISTS idx_activities_created ON user_activities (created_at)`); } catch {}
        try { await authPool.query(`CREATE INDEX IF NOT EXISTS idx_activities_action ON user_activities (action)`); } catch {}
        console.log('[Auth] User activities table ready');

        // Seed an admin account ONLY from the environment. This used to hard-code the
        // address and the password 'password', which meant every fresh database came up
        // with a known admin login — and the credentials sat in the source for anyone
        // with repository access to read.
        const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
        const adminPassword = process.env.ADMIN_PASSWORD || '';
        if (!adminEmail || !adminPassword) {
            console.log('[Auth] No ADMIN_EMAIL / ADMIN_PASSWORD set — skipping admin seed. '
                + 'Set both to create the first admin account.');
        } else if (adminPassword.length < 12) {
            console.error('[Auth] ADMIN_PASSWORD is shorter than 12 characters — refusing to seed.');
        } else {
            const adminHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
            const upsertResult = await authPool.query(
                `INSERT INTO users (id, email, name, role, password_hash)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (email) DO NOTHING`,
                ['admin_001', adminEmail, process.env.ADMIN_NAME || 'Administrator', 'admin', adminHash]
            );
            // ON CONFLICT DO NOTHING means an existing admin keeps its current password;
            // changing ADMIN_PASSWORD will not rotate it. Use the change-password route.
            console.log(upsertResult.rowCount > 0
                ? `[Auth] Seeded admin user: ${adminEmail}`
                : '[Auth] Admin user already exists — left unchanged.');
        }

        const { rows } = await authPool.query('SELECT COUNT(*) as count FROM users');
        console.log(`[Auth] ${rows[0].count} user(s) in database`);
        authDbStatus = 'ready';
    } catch (err) {
        console.error('[Auth] Failed to initialize tables:', err.message);
        authPool = null;
        authDbStatus = 'table_init_failed: ' + err.message;
    }
}

const app = express();
const PORT = process.env.PORT || 5002;
const operationalState = {
    startedAt: Date.now(),
    shuttingDown: false,
    requests: 0,
    errors: 0,
};
let httpServer = null;

// CORS Config — MUST be first, before helmet/rate-limiter
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'https://quickinsight.co.uk',
    'https://www.quickinsight.co.uk',
    process.env.FRONTEND_URL // Custom override URL
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Request-ID', 'X-QuickInsight-AI-Purpose'],
    exposedHeaders: ['X-Request-ID'],
}));

// Explicitly handle preflight for all routes
app.options('*', cors());

// Security Middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());

// Rate Limiting (100 requests per 15 minutes)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { success: false, error: 'Too many requests, please try again later.' },
    // Don't count preflight requests or the LLM proxy here. The LLM proxy has
    // its own tighter limiter below; counting it twice caused legitimate AI SQL
    // benchmark traffic to exhaust the general API budget and even block
    // unrelated session verification requests.
    skip: (req) => req.method === 'OPTIONS' || req.path === '/llm/chat',
});
// Apply rate limiting to all requests
app.use('/api/', limiter);

// Raise the body limit above the 100 kb default: AI features POST a rendered
// chart image (Smart Visual Insight) and dataset profile samples, which exceed
// the default and were rejected with 413 Payload Too Large.
app.use(express.json({ limit: '15mb' }));

// Correlate frontend, backend, Railway, and OpenRouter incidents without logging
// request bodies, credentials, SQL, or dataset samples.
app.use((req, res, next) => {
    const supplied = String(req.headers['x-request-id'] || '');
    const requestId = /^[a-zA-Z0-9_-]{8,80}$/.test(supplied)
        ? supplied
        : createConnectionId('req');
    const startedAt = Date.now();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    operationalState.requests += 1;
    res.on('finish', () => {
        if (res.statusCode >= 500) operationalState.errors += 1;
        if (req.path !== '/api/health' && req.path !== '/api/ready') {
            console.log(JSON.stringify({
                event: 'http_request',
                requestId,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }));
        }
    });
    next();
});

// API Key Middleware
const apiKeyMiddleware = (req, res, next) => {
    // Express strips the /api mount path inside this middleware. Keep liveness,
    // readiness, and authentication reachable by deployment probes and login.
    const publicPath = req.path === '/health'
        || req.path === '/ready'
        || req.path.startsWith('/auth/')
        || req.path === '/api/health'
        || req.path === '/api/ready'
        || req.path.startsWith('/api/auth/');
    if (!process.env.QuickInsight_API_KEY || publicPath) return next();

    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.QuickInsight_API_KEY) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key' });
    }
};
app.use('/api/', apiKeyMiddleware);

// ═══════════════════════════════════════════
// JWT AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════

// Initialize PostgreSQL auth database
(async () => {
    await initAuthDatabase();
})();

// Register a new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, name, password } = req.body;
        if (typeof email !== 'string' || typeof name !== 'string' || typeof password !== 'string'
            || !email.trim() || !name.trim() || !password) {
            return res.status(400).json({ success: false, error: 'Email, name, and password are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
        }

        const emailNorm = email.trim().toLowerCase();
        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const userId = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Public registration always creates a contributor. Administrative roles can
        // only be assigned through the authenticated admin endpoint below.
        const userRole = 'contributor';

        if (!authPool) {
            return res.status(503).json({ success: false, error: 'Database connection not available' });
        }

        // Check if user already exists
        const existing = await authPool.query('SELECT id FROM users WHERE email = $1', [emailNorm]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'User already exists' });
        }

        await authPool.query(
            'INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5)',
            [userId, emailNorm, name, userRole, hashedPassword]
        );

        const token = jwt.sign(
            { userId, email: emailNorm, role: userRole, sv: 1 },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: { id: userId, email: emailNorm, name, role: userRole }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }

        const emailNorm = email.trim().toLowerCase();
        let user;

        if (!authPool) {
            return res.status(503).json({ success: false, error: 'Database connection not available' });
        }

        const { rows } = await authPool.query('SELECT * FROM users WHERE email = $1', [emailNorm]);
        user = rows[0];

        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role, sv: user.session_version || 1 },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: { id: user.id, email: user.email, name: user.name, role: user.role }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// Change Password
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }

        let decoded;
        try {
            decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, error: 'Invalid or expired token' });
        }

        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Current and new passwords are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
        }

        if (!authPool) {
            return res.status(503).json({ success: false, error: 'Database connection not available' });
        }

        const { rows } = await authPool.query('SELECT * FROM users WHERE email = $1', [decoded.email]);
        const user = rows[0];
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await authPool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

        console.log(`[Auth] Password changed for: ${user.email}`);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

// Verify token (checks session_version for logout-all support)
app.get('/api/auth/verify', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        // Check session_version against DB (if DB available)
        if (authPool) {
            try {
                const { rows } = await authPool.query('SELECT session_version FROM users WHERE id = $1', [decoded.userId]);
                if (rows.length > 0) {
                    // Reject legacy tokens (no sv field) — they were issued before session versioning
                    if (decoded.sv === undefined || rows[0].session_version !== decoded.sv) {
                        return res.status(401).json({ success: false, error: 'Session invalidated. Please log in again.', code: 'SESSION_REVOKED' });
                    }
                }
            } catch { /* DB check failed, allow through */ }
        }

        res.json({ success: true, user: decoded });
    } catch {
        res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
});

// ── Admin: Logout user from all devices ──
app.post('/api/auth/logout-all-devices', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }

        let decoded;
        try {
            decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, error: 'Invalid or expired token' });
        }

        if (!authPool) {
            return res.status(503).json({ success: false, error: 'Database connection not available' });
        }

        // Use the current database role so a recently promoted admin can manage
        // users without waiting for an old JWT role snapshot to expire.
        const currentAdmin = await extractCurrentAdmin(req);
        if (!currentAdmin) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        decoded = currentAdmin;

        const { targetUserId } = req.body;

        if (targetUserId) {
            // Logout specific user
            await authPool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [targetUserId]);
            console.log(`[Auth] Admin ${decoded.email} revoked all sessions for user ${targetUserId}`);
            res.json({ success: true, message: 'User logged out from all devices' });
        } else {
            // Logout ALL users (including admin — they'll need to re-login)
            await authPool.query('UPDATE users SET session_version = session_version + 1');
            console.log(`[Auth] Admin ${decoded.email} revoked ALL user sessions`);
            res.json({ success: true, message: 'All users logged out from all devices' });
        }
    } catch (error) {
        console.error('Logout all devices error:', error);
        res.status(500).json({ success: false, error: 'Failed to logout from all devices' });
    }
});

// Store active connections
// Value: { type: 'mssql'|'raw'|'pg', pool: ConnectionPool|PgPool, rawConn: Connection, config: Object }
const connections = new Map();

async function resolveCurrentUser(req) {
    const tokenUser = extractUser(req);
    if (!tokenUser || !authPool || tokenUser.sv === undefined) return null;
    try {
        const { rows } = await authPool.query(
            'SELECT id, email, name, role, is_active, session_version FROM users WHERE id = $1',
            [tokenUser.userId]
        );
        const dbUser = rows[0];
        if (!dbUser || dbUser.is_active === false) return null;
        if (Number(dbUser.session_version) !== Number(tokenUser.sv)) return null;
        return {
            ...tokenUser,
            userId: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
        };
    } catch (error) {
        console.error('[Auth] Failed to resolve current user:', error.message);
        return null;
    }
}

async function requireAuthenticatedUser(req, res, next) {
    if (!authPool) {
        return res.status(503).json({ success: false, error: 'Authentication service is temporarily unavailable' });
    }
    const user = await resolveCurrentUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required or session expired' });
    }
    req.authUser = user;
    next();
}

function getOwnedConnection(req, connectionId) {
    const connection = connections.get(connectionId);
    if (!connection || !req.authUser || connection.ownerUserId !== req.authUser.userId) return null;
    connection.lastUsedAt = Date.now();
    return connection;
}

function safeConnectionConfig(body, defaultPort) {
    return {
        host: String(body.host || ''),
        port: validatePort(body.port, defaultPort),
        database: String(body.database || ''),
        username: String(body.username || ''),
        ssl: Boolean(body.ssl),
        useWindowsAuth: Boolean(body.useWindowsAuth),
    };
}

// ── Connection Health Check ──────────────────────────────────────
app.post('/api/check-connection', requireAuthenticatedUser, (req, res) => {
    const { connectionId } = req.body;
    const connection = getOwnedConnection(req, connectionId);
    res.json({ active: !!connection });
});

// ── AST-Based SQL Validation ─────────────────────────────────────
// Uses node-sql-parser for definitive statement-type checking.
// Falls back to regex if the parser doesn't support the dialect.
let sqlParser = null;
try {
    const { Parser } = require('node-sql-parser');
    sqlParser = new Parser();
    console.log('[Security] AST SQL parser loaded — using node-sql-parser for statement validation');
} catch (e) {
    console.warn('[Security] node-sql-parser not installed — falling back to regex SQL validation');
}

function validateSQL(sql) {
    // 1. Try AST-based validation (definitive)
    if (sqlParser) {
        try {
            const ast = sqlParser.astify(sql, { database: 'PostgreSQL' });
            const stmts = Array.isArray(ast) ? ast : [ast];
            for (const stmt of stmts) {
                if (stmt.type !== 'select') {
                    return { safe: false, reason: `Only SELECT statements allowed. Found: ${stmt.type.toUpperCase()}` };
                }
            }
            return { safe: true };
        } catch (parseErr) {
            // Parser failed (dialect mismatch) — fall through to regex
            console.warn(`[Security] AST parse failed, using regex fallback: ${parseErr.message}`);
        }
    }

    // 2. Regex fallback (for T-SQL or unparseable queries)
    const upper = sql.toUpperCase();
    if (!upper.trimStart().startsWith('SELECT') && !upper.trimStart().startsWith('WITH')) {
        return { safe: false, reason: 'Only SELECT queries are allowed for live execution' };
    }
    const blocked = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE'];
    for (const kw of blocked) {
        if (new RegExp(`\\b${kw}\\b`).test(upper)) {
            return { safe: false, reason: `Blocked: SQL contains disallowed keyword "${kw}"` };
        }
    }
    return { safe: true };
}

// Helper to query any connection type
function queryConnection(connection, query) {
    return new Promise((resolve, reject) => {
        if (connection.type === 'pg') {
            connection.pool.query(query)
                .then(result => resolve({ recordset: result.rows }))
                .catch(err => reject(err));
        } else if (connection.type === 'raw') {
            connection.rawConn.query(query, (err, rows) => {
                if (err) return reject(err);
                resolve({ recordset: rows });
            });
        } else {
            // mssql
            connection.pool.request().query(query)
                .then(result => resolve(result))
                .catch(err => reject(err));
        }
    });
}

// Test connection endpoint
app.post('/api/connect', requireAuthenticatedUser, async (req, res) => {
    try {
        const { host, port, database, username, password, useWindowsAuth } = req.body;

        // Ensure database name is present (default to master if not provided, though risky)
        const dbName = database || 'master';

        const allowPrivateHosts = !IS_PRODUCTION || process.env.ALLOW_PRIVATE_DB_HOSTS === 'true';
        await assertSafeDatabaseHost(host, port, { defaultPort: 1433, allowPrivate: allowPrivateHosts });
        const connectionId = createConnectionId('mssql');
        const connectionEntry = {
            config: safeConnectionConfig(req.body, 1433),
            ownerUserId: req.authUser.userId,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
        };

        if (useWindowsAuth) {
            if (!rawSql) {
                return res.status(400).json({ success: false, error: 'Windows Authentication is not available on this server (requires Windows + ODBC drivers). Use SQL Server Authentication instead.' });
            }
            // Use Raw msnodesqlv8 driver
            console.log('Using Raw msnodesqlv8 driver for Windows Auth');

            // Map localhost to . for named pipes if needed
            const serverName = (host === 'localhost') ? '.' : host;

            // ODBC Driver 17 is generally standard for modern SQL Server
            const connStr = `server=${serverName};Database=${dbName};Trusted_Connection=Yes;Driver={ODBC Driver 17 for SQL Server}`;

            console.log('Connecting with string:', connStr);

            await new Promise((resolve, reject) => {
                rawSql.open(connStr, (err, conn) => {
                    if (err) return reject(err);
                    connectionEntry.type = 'raw';
                    connectionEntry.rawConn = conn;
                    resolve();
                });
            });

        } else {
            // Use Standard mssql
            console.log('Using Standard mssql driver');
            const config = {
                server: host,
                port: parseInt(port) || 1433,
                database: dbName,
                user: username,
                password: password,
                connectionTimeout: 60000, // 60s — Azure SQL free tier can take 30-60s to wake from auto-pause
                requestTimeout: 30000,    // 30s per query
                options: {
                    encrypt: true,
                    trustServerCertificate: true,
                    enableArithAbort: true
                }
            };

            const pool = await sql.connect(config);
            connectionEntry.type = 'mssql';
            connectionEntry.pool = pool;
        }

        connections.set(connectionId, connectionEntry);

        res.json({
            success: true,
            connectionId,
            message: 'Connected successfully'
        });

    } catch (error) {
        console.error('Connection error raw:', error);
        // Try to extract a useful message
        let msg = error.message;

        // Handle raw driver errors which might be objects
        if (!msg || msg === '[object Object]') {
            if (error.sqlState) {
                msg = `SQL Error (${error.sqlState}): ${error.message || 'Unknown error'}`;
            } else {
                msg = JSON.stringify(error, null, 2);
            }
        }

        console.error('Sent error to client:', msg);

        res.status(500).json({
            success: false,
            error: msg
        });
    }
});

// Get database schema (list of tables)
app.post('/api/schema', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = getOwnedConnection(req, connectionId);

        if (!connection) {
            return res.status(400).json({ error: 'Invalid connection ID' });
        }

        const query = `
            SELECT 
                t.TABLE_NAME as name,
                ISNULL(p.rows, 0) as rows,
                t.TABLE_SCHEMA as category
            FROM 
                INFORMATION_SCHEMA.TABLES t
            LEFT JOIN 
                (SELECT object_id, SUM(rows) as rows FROM sys.partitions WHERE index_id < 2 GROUP BY object_id) p
                ON p.object_id = OBJECT_ID('[' + t.TABLE_SCHEMA + '].[' + t.TABLE_NAME + ']')
            WHERE 
                t.TABLE_TYPE = 'BASE TABLE'
            ORDER BY 
                t.TABLE_NAME
        `;

        const result = await queryConnection(connection, query);

        res.json({
            success: true,
            tables: result.recordset
        });
    } catch (error) {
        console.error('Schema error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Query table data
app.post('/api/query', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, tables } = req.body;
        const connection = getOwnedConnection(req, connectionId);

        if (!connection) {
            return res.status(400).json({ error: 'Invalid connection ID' });
        }

        const result = {};

        for (const tableName of tables) {
            // Sanitize table name to prevent SQL injection (Basic)
            const sanitizedTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');

            const query = `SELECT TOP 10000 * FROM [${sanitizedTable}]`;
            const tableResult = await queryConnection(connection, query);

            result[tableName] = tableResult.recordset;
        }

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('Query error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get columns for a specific table
app.post('/api/columns', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, table } = req.body;
        const connection = getOwnedConnection(req, connectionId);

        if (!connection) {
            return res.status(400).json({ error: 'Invalid connection ID' });
        }

        const sanitizedTable = table.replace(/[^a-zA-Z0-9_. ]/g, '');

        const query = `
            SELECT 
                c.COLUMN_NAME as name,
                c.DATA_TYPE as dataType,
                c.IS_NULLABLE as isNullable,
                ISNULL(c.CHARACTER_MAXIMUM_LENGTH, 0) as maxLength,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as isPK
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.TABLE_NAME, ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_NAME = '${sanitizedTable}'
            ORDER BY c.ORDINAL_POSITION
        `;

        const result = await queryConnection(connection, query);

        res.json({
            success: true,
            columns: result.recordset.map(r => ({
                ...r,
                isPK: r.isPK === 1 || r.isPK === true,
                isNullable: r.isNullable === 'YES'
            }))
        });
    } catch (error) {
        console.error('Columns error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get foreign key relationships across all tables
app.post('/api/foreign-keys', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = getOwnedConnection(req, connectionId);

        if (!connection) {
            return res.status(400).json({ error: 'Invalid connection ID' });
        }

        const query = `
            SELECT 
                tp.name AS fromTable,
                cp.name AS fromColumn,
                tr.name AS toTable,
                cr.name AS toColumn
            FROM sys.foreign_keys fk
            INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
            INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
            INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
            INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
            ORDER BY tp.name, cp.name
        `;

        const result = await queryConnection(connection, query);

        res.json({
            success: true,
            relationships: result.recordset
        });
    } catch (error) {
        console.error('Foreign keys error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════
// POSTGRESQL ENDPOINTS
// ═══════════════════════════════════════════

// PostgreSQL Connect
app.post('/api/pg/connect', requireAuthenticatedUser, async (req, res) => {
    try {
        const { host, port, database, username, password, ssl } = req.body;
        const allowPrivateHosts = !IS_PRODUCTION || process.env.ALLOW_PRIVATE_DB_HOSTS === 'true';
        await assertSafeDatabaseHost(host, port, { defaultPort: 5432, allowPrivate: allowPrivateHosts });
        const connectionId = createConnectionId('pg');

        const pool = new PgPool({
            host: host || 'localhost',
            port: parseInt(port) || 5432,
            database: database || 'postgres',
            user: username,
            password: password,
            ssl: ssl ? { rejectUnauthorized: false } : false,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        // Test the connection
        const client = await pool.connect();
        client.release();

        connections.set(connectionId, {
            type: 'pg',
            pool,
            config: safeConnectionConfig(req.body, 5432),
            ownerUserId: req.authUser.userId,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
        });

        res.json({
            success: true,
            connectionId,
            message: 'Connected to PostgreSQL successfully'
        });
    } catch (error) {
        console.error('PostgreSQL connection error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to connect to PostgreSQL'
        });
    }
});

// PostgreSQL Schema (list tables)
app.post('/api/pg/schema', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = getOwnedConnection(req, connectionId);
        if (!connection || connection.type !== 'pg') {
            return res.status(400).json({ error: 'Invalid PostgreSQL connection ID' });
        }

        const query = `
            SELECT table_name AS "TABLE_NAME", table_schema AS "TABLE_SCHEMA"
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type = 'BASE TABLE'
            ORDER BY table_schema, table_name
        `;
        const result = await queryConnection(connection, query);
        res.json({ success: true, tables: result.recordset });
    } catch (error) {
        console.error('PostgreSQL schema error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PostgreSQL Query (fetch table data)
app.post('/api/pg/query', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, tables } = req.body;
        const connection = getOwnedConnection(req, connectionId);
        if (!connection || connection.type !== 'pg') {
            return res.status(400).json({ error: 'Invalid PostgreSQL connection ID' });
        }

        const tableList = Array.isArray(tables) ? tables : [tables];
        const results = {};
        for (const table of tableList) {
            const sanitized = table.replace(/[^a-zA-Z0-9_.]/g, '');
            const query = `SELECT * FROM ${sanitized} LIMIT 50000`;
            const result = await queryConnection(connection, query);
            results[table] = result.recordset;
        }
        res.json({ success: true, data: results });
    } catch (error) {
        console.error('PostgreSQL query error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PostgreSQL Columns
app.post('/api/pg/columns', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, table } = req.body;
        const connection = getOwnedConnection(req, connectionId);
        if (!connection || connection.type !== 'pg') {
            return res.status(400).json({ error: 'Invalid PostgreSQL connection ID' });
        }

        const sanitized = table.replace(/[^a-zA-Z0-9_.]/g, '');
        const parts = sanitized.split('.');
        const tableName = parts.length > 1 ? parts[1] : parts[0];
        const schemaName = parts.length > 1 ? parts[0] : 'public';

        const query = `
            SELECT
                c.column_name AS "COLUMN_NAME",
                c.data_type AS "DATA_TYPE",
                c.character_maximum_length AS "CHARACTER_MAXIMUM_LENGTH",
                c.is_nullable AS "isNullable",
                CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS "isPK"
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_name = '${tableName}'
                    AND tc.table_schema = '${schemaName}'
            ) pk ON pk.column_name = c.column_name
            WHERE c.table_name = '${tableName}'
            AND c.table_schema = '${schemaName}'
            ORDER BY c.ordinal_position
        `;
        const result = await queryConnection(connection, query);
        res.json({
            success: true,
            columns: result.recordset.map(r => ({
                ...r,
                isPK: r.isPK === true || r.isPK === 't',
                isNullable: r.isNullable === 'YES'
            }))
        });
    } catch (error) {
        console.error('PostgreSQL columns error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PostgreSQL Foreign Keys
app.post('/api/pg/foreign-keys', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = getOwnedConnection(req, connectionId);
        if (!connection || connection.type !== 'pg') {
            return res.status(400).json({ error: 'Invalid PostgreSQL connection ID' });
        }

        const query = `
            SELECT
                tc.table_name AS "FK_TABLE",
                kcu.column_name AS "FK_COLUMN",
                ccu.table_name AS "PK_TABLE",
                ccu.column_name AS "PK_COLUMN",
                tc.constraint_name AS "FK_NAME"
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
            ORDER BY tc.table_name
        `;
        const result = await queryConnection(connection, query);
        res.json({ success: true, relationships: result.recordset });
    } catch (error) {
        console.error('PostgreSQL FK error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════
// LIVE SQL EXECUTION — Execute QueryPlan SQL against real PostgreSQL
// ═══════════════════════════════════════════
// This endpoint receives SQL generated by the QueryPlan compiler
// and executes it directly against the connected PostgreSQL database.
// Safety: Only SELECT statements, 30s timeout, 50K row limit.

app.post('/api/pg/execute-sql', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, sql } = req.body;

        if (!connectionId || !sql) {
            return res.status(400).json({
                success: false,
                error: 'connectionId and sql are required'
            });
        }

        const connection = getOwnedConnection(req, connectionId);
        if (!connection || connection.type !== 'pg') {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired PostgreSQL connection'
            });
        }

        // ── AST-Based SQL Safety Validation ──
        const validation = validateSQL(sql);
        if (!validation.safe) {
            return res.status(400).json({ success: false, error: validation.reason });
        }

        // ── Execute with timeout ──
        const startTime = Date.now();
        const client = await connection.pool.connect();

        try {
            // Set statement timeout (30 seconds)
            await client.query('SET statement_timeout = 30000');

            // Add row limit if not present
            let safeSql = sql;
            if (!sql.toUpperCase().includes('LIMIT')) {
                safeSql = `${sql}\nLIMIT 50000`;
            }

            const result = await client.query(safeSql);
            const executionTimeMs = Date.now() - startTime;

            const columns = result.fields ? result.fields.map(f => f.name) : [];

            console.log(`[LiveSQL] Executed in ${executionTimeMs}ms: ${result.rows.length} rows, ${columns.length} columns`);

            res.json({
                success: true,
                rows: result.rows,
                columns,
                rowCount: result.rows.length,
                executionTimeMs,
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('[LiveSQL] Execution error:', error);
        const errMsg = error.message || 'SQL execution failed';

        // Provide friendly error for common issues
        let friendlyError = errMsg;
        if (errMsg.includes('statement timeout')) {
            friendlyError = 'Query timed out (30s limit). Try adding filters or reducing data scope.';
        } else if (errMsg.includes('relation') && errMsg.includes('does not exist')) {
            friendlyError = `Table not found: ${errMsg}`;
        }

        res.status(500).json({
            success: false,
            error: friendlyError,
        });
    }
});

// ═══════════════════════════════════════════
// MSSQL LIVE SQL EXECUTION
// ═══════════════════════════════════════════
// Mirrors /api/pg/execute-sql for MSSQL connections.
// Safety: Only SELECT statements, 30s timeout, 50K row limit.

app.post('/api/execute-sql', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, sql } = req.body;

        if (!connectionId || !sql) {
            return res.status(400).json({
                success: false,
                error: 'connectionId and sql are required'
            });
        }

        const connection = getOwnedConnection(req, connectionId);
        if (!connection || (connection.type !== 'mssql' && connection.type !== 'raw')) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired MSSQL connection'
            });
        }

        // ── AST-Based SQL Safety Validation ──
        const validation = validateSQL(sql);
        if (!validation.safe) {
            return res.status(400).json({ success: false, error: validation.reason });
        }

        // ── Execute ──
        const startTime = Date.now();

        // Add row limit if not present
        let safeSql = sql;
        if (!sql.toUpperCase().includes('TOP') && !sql.toUpperCase().includes('FETCH')) {
            safeSql = sql.replace(/^SELECT/i, 'SELECT TOP 50000');
        }

        const result = await queryConnection(connection, safeSql);
        const executionTimeMs = Date.now() - startTime;
        const rows = result.recordset || [];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        console.log(`[LiveSQL-MSSQL] Executed in ${executionTimeMs}ms: ${rows.length} rows, ${columns.length} columns`);

        res.json({
            success: true,
            rows,
            columns,
            rowCount: rows.length,
            executionTimeMs,
        });
    } catch (error) {
        console.error('[LiveSQL-MSSQL] Execution error:', error);
        const errMsg = error.message || 'SQL execution failed';

        let friendlyError = errMsg;
        if (errMsg.includes('timeout')) {
            friendlyError = 'Query timed out. Try adding filters or reducing data scope.';
        } else if (errMsg.includes('Invalid object name')) {
            friendlyError = `Table not found: ${errMsg}`;
        }

        res.status(500).json({
            success: false,
            error: friendlyError,
        });
    }
});

// ═══════════════════════════════════════════
// UNIVERSAL LIVE REFRESH — Re-fetch table data for live datasets
// ═══════════════════════════════════════════
// Used by the frontend to refresh a live dataset's data from the source DB.
// Works for both MSSQL and PostgreSQL connections.

app.post('/api/refresh-data', requireAuthenticatedUser, async (req, res) => {
    try {
        const { connectionId, tables, dbType } = req.body;

        if (!connectionId || !tables || !Array.isArray(tables) || tables.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'connectionId and tables[] are required'
            });
        }

        const connection = getOwnedConnection(req, connectionId);
        if (!connection) {
            return res.status(400).json({
                success: false,
                error: 'Connection expired or invalid. Please reconnect to the database.'
            });
        }

        const startTime = Date.now();
        const result = {};

        for (const tableName of tables) {
            const sanitized = tableName.replace(/[^a-zA-Z0-9_.]/g, '');
            let query;

            if (connection.type === 'pg') {
                query = `SELECT * FROM ${sanitized} LIMIT 50000`;
            } else {
                // MSSQL
                query = `SELECT TOP 50000 * FROM [${sanitized.replace(/[^a-zA-Z0-9_]/g, '')}]`;
            }

            const tableResult = await queryConnection(connection, query);
            result[tableName] = tableResult.recordset || [];
        }

        const executionTimeMs = Date.now() - startTime;
        const totalRows = Object.values(result).reduce((sum, rows) => sum + rows.length, 0);

        console.log(`[LiveRefresh] Refreshed ${tables.length} tables (${totalRows} total rows) in ${executionTimeMs}ms`);

        res.json({
            success: true,
            data: result,
            executionTimeMs,
            totalRows,
        });
    } catch (error) {
        console.error('[LiveRefresh] Error:', error);

        let friendlyError = error.message || 'Refresh failed';
        if (friendlyError.includes('ECONN') || friendlyError.includes('terminated')) {
            friendlyError = 'Database connection lost. Please reconnect.';
        }

        res.status(500).json({
            success: false,
            error: friendlyError,
        });
    }
});

// ═══════════════════════════════════════════
// USER ACTIVITY TRACKING (Global — PostgreSQL)
// ═══════════════════════════════════════════

const VALID_ACTIVITY_ACTIONS = new Set([
    'login', 'logout', 'upload_dataset', 'ai_sql_query', 'builder_query',
    'smart_question', 'pin_to_dashboard', 'create_alert', 'tab_visit',
    'export_data', 'register'
]);

// POST /api/activities — Log a user activity (any authenticated user)
app.post('/api/activities', requireAuthenticatedUser, async (req, res) => {
    if (!authPool) return res.status(503).json({ success: false, error: 'Database not available' });

    const { action, details } = req.body || {};
    const user = req.authUser;
    if (!VALID_ACTIVITY_ACTIONS.has(action)) {
        return res.status(400).json({ success: false, error: 'Invalid activity action' });
    }
    const safeDetails = typeof details === 'string' ? details.slice(0, 2000) : null;

    try {
        await authPool.query(
            `INSERT INTO user_activities (user_id, user_name, user_email, user_role, action, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [user.userId, user.name || '', user.email || '', user.role || '', action, safeDetails]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[Activities] Failed to log activity:', err.message);
        res.status(500).json({ success: false, error: 'Failed to log activity' });
    }
});

// GET /api/activities — Fetch all activities (admin only)
app.get('/api/activities', async (req, res) => {
    if (!authPool) return res.status(503).json({ success: false, error: 'Database not available' });

    const admin = await extractCurrentAdmin(req);
    if (!admin) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    try {
        const limit = Math.min(parseInt(req.query.limit) || 5000, 10000);
        const days = parseInt(req.query.days) || 90;

        const { rows } = await authPool.query(
            `SELECT user_id, user_name, user_email, user_role, action, details,
                    EXTRACT(EPOCH FROM created_at) * 1000 AS timestamp
             FROM user_activities
             WHERE created_at >= NOW() - INTERVAL '${days} days'
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json({
            success: true,
            activities: rows.map(r => ({
                userId: r.user_id,
                userName: r.user_name,
                userEmail: r.user_email,
                userRole: r.user_role,
                action: r.action,
                details: r.details,
                timestamp: Math.round(parseFloat(r.timestamp)),
            })),
            total: rows.length,
        });
    } catch (err) {
        console.error('[Activities] Failed to fetch activities:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch activities' });
    }
});

// GET /api/activities/summary — Aggregated user summaries (admin only)
app.get('/api/activities/summary', async (req, res) => {
    if (!authPool) return res.status(503).json({ success: false, error: 'Database not available' });

    const admin = await extractCurrentAdmin(req);
    if (!admin) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    try {
        const { rows } = await authPool.query(`
            SELECT
                user_id,
                MAX(user_name) AS user_name,
                MAX(user_email) AS user_email,
                MAX(user_role) AS user_role,
                COUNT(*) AS total_actions,
                MAX(created_at) AS last_active,
                MIN(created_at) AS first_seen,
                COUNT(*) FILTER (WHERE action = 'login') AS login_count,
                COUNT(*) FILTER (WHERE action = 'ai_sql_query') AS ai_sql_queries,
                COUNT(*) FILTER (WHERE action = 'builder_query') AS builder_queries,
                COUNT(*) FILTER (WHERE action = 'upload_dataset') AS datasets_uploaded,
                COUNT(*) FILTER (WHERE action = 'pin_to_dashboard') AS dashboard_pins,
                COUNT(*) FILTER (WHERE action = 'create_alert') AS alerts_created,
                COUNT(*) FILTER (WHERE action = 'smart_question') AS smart_questions,
                COUNT(DISTINCT DATE(created_at)) AS active_days
            FROM user_activities
            GROUP BY user_id
            ORDER BY MAX(created_at) DESC
        `);

        const summaries = rows.map(r => ({
            userId: r.user_id,
            userName: r.user_name,
            userEmail: r.user_email,
            userRole: r.user_role,
            totalActions: parseInt(r.total_actions),
            lastActive: new Date(r.last_active).getTime(),
            firstSeen: new Date(r.first_seen).getTime(),
            loginCount: parseInt(r.login_count),
            aiSqlQueries: parseInt(r.ai_sql_queries),
            builderQueries: parseInt(r.builder_queries),
            datasetsUploaded: parseInt(r.datasets_uploaded),
            dashboardPins: parseInt(r.dashboard_pins),
            alertsCreated: parseInt(r.alerts_created),
            smartQuestions: parseInt(r.smart_questions),
            activeDays: parseInt(r.active_days),
            avgActionsPerDay: parseInt(r.active_days) > 0
                ? Math.round(parseInt(r.total_actions) / parseInt(r.active_days) * 10) / 10
                : 0,
            tabVisits: {},
        }));

        res.json({ success: true, summaries });
    } catch (err) {
        console.error('[Activities] Failed to get summaries:', err.message);
        res.status(500).json({ success: false, error: 'Failed to get summaries' });
    }
});

// ═══════════════════════════════════════════
// JWT AUTH MIDDLEWARE FOR AI ENDPOINTS
// ═══════════════════════════════════════════

/** Extract user from JWT — returns null if no valid token */
function extractUser(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch { return null; }
}

/**
 * Resolve admin permission from the canonical users table, not the role snapshot
 * embedded in a JWT. This makes role promotions/demotions effective immediately
 * while still requiring a valid, non-revoked token for the same database user.
 */
async function extractCurrentAdmin(req) {
    const tokenUser = extractUser(req);
    if (!tokenUser || !authPool || tokenUser.sv === undefined) return null;
    try {
        const { rows } = await authPool.query(
            'SELECT id, email, name, role, is_active, session_version FROM users WHERE id = $1',
            [tokenUser.userId]
        );
        const dbUser = rows[0];
        if (!dbUser || dbUser.role !== 'admin' || dbUser.is_active === false) return null;
        if (Number(dbUser.session_version) !== Number(tokenUser.sv)) return null;
        return {
            ...tokenUser,
            userId: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
        };
    } catch (error) {
        console.error('[Auth] Failed to resolve current admin role:', error.message);
        return null;
    }
}

/** Check if user is active and within the requested audited AI quota. */
async function checkAIQuota(userId, options = {}) {
    const action = options.action || 'ai_query';
    const limitOverride = Number(options.limitOverride);
    if (!authPool) {
        return IS_PRODUCTION
            ? { allowed: false, reason: 'Usage verification is temporarily unavailable' }
            : { allowed: true, remaining: 999, limit: 999 };
    }
    try {
        // Check if user is active
        const userResult = await authPool.query('SELECT is_active, daily_ai_limit FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return { allowed: false, reason: 'User not found' };
        const user = userResult.rows[0];
        if (!user.is_active) return { allowed: false, reason: 'Account suspended. Contact admin.' };

        // Count today's AI calls
        const todayResult = await authPool.query(
            `SELECT COUNT(*) as count FROM usage_logs WHERE user_id = $1 AND action = $2 AND created_at >= CURRENT_DATE`,
            [userId, action]
        );
        const used = parseInt(todayResult.rows[0].count);
        const limit = Number.isFinite(limitOverride) && limitOverride > 0
            ? Math.floor(limitOverride)
            : (user.daily_ai_limit || 50);
        const quotaLabel = action === 'ai_benchmark_query' ? 'Daily admin benchmark AI limit' : 'Daily AI limit';
        if (used >= limit) return { allowed: false, reason: `${quotaLabel} reached (${limit}/day). Contact admin.`, used, limit };
        return { allowed: true, remaining: limit - used, used, limit };
    } catch (err) {
        console.error('[Quota] Check failed:', err.message);
        return IS_PRODUCTION
            ? { allowed: false, reason: 'Usage verification is temporarily unavailable' }
            : { allowed: true, remaining: 999, limit: 999 };
    }
}

/** Log AI usage to database */
async function logAIUsage(userId, userEmail, action, tokensUsed, model, details) {
    if (!authPool) return;
    try {
        await authPool.query(
            'INSERT INTO usage_logs (user_id, user_email, action, tokens_used, model, details) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, userEmail, action, tokensUsed || 0, model || '', details || '']
        );
    } catch (err) {
        console.error('[Usage] Log failed:', err.message);
    }
}

// ═══════════════════════════════════════════
// LLM PROXY ENDPOINT (with auth + quota)
// ═══════════════════════════════════════════

const LLM_RATE_LIMIT = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { success: false, error: 'Too many AI requests. Please wait a moment.' }
});

// Coarse unauthenticated ingress protection. The authenticated standard and
// admin-benchmark limiters below apply the tighter role-appropriate windows.
const LLM_ENTRY_RATE_LIMIT = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { success: false, error: 'Too many AI requests. Please wait a moment.' }
});

const ADMIN_BENCHMARK_LLM_RATE_LIMIT = rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(30, Math.min(180, Number(process.env.ADMIN_BENCHMARK_LLM_RATE_LIMIT) || 90)),
    message: { success: false, error: 'Too many benchmark AI requests. Please wait a moment.' }
});
const ADMIN_BENCHMARK_DAILY_LIMIT = Math.max(
    150,
    // A benchmark question uses the full three-model route and semantic repair
    // may use one additional call. The default therefore supports a complete
    // 550-question evidence run without stopping midway.
    Math.min(5000, Number(process.env.ADMIN_BENCHMARK_DAILY_LIMIT) || 2500)
);

function isAdminBenchmarkRequest(req) {
    return req.authUser?.role === 'admin'
        && String(req.get('X-QuickInsight-AI-Purpose') || '').toLowerCase() === 'benchmark';
}

function applyLlmRateLimit(req, res, next) {
    const limiterForRequest = isAdminBenchmarkRequest(req)
        ? ADMIN_BENCHMARK_LLM_RATE_LIMIT
        : LLM_RATE_LIMIT;
    return limiterForRequest(req, res, next);
}

app.post('/api/llm/chat', LLM_ENTRY_RATE_LIMIT, requireAuthenticatedUser, applyLlmRateLimit, async (req, res) => {
    const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_KEY) {
        return res.status(500).json({ success: false, error: 'LLM service not configured' });
    }

    const user = req.authUser;
    const isBenchmark = isAdminBenchmarkRequest(req);
    const usageAction = isBenchmark ? 'ai_benchmark_query' : 'ai_query';

    // Benchmark calls are isolated from the normal per-user allowance. Only a
    // currently authenticated database admin can request this audited budget.
    const quota = await checkAIQuota(user.userId, {
        action: usageAction,
        limitOverride: isBenchmark ? ADMIN_BENCHMARK_DAILY_LIMIT : undefined,
    });
    if (!quota.allowed) {
        return res.status(429).json({ success: false, error: quota.reason, quotaExceeded: true });
    }

    try {
        const validated = validateLlmRequest(
            req.body,
            allowedLlmModels(process.env.ALLOWED_LLM_MODELS)
        );
        if (!validated.valid) {
            return res.status(400).json({ success: false, error: validated.error });
        }
        const { model, messages, max_tokens, temperature } = validated.value;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
                'X-Title': 'QuickInsight'
            },
            body: JSON.stringify({
                model,
                messages,
                max_tokens,
                temperature
            })
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error('[LLM Proxy] API error:', response.status, errorText);
            const providerError = parseProviderError(response.status, errorText);
            return res.status(response.status).json({
                success: false,
                error: providerError.message,
                providerStatus: response.status,
                providerErrorType: providerError.providerErrorType,
                providerErrorCategory: providerError.category,
                retryable: providerError.retryable,
                requestId: req.requestId,
            });
        }

        const data = await response.json();
        const tokensUsed = data.usage?.total_tokens || data.usage?.completion_tokens || 0;

        // Log usage
        await logAIUsage(
            user.userId,
            user.email,
            usageAction,
            tokensUsed,
            model,
            `${isBenchmark ? 'purpose:benchmark;' : ''}tokens:${tokensUsed}`
        );
        console.log(`[LLM] User ${user.email} — ${tokensUsed} tokens (${quota.remaining - 1} remaining today)`);

        // Include quota info in response
        data._quota = {
            remaining: quota.remaining - 1,
            limit: quota.limit,
            used: (quota.used || 0) + 1,
            scope: isBenchmark ? 'admin_benchmark' : 'standard',
        };
        res.json(data);
    } catch (error) {
        console.error('[LLM Proxy] Request failed:', error);
        res.status(500).json({ success: false, error: 'LLM request failed' });
    }
});

// ═══════════════════════════════════════════
// ADMIN: Usage Monitoring & User Control
// ═══════════════════════════════════════════

// Get all users with usage stats (admin only)
app.get('/api/admin/users', async (req, res) => {
    if (!authPool) return res.status(503).json({ error: 'Database not available' });
    const user = await extractCurrentAdmin(req);
    if (!user) return res.status(403).json({ error: 'Admin access required' });

    try {
        const { rows } = await authPool.query(`
            SELECT u.id, u.email, u.name, u.role, u.is_active, u.daily_ai_limit, u.created_at,
                   COALESCE(today.count, 0)::int as ai_queries_today,
                   COALESCE(today.tokens, 0)::int as tokens_today,
                   COALESCE(total.count, 0)::int as ai_queries_total,
                   COALESCE(total.tokens, 0)::int as tokens_total,
                   total.last_used
            FROM users u
            LEFT JOIN (
                SELECT user_id, COUNT(*) as count, SUM(tokens_used) as tokens
                FROM usage_logs WHERE action = 'ai_query' AND created_at >= CURRENT_DATE
                GROUP BY user_id
            ) today ON today.user_id = u.id
            LEFT JOIN (
                SELECT user_id, COUNT(*) as count, SUM(tokens_used) as tokens, MAX(created_at) as last_used
                FROM usage_logs WHERE action = 'ai_query'
                GROUP BY user_id
            ) total ON total.user_id = u.id
            ORDER BY total.tokens DESC NULLS LAST
        `);
        res.json({ success: true, users: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get usage logs (admin only, with optional user filter)
app.get('/api/admin/usage', async (req, res) => {
    const user = await extractCurrentAdmin(req);
    if (!user) return res.status(403).json({ error: 'Admin access required' });
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const { userId, days } = req.query;
        const d = parseInt(days) || 7;
        let query = `SELECT * FROM usage_logs WHERE created_at >= NOW() - INTERVAL '${d} days'`;
        const params = [];
        if (userId) { query += ` AND user_id = $1`; params.push(userId); }
        query += ` ORDER BY created_at DESC LIMIT 500`;
        const { rows } = await authPool.query(query, params);
        res.json({ success: true, logs: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create a user from the admin console (admin only)
app.post('/api/admin/users', async (req, res) => {
    if (!authPool) return res.status(503).json({ error: 'Database not available' });
    const admin = await extractCurrentAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    try {
        const { email, name, password, role } = req.body || {};
        if (typeof email !== 'string' || typeof name !== 'string' || typeof password !== 'string'
            || !email.trim() || !name.trim() || !password) {
            return res.status(400).json({ error: 'Email, name, and password are required' });
        }
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const userRole = typeof role === 'string' ? role : 'viewer';
        if (!['admin', 'contributor', 'viewer'].includes(userRole)) {
            return res.status(400).json({ error: 'Invalid user role' });
        }

        const emailNorm = email.trim().toLowerCase();
        const existing = await authPool.query('SELECT id FROM users WHERE email = $1', [emailNorm]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'User already exists' });

        const userId = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const { rows } = await authPool.query(
            `INSERT INTO users (id, email, name, role, password_hash)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, name, role, is_active, daily_ai_limit, created_at`,
            [userId, emailNorm, name.trim(), userRole, passwordHash]
        );
        console.log(`[Admin] ${admin.email} created ${userRole} user ${emailNorm}`);
        res.status(201).json({ success: true, user: rows[0] });
    } catch (err) {
        console.error('[Admin] Create user failed:', err.message);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Persist an admin-console role change (admin only).
app.patch('/api/admin/users/:id/role', async (req, res) => {
    if (!authPool) return res.status(503).json({ error: 'Database not available' });
    const admin = await extractCurrentAdmin(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const { role } = req.body || {};
    if (!['admin', 'contributor', 'viewer'].includes(role)) {
        return res.status(400).json({ error: 'Invalid user role' });
    }
    if (req.params.id === admin.userId) {
        return res.status(400).json({ error: 'You cannot change your own role' });
    }

    try {
        const { rows } = await authPool.query(
            'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role, is_active, daily_ai_limit, created_at',
            [role, req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        console.log(`[Admin] ${admin.email} changed role for user ${req.params.id} to ${role}`);
        res.json({ success: true, user: rows[0] });
    } catch (err) {
        console.error('[Admin] Update user role failed:', err.message);
        res.status(500).json({ error: 'Failed to update user role' });
    }
});

// Suspend/activate user (admin only)
app.post('/api/admin/toggle-user', async (req, res) => {
    const user = await extractCurrentAdmin(req);
    if (!user) return res.status(403).json({ error: 'Admin access required' });
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const { targetUserId, isActive } = req.body;
        if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
        await authPool.query('UPDATE users SET is_active = $1 WHERE id = $2', [isActive !== false, targetUserId]);
        // Also bump session_version to force re-login if suspending
        if (isActive === false) {
            await authPool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [targetUserId]);
        }
        console.log(`[Admin] ${user.email} ${isActive === false ? 'suspended' : 'activated'} user ${targetUserId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update user's daily AI limit (admin only)
app.post('/api/admin/set-quota', async (req, res) => {
    const user = await extractCurrentAdmin(req);
    if (!user) return res.status(403).json({ error: 'Admin access required' });
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const { targetUserId, dailyLimit } = req.body;
        if (!targetUserId || dailyLimit === undefined) return res.status(400).json({ error: 'targetUserId and dailyLimit required' });
        const limit = Math.max(0, Math.min(parseInt(dailyLimit), 1000));
        await authPool.query('UPDATE users SET daily_ai_limit = $1 WHERE id = $2', [limit, targetUserId]);
        console.log(`[Admin] ${user.email} set daily AI limit to ${limit} for user ${targetUserId}`);
        res.json({ success: true, dailyLimit: limit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Global tab visibility ────────────────────────────────
// Read: any authenticated user gets the admin-defined hidden tabs.
app.get('/api/settings/tab-visibility', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.json({ hiddenTabs: [] });
    try {
        const { rows } = await authPool.query(`SELECT value FROM app_settings WHERE key = 'tab_visibility'`);
        const hiddenTabs = Array.isArray(rows[0]?.value?.hiddenTabs) ? rows[0].value.hiddenTabs : [];
        res.json({ hiddenTabs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Write: admin sets the globally-hidden tabs for everyone.
app.post('/api/admin/tab-visibility', async (req, res) => {
    const user = await extractCurrentAdmin(req);
    if (!user) return res.status(403).json({ error: 'Admin access required' });
    if (!authPool) return res.status(503).json({ error: 'Database not available' });
    try {
        const hiddenTabs = Array.isArray(req.body?.hiddenTabs)
            ? req.body.hiddenTabs.filter(t => typeof t === 'string').slice(0, 100)
            : [];
        await authPool.query(
            `INSERT INTO app_settings (key, value, updated_by, updated_at)
             VALUES ('tab_visibility', $1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
            [JSON.stringify({ hiddenTabs }), user.email]
        );
        console.log(`[Admin] ${user.email} set global hidden tabs: [${hiddenTabs.join(', ')}]`);
        res.json({ success: true, hiddenTabs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Remembered column classifications ────────────────────
// A self-improving map of column corrections, SCOPED BY DATASET SIGNATURE so a
// correction to "region" in one dataset never rewrites a same-named column in an
// unrelated dataset. Shape: { [datasetSignature]: { [columnNameLower]: role } }.
// The signature is a stable fingerprint of the dataset's column-name set, so the
// same schema re-applies its corrections while different schemas stay isolated.
const VALID_ROLES = new Set(['METRIC', 'DIMENSION', 'DATE', 'BOOLEAN', 'ID', 'UNKNOWN']);
const SIGNATURE_RE = /^[a-z0-9]{1,64}$/; // hashed signature — lowercase alnum only

app.get('/api/settings/column-corrections', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.json({ corrections: {} });
    try {
        const { rows } = await authPool.query(`SELECT value FROM app_settings WHERE key = 'column_corrections'`);
        const value = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value : {};
        // Return only the signature-scoped sub-maps (objects). Any legacy flat
        // string entries from the pre-scoping version are ignored.
        const scoped = {};
        for (const [sig, sub] of Object.entries(value)) {
            if (SIGNATURE_RE.test(sig) && sub && typeof sub === 'object' && !Array.isArray(sub)) scoped[sig] = sub;
        }
        res.json({ corrections: scoped });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/column-corrections', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.status(503).json({ error: 'Database not available' });
    try {
        const signature = req.body?.signature;
        const input = req.body?.corrections;
        if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
            return res.status(400).json({ error: 'Missing or invalid dataset signature' });
        }
        const clean = {};
        if (input && typeof input === 'object') {
            for (const [name, role] of Object.entries(input)) {
                if (typeof name === 'string' && name && VALID_ROLES.has(role)) {
                    clean[name.toLowerCase().trim()] = role;
                }
            }
        }
        if (Object.keys(clean).length === 0) return res.status(400).json({ error: 'No valid corrections provided' });

        // Atomically deep-merge into the signature's bucket. A plain JSONB || is
        // shallow (it would replace the whole bucket), so merge the bucket itself:
        // value || { sig: (existing bucket || new corrections) } — one statement,
        // no read-modify-write race between concurrent writers.
        await authPool.query(
            `INSERT INTO app_settings (key, value, updated_by, updated_at)
             VALUES ('column_corrections', jsonb_build_object($1::text, $2::jsonb), $3, NOW())
             ON CONFLICT (key) DO UPDATE SET
                value = app_settings.value || jsonb_build_object($1::text, COALESCE(app_settings.value->$1, '{}'::jsonb) || $2::jsonb),
                updated_by = $3, updated_at = NOW()`,
            [signature, JSON.stringify(clean), user.email]
        );
        console.log(`[Corrections] ${user.email} remembered for ${signature}: ${Object.entries(clean).map(([n, r]) => `${n}=${r}`).join(', ')}`);
        res.json({ success: true, saved: clean, signature });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════
// CLEANUP: Stale connection reaper (Fix #17)
// ═══════════════════════════════════════════
async function closeConnection(conn) {
    if (conn.type === 'mssql' && conn.pool) await conn.pool.close();
    if (conn.type === 'raw' && conn.rawConn) conn.rawConn.close();
    if (conn.type === 'pg' && conn.pool) await conn.pool.end();
}

const connectionReaper = setInterval(() => {
    const MAX_IDLE_MS = 30 * 60 * 1000;
    const now = Date.now();
    for (const [id, conn] of connections) {
        const lastActive = Number(conn.lastUsedAt || conn.createdAt || now);
        if (now - lastActive > MAX_IDLE_MS) {
            console.log(`[Cleanup] Closing stale connection ${id}`);
            closeConnection(conn).catch(error => {
                console.error('[Cleanup] Connection close failed:', error.message);
            });
            connections.delete(id);
        }
    }
}, 5 * 60 * 1000);
connectionReaper.unref?.();

// Liveness: the process can accept HTTP. No dependency details are exposed.
app.get('/api/health', (req, res) => {
    const live = !operationalState.shuttingDown;
    res.status(live ? 200 : 503).json({
        status: live ? 'ok' : 'shutting_down',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - operationalState.startedAt) / 1000),
    });
});

// Readiness: traffic is safe only after the canonical auth database is usable.
app.get('/api/ready', async (req, res) => {
    if (operationalState.shuttingDown || !authPool || authDbStatus !== 'ready') {
        return res.status(503).json({ status: 'not_ready' });
    }
    try {
        await Promise.race([
            authPool.query('SELECT 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('readiness timeout')), 2000)),
        ]);
        return res.json({
            status: 'ready',
            ai: process.env.OPENROUTER_API_KEY ? 'configured' : 'unavailable',
        });
    } catch (error) {
        console.error('[Readiness] Dependency check failed:', error.message);
        return res.status(503).json({ status: 'not_ready' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// AI SEMANTIC PROFILING ENDPOINT
// Proxies AI profiling requests to OpenRouter LLM API
// ═══════════════════════════════════════════════════════════════════

const aiProfileLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,   // 5 min window
    max: 20,                    // 20 requests per window
    message: { error: 'AI profiling rate limit exceeded. Please wait.' }
});

app.post('/api/ai/profile-dataset', aiProfileLimiter, requireAuthenticatedUser, async (req, res) => {
    try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            console.error('[AI Profile] OPENROUTER_API_KEY not set');
            return res.status(500).json({ error: 'LLM API key not configured. Set OPENROUTER_API_KEY in backend/.env' });
        }

        const user = req.authUser;

        // Check quota
        const quota = await checkAIQuota(user.userId);
        if (!quota.allowed) {
            return res.status(429).json({ error: quota.reason, quotaExceeded: true });
        }

        const { prompt } = req.body;
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid prompt' });
        }
        if (prompt.length > 200_000) {
            return res.status(413).json({ error: 'Dataset profile request is too large' });
        }

        console.log(`[AI Profile] User ${user.email} — sending prompt (${prompt.length} chars)`);

        // Sanitize prompt: Node.js 20 undici fetch rejects non-ASCII in ByteString
        const sanitizedPrompt = prompt.replace(/[^\x00-\x7F]/g, c => {
            if (c === '\u2014' || c === '\u2013') return '-';
            if (c === '\u201C' || c === '\u201D') return '"';
            if (c === '\u2018' || c === '\u2019') return "'";
            if (c === '\u2026') return '...';
            return '';
        });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:3000',
                'X-Title': 'QuickInsight'
            },
            body: JSON.stringify({
                model: 'google/gemini-2.5-flash',
                messages: [
                    { role: 'system', content: 'You are an expert Data Architect. Respond with ONLY valid JSON - no markdown fences, no explanations, no commentary. Just the raw JSON object.' },
                    { role: 'user', content: sanitizedPrompt }
                ],
                temperature: 0.1,
                max_tokens: 4096
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[AI Profile] OpenRouter error ${response.status}:`, errorText);
            return res.status(502).json({ error: `LLM API returned ${response.status}` });
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        const tokensUsed = data?.usage?.total_tokens || 0;

        // Log usage
        await logAIUsage(user.userId, user.email, 'ai_query', tokensUsed, 'google/gemini-2.5-flash', 'profile-dataset');

        if (!content) {
            console.warn('[AI Profile] Empty LLM response');
            return res.status(502).json({ error: 'Empty response from LLM' });
        }

        // Try to parse JSON from the response
        let jsonStr = content.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            jsonStr = fenceMatch[1].trim();
        }

        try {
            const parsed = JSON.parse(jsonStr);
            console.log(`[AI Profile] ✅ User ${user.email} — ${tokensUsed} tokens (domain: ${parsed.domain || 'unknown'})`);
            return res.json(parsed);
        } catch (parseErr) {
            console.warn('[AI Profile] Failed to parse LLM JSON, returning raw text');
            return res.json({ rawText: jsonStr, parseError: true });
        }

    } catch (error) {
        console.error('[AI Profile] Unexpected error:', error.message);
        res.status(500).json({ error: 'Internal profiling error' });
    }
});

// ═══════════════════════════════════════════
// DASHBOARD CLOUD PERSISTENCE
// ═══════════════════════════════════════════

/** GET /api/dashboards — List all dashboards for the authenticated user */
app.get('/api/dashboards', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const { rows } = await authPool.query(
            'SELECT id, name, dataset_id, items, layout, filters, formatting, created_at, updated_at FROM dashboards WHERE user_id = $1 ORDER BY updated_at DESC',
            [user.userId]
        );
        res.json({ dashboards: rows });
    } catch (err) {
        console.error('[Dashboards] List error:', err.message);
        res.status(500).json({ error: 'Failed to load dashboards' });
    }
});

/** GET /api/dashboards/:id — Get a single dashboard by ID */
app.get('/api/dashboards/:id', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const { rows } = await authPool.query(
            'SELECT * FROM dashboards WHERE id = $1 AND user_id = $2',
            [req.params.id, user.userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Dashboard not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('[Dashboards] Get error:', err.message);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

/** POST /api/dashboards — Create or full-save a dashboard */
app.post('/api/dashboards', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    const { id, name, dataset_id, items, layout, filters, formatting } = req.body;
    if (!id) return res.status(400).json({ error: 'Dashboard ID is required' });

    try {
        await authPool.query(
            `INSERT INTO dashboards (id, user_id, name, dataset_id, items, layout, filters, formatting, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                dataset_id = EXCLUDED.dataset_id,
                items = EXCLUDED.items,
                layout = EXCLUDED.layout,
                filters = EXCLUDED.filters,
                formatting = EXCLUDED.formatting,
                updated_at = NOW()`,
            [
                id,
                user.userId,
                name || 'My Dashboard',
                dataset_id || null,
                JSON.stringify(items || []),
                JSON.stringify(layout || null),
                JSON.stringify(filters || []),
                JSON.stringify(formatting || {})
            ]
        );
        console.log(`[Dashboards] Saved dashboard "${name || id}" for user ${user.email}`);
        res.json({ success: true, id });
    } catch (err) {
        console.error('[Dashboards] Save error:', err.message);
        res.status(500).json({ error: 'Failed to save dashboard', detail: err.message });
    }
});

/** DELETE /api/dashboards/:id — Delete a dashboard */
app.delete('/api/dashboards/:id', requireAuthenticatedUser, async (req, res) => {
    const user = req.authUser;
    if (!authPool) return res.status(503).json({ error: 'Database not available' });

    try {
        const result = await authPool.query(
            'DELETE FROM dashboards WHERE id = $1 AND user_id = $2',
            [req.params.id, user.userId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Dashboard not found' });
        console.log(`[Dashboards] Deleted dashboard ${req.params.id} for user ${user.email}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Dashboards] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete dashboard' });
    }
});

httpServer = app.listen(PORT, () => {
    console.log(`🚀 QuickInsight Backend API running on http://localhost:${PORT}`);
    console.log(`📊 SQL Server connector ready (Hybrid Mode: mssql + raw msnodesqlv8)`);
    console.log(`🐘 PostgreSQL connector ready`);
});

let shutdownPromise = null;
async function gracefulShutdown(signal, exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    operationalState.shuttingDown = true;
    shutdownPromise = (async () => {
        console.log(`[Shutdown] ${signal} received; draining requests and closing resources`);
        clearInterval(connectionReaper);
        const forceExit = setTimeout(() => {
            console.error('[Shutdown] Forced exit after 15 seconds');
            process.exit(1);
        }, 15000);
        forceExit.unref?.();

        if (httpServer) {
            await new Promise(resolve => httpServer.close(resolve));
        }
        const closes = [...connections.values()].map(conn => closeConnection(conn));
        await Promise.allSettled(closes);
        connections.clear();
        if (authPool) {
            await authPool.end().catch(error => {
                console.error('[Shutdown] Auth database close failed:', error.message);
            });
        }
        clearTimeout(forceExit);
        process.exit(exitCode);
    })();
    return shutdownPromise;
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', error => {
    console.error('[Fatal] Uncaught exception:', error);
    gracefulShutdown('uncaughtException', 1);
});
process.on('unhandledRejection', error => {
    console.error('[Fatal] Unhandled rejection:', error);
    gracefulShutdown('unhandledRejection', 1);
});
