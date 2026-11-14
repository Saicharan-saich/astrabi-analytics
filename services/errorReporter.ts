/**
 * Sends a short report when something breaks in the browser, so it can be
 * fixed without waiting for someone to complain. Quoted text is removed here
 * and again on the server, so values from a person's data are not sent. At most
 * ten reports a session, and each different message once.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';
const RELEASE = (import.meta.env.VITE_RELEASE as string | undefined) || 'web';
const MAX_PER_SESSION = 10;

const sent = new Set<string>();
let installed = false;

/** Same rules as backend/clientErrors.js scrub(). */
export function scrubErrorText(text: unknown, max: number): string {
    return String(text ?? '')
        .replace(/(["'`])(?:(?!\1)[^\n]){0,500}\1/g, '"…"')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b\d{5,}\b/g, '[number]')
        .replace(/[?#][^\s)]*/g, '')
        .slice(0, max);
}

export function reportError(error: unknown, kind: 'error' | 'unhandledrejection' | 'render' = 'error'): void {
    try {
        if (!installed) return; // only on the live site (see index.tsx)
        const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
        const message = scrubErrorText(`${err.name}: ${err.message}`, 300);
        // Browser noise that isn't ours to fix.
        if (/ResizeObserver loop|Script error\.?$|Load failed$|AbortError/.test(message)) return;
        if (sent.has(message) || sent.size >= MAX_PER_SESSION) return;
        sent.add(message);
        const token = (() => { try { return localStorage.getItem('qi_token'); } catch { return null; } })();
        void fetch(`${API_BASE}/client-errors`, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ kind, message, stack: scrubErrorText(err.stack, 2000), path: window.location.pathname, release: RELEASE }),
        }).catch(() => { /* reporting must never cause another error */ });
    } catch { /* never throw from the reporter */ }
}

export function installErrorReporter(): void {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    window.addEventListener('error', event => reportError(event.error ?? event.message, 'error'));
    window.addEventListener('unhandledrejection', event => reportError(event.reason, 'unhandledrejection'));
}
