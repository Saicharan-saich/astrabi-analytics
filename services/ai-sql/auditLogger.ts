/**
 * Audit Logger — Observability layer for AI SQL queries
 *
 * Logs every pipeline execution to localStorage for debugging,
 * analytics, and traceability. Stores: question, plan, SQL,
 * execution time, confidence, chart type, and errors.
 */

import { AuditEntry } from './types';

const STORAGE_KEY = 'QuickInsight_ai_sql_audit_log';
const MAX_ENTRIES = 200;

/**
 * Log an audit entry to localStorage.
 */
export function logAuditEntry(entry: AuditEntry): void {
    try {
        const existing = getAuditLog();
        existing.unshift(entry); // Newest first

        // Cap at MAX_ENTRIES
        const trimmed = existing.slice(0, MAX_ENTRIES);

        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
        console.log(`[Audit] Logged query: "${entry.question}" (${entry.confidence.level} confidence, ${entry.executionTimeMs}ms)`);
    } catch (err) {
        console.warn('[Audit] Failed to log entry:', err);
    }
}

/**
 * Get the full audit log (newest first).
 */
export function getAuditLog(): AuditEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/**
 * Clear the audit log.
 */
export function clearAuditLog(): void {
    localStorage.removeItem(STORAGE_KEY);
}

/**
 * Get summary statistics from the audit log.
 */
export function getAuditStats(): {
    totalQueries: number;
    avgConfidence: number;
    avgExecutionTimeMs: number;
    errorRate: number;
    topChartTypes: { type: string; count: number }[];
    confidenceDistribution: { high: number; medium: number; low: number };
} {
    const log = getAuditLog();

    if (log.length === 0) {
        return {
            totalQueries: 0,
            avgConfidence: 0,
            avgExecutionTimeMs: 0,
            errorRate: 0,
            topChartTypes: [],
            confidenceDistribution: { high: 0, medium: 0, low: 0 },
        };
    }

    const totalQueries = log.length;
    const avgConfidence = log.reduce((sum, e) => sum + e.confidence.score, 0) / totalQueries;
    const avgExecutionTimeMs = log.reduce((sum, e) => sum + e.executionTimeMs, 0) / totalQueries;
    const errorRate = log.filter(e => e.error).length / totalQueries;

    // Chart type frequency
    const chartCounts: Record<string, number> = {};
    for (const e of log) {
        chartCounts[e.chartType] = (chartCounts[e.chartType] || 0) + 1;
    }
    const topChartTypes = Object.entries(chartCounts)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

    // Confidence distribution
    const confidenceDistribution = {
        high: log.filter(e => e.confidence.level === 'high').length,
        medium: log.filter(e => e.confidence.level === 'medium').length,
        low: log.filter(e => e.confidence.level === 'low').length,
    };

    return {
        totalQueries,
        avgConfidence: Math.round(avgConfidence),
        avgExecutionTimeMs: Math.round(avgExecutionTimeMs),
        errorRate: Math.round(errorRate * 100) / 100,
        topChartTypes,
        confidenceDistribution,
    };
}
