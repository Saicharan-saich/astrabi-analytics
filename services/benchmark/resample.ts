/**
 * Bootstrap resampling for TEST-SUITE (multi-instance) evaluation.
 * ─────────────────────────────────────────────────────────────────────
 * Naive execution accuracy (compare results on ONE database instance) has known
 * false positives: two different queries can coincidentally return the same rows
 * on one dataset. Zhong et al. (2020) fix this with *test suites* — many database
 * instances chosen so wrong queries diverge from gold on at least one.
 *
 * We can't ship their distilled suites for arbitrary imported databases, so we
 * approximate the same effect: re-run gold + predicted on several BOOTSTRAP
 * resamples of the tables. A query that only coincidentally matched on the
 * original data almost always diverges on a resample. Gold and predicted are
 * BOTH evaluated on the same resampled instance, so the comparison stays fair.
 *
 * This is an approximation of the official protocol — documented as such.
 */

export interface RTable { name: string; rows: Record<string, any>[]; }

/** Deterministic PRNG (mulberry32) so a run is reproducible from a seed. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Resample each table's rows WITH REPLACEMENT to the same row count. Preserves
 * the schema (columns) but changes the multiset of rows, so a coincidental
 * match rarely survives. Tables with ≤1 row are returned unchanged.
 */
export function resampleTables(tables: RTable[], rng: () => number): RTable[] {
    return tables.map(t => {
        const n = t.rows.length;
        if (n <= 1) return { name: t.name, rows: t.rows.slice() };
        const rows: Record<string, any>[] = new Array(n);
        for (let i = 0; i < n; i++) rows[i] = t.rows[Math.floor(rng() * n)];
        return { name: t.name, rows };
    });
}
