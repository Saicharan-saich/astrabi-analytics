/**
 * AI SQL Privacy Mode — controls what the LLM direct-SQL engine may see.
 * ─────────────────────────────────────────────────────────────────────
 *   'strict'   (default) — METADATA ONLY. Column names, types and semantics
 *                are sent; NO data values ever leave the browser. The local
 *                literal-grounding pass still corrects casing/plural drift
 *                against your values on-device. This is the privacy-first
 *                guarantee: your data never leaves your device.
 *
 *   'enhanced' — additionally sends the distinct VALUES of low-cardinality,
 *                NON-sensitive category columns (item/product names, region,
 *                status…) so the LLM writes real value literals instead of
 *                guessing. Person PII, identifiers, and sensitive categoricals
 *                (health, demographics, financial bands) are still never sent,
 *                and transaction rows are never sent.
 *
 * Default is 'strict' — privacy-first unless the user explicitly opts in.
 */

export type PrivacyMode = 'strict' | 'enhanced';

const STORAGE_KEY = 'qi_ai_privacy_mode';

export function getPrivacyMode(): PrivacyMode {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'enhanced' ? 'enhanced' : 'strict';
    } catch {
        return 'strict';
    }
}

export function setPrivacyMode(mode: PrivacyMode): void {
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        /* ignore storage errors — falls back to strict */
    }
}
