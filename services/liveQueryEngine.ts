// ═══════════════════════════════════════════════════════════════════
// Live Query Engine — Execute SQL against real PostgreSQL databases
//
// When a PostgreSQL connection is active, this service sends
// QueryPlan-compiled SQL directly to the database via the backend
// /api/pg/execute-sql endpoint.
//
// Architecture:
// 1. ConnectorsPanel establishes a PG connection → stores connectionId
// 2. QueryPlan compiles SQL via sqlCompiler.ts
// 3. This service sends that SQL to the backend
// 4. Backend executes against the real PostgreSQL database
// 5. Results are returned in the same format as executeQueryPlan
// ═══════════════════════════════════════════════════════════════════

// ── Connection State ─────────────────────────────────────────────

interface LiveConnection {
    connectionId: string;
    dbType: 'postgres' | 'mssql';
    host: string;
    database: string;
}

let _activeConnection: LiveConnection | null = null;

/**
 * Set the active live database connection.
 * Called by ConnectorsPanel after successful connection.
 */
export function setLiveConnection(conn: LiveConnection | null): void {
    _activeConnection = conn;
    if (conn) {
        console.log(`[LiveQuery] Active connection: ${conn.dbType}://${conn.host}/${conn.database} (${conn.connectionId})`);
    } else {
        console.log('[LiveQuery] Connection cleared');
    }
}

/**
 * Get the current active connection (if any).
 */
export function getLiveConnection(): LiveConnection | null {
    return _activeConnection;
}

/**
 * Check if a live database connection is active.
 */
export function hasLiveConnection(): boolean {
    return _activeConnection !== null;
}

// ── Query Execution ──────────────────────────────────────────────

export interface LiveQueryResult {
    success: boolean;
    rows: any[];
    columns: string[];
    rowCount: number;
    executionTimeMs: number;
    error?: string;
}

/**
 * Execute a SQL query against the connected PostgreSQL database.
 *
 * @param sql - SQL string (from sqlCompiler.ts)
 * @returns LiveQueryResult with rows, columns, timing info
 */
export async function executeLiveSQL(sql: string): Promise<LiveQueryResult> {
    if (!_activeConnection) {
        return {
            success: false,
            rows: [],
            columns: [],
            rowCount: 0,
            executionTimeMs: 0,
            error: 'No active database connection',
        };
    }

    const startTime = performance.now();

    try {
        // Determine backend URL from environment or default
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5002';

        const response = await fetch(`${backendUrl}/api/pg/execute-sql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                connectionId: _activeConnection.connectionId,
                sql,
            }),
        });

        const data = await response.json();
        const executionTimeMs = Math.round(performance.now() - startTime);

        if (!data.success) {
            return {
                success: false,
                rows: [],
                columns: data.columns || [],
                rowCount: 0,
                executionTimeMs,
                error: data.error || 'Query execution failed',
            };
        }

        console.log(`[LiveQuery] Executed in ${executionTimeMs}ms: ${data.rowCount} rows`);

        return {
            success: true,
            rows: data.rows,
            columns: data.columns,
            rowCount: data.rowCount,
            executionTimeMs: data.executionTimeMs || executionTimeMs,
        };
    } catch (err) {
        const executionTimeMs = Math.round(performance.now() - startTime);
        const errorMsg = err instanceof Error ? err.message : String(err);

        console.error(`[LiveQuery] Network error (${executionTimeMs}ms):`, errorMsg);

        return {
            success: false,
            rows: [],
            columns: [],
            rowCount: 0,
            executionTimeMs,
            error: `Connection error: ${errorMsg}`,
        };
    }
}

/**
 * Get status of the live connection for UI display.
 */
export function getLiveConnectionStatus(): {
    connected: boolean;
    host?: string;
    database?: string;
    dbType?: string;
} {
    if (!_activeConnection) {
        return { connected: false };
    }
    return {
        connected: true,
        host: _activeConnection.host,
        database: _activeConnection.database,
        dbType: _activeConnection.dbType,
    };
}
