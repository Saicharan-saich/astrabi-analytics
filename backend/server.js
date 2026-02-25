require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const sql = require('mssql');
const rawSql = require('msnodesqlv8');
const { Pool: PgPool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'astrabi-dev-secret-change-in-production';
const BCRYPT_ROUNDS = 12;

const app = express();
const PORT = process.env.PORT || 5002;

// Security Middleware
app.use(helmet());
app.use(compression());

// Rate Limiting (100 requests per 15 minutes)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { success: false, error: 'Too many requests, please try again later.' }
});
// Apply rate limiting to all requests
app.use('/api/', limiter);

// CORS Config
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    process.env.FRONTEND_URL // Azure Static Web App URL
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
    credentials: true
}));

app.use(express.json());

// API Key Middleware
const apiKeyMiddleware = (req, res, next) => {
    // Skip if no key configured (Dev mode), health check, or auth endpoints
    if (!process.env.ASTRABI_API_KEY || req.path === '/api/health' || req.path.startsWith('/api/auth')) return next();

    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.ASTRABI_API_KEY) {
        next();
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized: Invalid API Key' });
    }
};
app.use('/api/', apiKeyMiddleware);

// ═══════════════════════════════════════════
// JWT AUTHENTICATION ENDPOINTS
// ═══════════════════════════════════════════

// In-memory user store (swap for a database in production)
const users = new Map();

// Register a new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, name, password, role } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ success: false, error: 'Email, name, and password are required' });
        }

        if (users.has(email)) {
            return res.status(400).json({ success: false, error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const user = {
            id: Date.now().toString(),
            email,
            name,
            role: role || 'viewer',
            passwordHash: hashedPassword,
            createdAt: new Date().toISOString()
        };

        users.set(email, user);

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
            user: { id: user.id, email: user.email, name: user.name, role: user.role }
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

        const user = users.get(email);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
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

// Verify token
app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'No token provided' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({ success: true, user: decoded });
    } catch {
        res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
});

// Store active connections
// Value: { type: 'mssql'|'raw'|'pg', pool: ConnectionPool|PgPool, rawConn: Connection, config: Object }
const connections = new Map();

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
app.post('/api/connect', async (req, res) => {
    try {
        const { host, port, database, username, password, useWindowsAuth } = req.body;

        // Ensure database name is present (default to master if not provided, though risky)
        const dbName = database || 'master';

        let connectionId = Date.now().toString();
        let connectionEntry = { config: req.body };

        if (useWindowsAuth) {
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
                options: {
                    encrypt: false,
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
app.post('/api/schema', async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = connections.get(connectionId);

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
app.post('/api/query', async (req, res) => {
    try {
        const { connectionId, tables } = req.body;
        const connection = connections.get(connectionId);

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
app.post('/api/columns', async (req, res) => {
    try {
        const { connectionId, table } = req.body;
        const connection = connections.get(connectionId);

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
app.post('/api/foreign-keys', async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = connections.get(connectionId);

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
app.post('/api/pg/connect', async (req, res) => {
    try {
        const { host, port, database, username, password, ssl } = req.body;
        const connectionId = 'pg_' + Date.now().toString();

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

        connections.set(connectionId, { type: 'pg', pool, config: req.body });

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
app.post('/api/pg/schema', async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = connections.get(connectionId);
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
app.post('/api/pg/query', async (req, res) => {
    try {
        const { connectionId, tables } = req.body;
        const connection = connections.get(connectionId);
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
app.post('/api/pg/columns', async (req, res) => {
    try {
        const { connectionId, table } = req.body;
        const connection = connections.get(connectionId);
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
app.post('/api/pg/foreign-keys', async (req, res) => {
    try {
        const { connectionId } = req.body;
        const connection = connections.get(connectionId);
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 Astrabi Backend API running on http://localhost:${PORT}`);
    console.log(`📊 SQL Server connector ready (Hybrid Mode: mssql + raw msnodesqlv8)`);
    console.log(`🐘 PostgreSQL connector ready`);
});

// Cleanup on shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    for (const [id, conn] of connections) {
        if (conn.type === 'mssql' && conn.pool) await conn.pool.close();
        if (conn.type === 'raw' && conn.rawConn) conn.rawConn.close();
        if (conn.type === 'pg' && conn.pool) await conn.pool.end();
    }
    process.exit(0);
});
