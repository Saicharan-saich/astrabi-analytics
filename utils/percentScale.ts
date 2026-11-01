/**
 * Percent values arrive in two conventions: fractions (0.125 = 12.5%) and
 * points (12.5 = 12.5%). Deciding per value (|v| ≤ 1 → ×100) mixes them up: a
 * 0.5% rate stored as 0.5 would read as 50% while 1.2 beside it reads 1.2%.
 * The scale is therefore decided once per series, from all of its values.
 */
export type PercentScale = 'fraction' | 'points';

const EPS = 1e-9;

/**
 * 'fraction' when every non-zero value lies within ±1 (a series of shares or
 * rates stored 0–1); 'points' as soon as one value is outside that range, or
 * when the source is known to be in points.
 */
export function percentScaleOf(values: Iterable<unknown>, known?: PercentScale | null): PercentScale {
    if (known) return known;
    let seen = false;
    for (const raw of values) {
        const v = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(v) || v === 0) continue;
        seen = true;
        if (Math.abs(v) > 1 + EPS) return 'points';
    }
    return seen ? 'fraction' : 'points';
}

/** The value in percent points for display. */
export function toPercentPoints(value: number, scale: PercentScale): number {
    return scale === 'fraction' ? value * 100 : value;
}

/** Scale per numeric column of a result, so each series is read consistently. */
export function percentScalesByKey(rows: Record<string, any>[] | undefined, knownPoints: Set<string> = new Set()): Map<string, PercentScale> {
    const out = new Map<string, PercentScale>();
    if (!Array.isArray(rows) || rows.length === 0) return out;
    const keys = new Set<string>();
    for (const row of rows.slice(0, 50)) for (const [k, v] of Object.entries(row || {})) if (typeof v === 'number') keys.add(k);
    for (const key of keys) {
        out.set(key, percentScaleOf(rows.map(row => row?.[key]), knownPoints.has(key) ? 'points' : null));
    }
    return out;
}

/** Looks a series up by key or by its display label ("Conversion Rate" ↔ conversion_rate). */
export function scaleForName(scales: Map<string, PercentScale>, name: string | undefined, fallback: PercentScale): PercentScale {
    if (!name) return fallback;
    const direct = scales.get(name);
    if (direct) return direct;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const target = norm(name);
    for (const [key, scale] of scales) if (norm(key) === target) return scale;
    for (const [key, scale] of scales) { const k = norm(key); if (k && (target.endsWith(k) || target.includes(`_${k}`))) return scale; }
    return fallback;
}
