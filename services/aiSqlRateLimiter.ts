/**
 * AI SQL Rate Limiter
 *
 * Enforces per-user query limits based on license/role.
 * - Contributor (default): 10 queries per 24-hour rolling window
 * - Admin: Unlimited
 * - Viewer: Blocked (0 queries)
 *
 * Usage data is persisted via the auth store (Zustand + IndexedDB).
 */

import { User, UserRole } from '../types';
import { isGuestUser } from './guestAccessPolicy';

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const GUEST_USAGE_STORAGE_KEY = 'quickinsight_guest_ai_sql_usage_v1';

function readStoredGuestUsage(): User['aiSqlUsage'] | undefined {
    if (typeof localStorage === 'undefined') return undefined;
    try {
        const parsed = JSON.parse(localStorage.getItem(GUEST_USAGE_STORAGE_KEY) || 'null');
        if (!parsed || !Number.isFinite(parsed.count) || !Number.isFinite(parsed.windowStart)) return undefined;
        return { count: Math.max(0, Math.floor(parsed.count)), windowStart: parsed.windowStart };
    } catch {
        return undefined;
    }
}

export function getAiSqlUsage(user: User | null): User['aiSqlUsage'] | undefined {
    if (!user) return undefined;
    return isGuestUser(user) ? readStoredGuestUsage() || user.aiSqlUsage : user.aiSqlUsage;
}

/** Records one request and persists guest usage independently of guest sessions. */
export function recordAiSqlUsage(user: User): NonNullable<User['aiSqlUsage']> {
    const now = Date.now();
    const current = getAiSqlUsage(user);
    const next = !current || now - current.windowStart >= WINDOW_MS
        ? { count: 1, windowStart: now }
        : { count: current.count + 1, windowStart: current.windowStart };

    if (isGuestUser(user) && typeof localStorage !== 'undefined') {
        try { localStorage.setItem(GUEST_USAGE_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    }
    return next;
}

/** Per-role AI SQL query limits */
export const AI_SQL_LIMITS: Record<string, number> = {
    [UserRole.ADMIN]: Infinity,
    [UserRole.CONTRIBUTOR]: 10,
    [UserRole.VIEWER]: 0,
};

export interface AiSqlLimitStatus {
    allowed: boolean;
    remaining: number;
    limit: number;
    used: number;
    resetsAt: number;       // Unix timestamp when window resets
    resetsInMs: number;     // Milliseconds until reset
    blocked: boolean;       // True if role has 0 limit (Viewer)
}

/**
 * Check whether a user is allowed to make an AI SQL query.
 * Automatically handles 24h window reset logic.
 */
export function checkAiSqlLimit(user: User | null): AiSqlLimitStatus {
    if (!user) {
        return {
            allowed: false, remaining: 0, limit: 0, used: 0,
            resetsAt: 0, resetsInMs: 0, blocked: true,
        };
    }

    const limit = AI_SQL_LIMITS[user.role] ?? 0;

    // Viewers are fully blocked
    if (limit === 0) {
        return {
            allowed: false, remaining: 0, limit: 0, used: 0,
            resetsAt: 0, resetsInMs: 0, blocked: true,
        };
    }

    // Admins have unlimited access
    if (limit === Infinity) {
        return {
            allowed: true, remaining: Infinity, limit: Infinity,
            used: user.aiSqlUsage?.count ?? 0,
            resetsAt: 0, resetsInMs: 0, blocked: false,
        };
    }

    // Contributor — check rolling 24h window
    const now = Date.now();
    const usage = getAiSqlUsage(user);

    if (!usage || (now - usage.windowStart >= WINDOW_MS)) {
        // No usage recorded yet, or window has expired → fresh window
        return {
            allowed: true, remaining: limit, limit, used: 0,
            resetsAt: now + WINDOW_MS, resetsInMs: WINDOW_MS, blocked: false,
        };
    }

    // Active window
    const used = usage.count;
    const remaining = Math.max(0, limit - used);
    const resetsAt = usage.windowStart + WINDOW_MS;
    const resetsInMs = Math.max(0, resetsAt - now);

    return {
        allowed: remaining > 0,
        remaining,
        limit,
        used,
        resetsAt,
        resetsInMs,
        blocked: false,
    };
}

/**
 * Format the reset time as a human-readable string.
 * e.g., "5h 32m", "45m", "2m"
 */
export function formatResetTime(resetsInMs: number): string {
    if (resetsInMs <= 0) return 'now';
    const totalMinutes = Math.ceil(resetsInMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
