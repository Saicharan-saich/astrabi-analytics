/**
 * AI SQL Privacy Mode — controls what the LLM direct-SQL engine may see.
 * ─────────────────────────────────────────────────────────────────────
 *   'strict'   — METADATA ONLY. Column names, types and semantics are sent;
 *                NO data values ever leave the browser. The local literal-
 *                grounding pass still corrects casing/plural drift against
 *                your values on-device.
 *
 *   'enhanced' — additionally sends the distinct VALUES of low-cardinality,
 *                NON-sensitive category columns (item/product names, region,
 *                status…) so the LLM writes real value literals instead of
 *                guessing. Person PII, identifiers, and sensitive categoricals
 *                (health, demographics, financial bands) are still never sent,
 *                and transaction rows are never sent in either mode.
 *
 * CONSENT
 * ───────
 * Enhanced sends values from the user's data, so it requires explicit,
 * informed consent. `getPrivacyMode()` returns the user's *preference*;
 * `getEffectivePrivacyMode()` returns what the pipeline may actually do, and
 * downgrades to 'strict' whenever consent is missing or was given against an
 * older version of the disclosure. Always use the effective mode when deciding
 * what to send — the preference alone is not permission.
 */

export type PrivacyMode = 'strict' | 'enhanced';

const STORAGE_KEY = 'qi_ai_privacy_mode';
const CONSENT_KEY = 'qi_ai_enhanced_consent';

/**
 * Bump when the disclosure materially changes (new field categories shared,
 * different caps). Consent recorded against an older version stops counting,
 * so users are asked again rather than silently carried over.
 */
export const DISCLOSURE_VERSION = 1;

export function getPrivacyMode(): PrivacyMode {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'strict' ? 'strict' : 'enhanced';
    } catch {
        return 'enhanced';
    }
}

export function setPrivacyMode(mode: PrivacyMode): void {
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        /* ignore storage errors — the effective mode stays strict */
    }
}

export interface EnhancedConsent {
    version: number;
    grantedAt: string;
}

export function getEnhancedConsent(): EnhancedConsent | null {
    try {
        const raw = localStorage.getItem(CONSENT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.version !== 'number' || typeof parsed?.grantedAt !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

/** True only when consent exists AND matches the current disclosure version. */
export function hasEnhancedConsent(): boolean {
    return getEnhancedConsent()?.version === DISCLOSURE_VERSION;
}

export function grantEnhancedConsent(): void {
    try {
        localStorage.setItem(CONSENT_KEY, JSON.stringify({
            version: DISCLOSURE_VERSION,
            grantedAt: new Date().toISOString(),
        } satisfies EnhancedConsent));
    } catch {
        /* ignore — without stored consent the effective mode stays strict */
    }
}

export function revokeEnhancedConsent(): void {
    try {
        localStorage.removeItem(CONSENT_KEY);
    } catch {
        /* ignore */
    }
}

/**
 * What the pipeline is actually allowed to send. Enhanced requires consent;
 * without it this returns 'strict', so a stored preference can never by itself
 * cause data values to leave the device.
 */
export function getEffectivePrivacyMode(): PrivacyMode {
    return getPrivacyMode() === 'enhanced' && hasEnhancedConsent() ? 'enhanced' : 'strict';
}
