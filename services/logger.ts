// ═══════════════════════════════════════════════════════════════════
// Structured Logger — Production-Ready Logging for Astrabi Analytics
//
// Replaces raw console.log/warn/error calls with a leveled logger
// that can be silenced in production via LOG_LEVEL.
//
// Usage:
//   import { logger } from '../logger';
//   logger.debug('[Pipeline]', 'Step 1 complete');
//   logger.info('[SQL Compiler]', 'Query compiled', { rows: 42 });
//   logger.warn('[Comparison]', 'Fallback used');
//   logger.error('[DuckDB]', 'Table load failed', err);
// ═══════════════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

// Default: 'info' in production, 'debug' in development
let currentLevel: LogLevel =
    typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
        ? 'info'
        : 'debug';

// In-memory audit log for the last N entries (ring buffer)
const MAX_LOG_ENTRIES = 200;
const logBuffer: LogEntry[] = [];

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    data?: any;
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
    return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function addToBuffer(entry: LogEntry): void {
    if (logBuffer.length >= MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    logBuffer.push(entry);
}

function log(level: LogLevel, source: string, message: string, data?: any): void {
    const entry: LogEntry = {
        timestamp: formatTimestamp(),
        level,
        source,
        message,
        data,
    };

    // Always buffer (even if not printing) — useful for audit/debug
    addToBuffer(entry);

    if (!shouldLog(level)) return;

    const prefix = `${entry.timestamp} [${level.toUpperCase().padEnd(5)}]${source ? ' ' + source : ''}`;

    switch (level) {
        case 'debug':
            console.debug(`%c${prefix}`, 'color: #888', message, data !== undefined ? data : '');
            break;
        case 'info':
            console.log(`${prefix} ${message}`, data !== undefined ? data : '');
            break;
        case 'warn':
            console.warn(`${prefix} ${message}`, data !== undefined ? data : '');
            break;
        case 'error':
            console.error(`${prefix} ${message}`, data !== undefined ? data : '');
            break;
    }
}

export const logger = {
    debug: (source: string, message: string, data?: any) => log('debug', source, message, data),
    info: (source: string, message: string, data?: any) => log('info', source, message, data),
    warn: (source: string, message: string, data?: any) => log('warn', source, message, data),
    error: (source: string, message: string, data?: any) => log('error', source, message, data),

    /** Change the minimum log level at runtime */
    setLevel: (level: LogLevel) => { currentLevel = level; },

    /** Get the current log level */
    getLevel: (): LogLevel => currentLevel,

    /** Get the in-memory log buffer (last 200 entries) */
    getBuffer: (): readonly LogEntry[] => logBuffer,

    /** Clear the in-memory log buffer */
    clearBuffer: () => { logBuffer.length = 0; },

    /** Get entries filtered by level */
    getEntries: (level?: LogLevel): LogEntry[] => {
        if (!level) return [...logBuffer];
        return logBuffer.filter(e => e.level === level);
    },
};
