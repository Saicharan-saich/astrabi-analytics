/**
 * Global tab visibility — admin-controlled, applied to ALL users.
 *
 * The admin's Manage Tabs choices are stored server-side (app_settings) and
 * fetched by every user on load, so hiding a tab actually affects everyone —
 * not just the admin's own browser (the previous local-only behaviour).
 */

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';

function authHeaders(): Record<string, string> {
    const token = localStorage.getItem('qi_token') || '';
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

/** Fetch the globally-hidden tab IDs. Returns [] on any failure (fail-open). */
export async function fetchGlobalHiddenTabs(): Promise<string[]> {
    try {
        const res = await fetch(`${API_BASE}/settings/tab-visibility`, { headers: authHeaders() });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.hiddenTabs) ? data.hiddenTabs : [];
    } catch {
        return [];
    }
}

/**
 * Persist the globally-hidden tab IDs (admin only). Resolves to true on
 * success. On failure the caller keeps the optimistic local update but the
 * change won't be global — surface that to the admin.
 */
export async function saveGlobalHiddenTabs(hiddenTabs: string[]): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE}/admin/tab-visibility`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ hiddenTabs }),
        });
        return res.ok;
    } catch {
        return false;
    }
}
