/**
 * Prompt compaction — lossless token savings for model context.
 * ─────────────────────────────────────────────────────────────────────
 * The governed evidence blocks (query contract, analytical IR, local plan,
 * query specification) used to be sent as pretty-printed JSON. Indentation
 * and empty placeholder fields roughly doubled their token cost on every
 * planner, SQL, review and repair call without adding a single fact.
 *
 * `compactPromptJSON` keeps every meaningful value and only removes:
 *   - indentation / newlines,
 *   - `undefined` and `null`,
 *   - empty arrays and empty objects.
 *
 * It deliberately keeps `false`, `0`, empty strings and words such as
 * "none": inside filters and predicates those can be genuine user literals
 * (e.g. `is_active = false`, `status = 'none'`), so dropping them would change
 * the meaning of the evidence.
 */

const INTERNAL_PLAN_KEYS = new Set([
    'tokenUsage',
    'originalQuestion',
    '_smartDefaultApplied',
    '_smartDefaultExplanation',
]);

function prune(value: unknown, dropKeys?: Set<string>): unknown {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        const items = value
            .map(item => prune(item, dropKeys))
            .filter(item => item !== undefined);
        return items.length ? items : undefined;
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (dropKeys?.has(key)) continue;
            const pruned = prune(child, dropKeys);
            if (pruned !== undefined) out[key] = pruned;
        }
        return Object.keys(out).length ? out : undefined;
    }
    return value;
}

/** Serialize evidence for a prompt with no whitespace and no empty fields. */
export function compactPromptJSON(value: unknown): string {
    const pruned = prune(value);
    return JSON.stringify(pruned === undefined ? {} : pruned);
}

/**
 * Serialize the local governed plan for a prompt. Bookkeeping fields that
 * carry no analytical meaning (token counters, a copy of the question, and
 * smart-default flags) are removed; everything else is kept losslessly.
 */
export function compactPlanForPrompt(plan: unknown): string {
    const pruned = prune(plan, INTERNAL_PLAN_KEYS);
    return JSON.stringify(pruned === undefined ? {} : pruned);
}

/**
 * The local plan is advisory. When it was produced by a smart-default guess
 * or flagged ambiguous, it is a weaker signal than the deterministic query
 * contract that is also supplied, and it can point the model at the wrong
 * entity (for example grouping "Top 5 products by profit" by profit). Such a
 * plan is withheld; the contract and analytical evidence still describe the
 * question.
 */
export function isPlanReliableForPrompt(plan: unknown): boolean {
    if (!plan || typeof plan !== 'object') return false;
    const candidate = plan as Record<string, unknown>;
    return candidate._smartDefaultApplied !== true && candidate.ambiguous !== true;
}
