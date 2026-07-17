/**
 * Insight Discovery Engine — the deterministic finding detectors.
 *
 * Two layers of coverage:
 *  1. PURE analyzers (no DuckDB): feed known aggregates, assert the exact
 *     findings, severities, and — critically — that materiality floors SUPPRESS
 *     noise (a 3% wiggle is not a finding).
 *  2. END-TO-END (real DuckDB): build a dataset, run the engine's own SQL, and
 *     confirm the analyzers produce the expected findings on real query output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import { AggregationType } from '../types';
import type { SemanticMeasure, SemanticDimension } from '../services/semanticModel';
import {
    analyzePeriodSeries, analyzeConcentration, analyzeOutliers, analyzeGap, rankFindings,
    buildPeriodSQL, buildGroupSQL, buildGapSQL, num, THRESHOLDS, Finding,
} from '../services/insightDiscoveryEngine';

const revenue: SemanticMeasure = {
    name: 'Revenue', column: 'revenue', aggregation: AggregationType.SUM,
    behavior: 'additive', format: 'currency_usd', requiresWeighting: false, isHidden: false,
};
const dept: SemanticDimension = { name: 'Department', column: 'department', dataType: 'string', isHidden: false };

// ─────────────────────────────────────────────────────────────────────
// PURE ANALYZERS
// ─────────────────────────────────────────────────────────────────────
describe('analyzePeriodSeries — period change + streaks', () => {
    it('flags a material drop as a warning with the right numbers', () => {
        const rows = [
            { period: '2024-01', v: 1000 }, { period: '2024-02', v: 1050 }, { period: '2024-03', v: 900 },
        ];
        const f = analyzePeriodSeries(rows, revenue, 'order_date');
        const change = f.find(x => x.type === 'period_change')!;
        expect(change).toBeTruthy();
        expect(change.severity).toBe('warning'); // ~14% drop, below critical 30%
        expect(change.evidence.changePct).toBeCloseTo((900 - 1050) / 1050, 4);
        expect(change.headline).toMatch(/fell/i);
    });

    it('classifies a ≥30% swing as critical', () => {
        const rows = [{ period: '2024-01', v: 1000 }, { period: '2024-02', v: 1000 }, { period: '2024-03', v: 600 }];
        const change = analyzePeriodSeries(rows, revenue, 'd').find(x => x.type === 'period_change')!;
        expect(change.severity).toBe('critical');
    });

    it('a rise in a revenue-like metric is positive news', () => {
        const rows = [{ period: '2024-01', v: 500 }, { period: '2024-02', v: 500 }, { period: '2024-03', v: 700 }];
        const change = analyzePeriodSeries(rows, revenue, 'd').find(x => x.type === 'period_change')!;
        expect(change.severity).toBe('positive');
        expect(change.headline).toMatch(/rose/i);
    });

    it('SUPPRESSES a sub-threshold wiggle (no false finding)', () => {
        const rows = [{ period: '2024-01', v: 1000 }, { period: '2024-02', v: 1010 }, { period: '2024-03', v: 1020 }];
        // +1% moves — below the 10% floor → no period_change finding.
        expect(analyzePeriodSeries(rows, revenue, 'd').some(f => f.type === 'period_change')).toBe(false);
    });

    it('detects a decline streak of ≥3 consecutive months', () => {
        const rows = [
            { period: '2024-01', v: 1000 }, { period: '2024-02', v: 900 },
            { period: '2024-03', v: 800 }, { period: '2024-04', v: 700 },
        ];
        const streak = analyzePeriodSeries(rows, revenue, 'd').find(f => f.type === 'decline_streak')!;
        expect(streak).toBeTruthy();
        expect(streak.evidence.streak).toBe(3);
        expect(streak.severity).toBe('warning');
    });

    it('needs at least 3 periods to say anything', () => {
        expect(analyzePeriodSeries([{ period: '2024-01', v: 1 }, { period: '2024-02', v: 5 }], revenue, 'd')).toHaveLength(0);
    });
});

describe('analyzeConcentration — dominance + Pareto', () => {
    it('flags a single category owning ≥30% of the total', () => {
        const rows = [
            { label: 'Acme', v: 300 }, { label: 'B', v: 100 }, { label: 'C', v: 100 },
            { label: 'D', v: 100 }, { label: 'E', v: 100 },
        ];
        const f = analyzeConcentration(rows, dept, revenue).find(x => x.type === 'concentration')!;
        expect(f).toBeTruthy();
        expect(f.evidence.share).toBeCloseTo(300 / 700, 3); // ~43% → warning band (30–50%)
        expect(f.headline).toContain('Acme');
        expect(f.severity).toBe('warning');
    });

    it('marks ≥50% dominance as critical', () => {
        const rows = [
            { label: 'Acme', v: 800 }, { label: 'B', v: 50 }, { label: 'C', v: 50 },
            { label: 'D', v: 50 }, { label: 'E', v: 50 },
        ];
        const f = analyzeConcentration(rows, dept, revenue).find(x => x.type === 'concentration')!;
        expect(f.severity).toBe('critical');
    });

    it('detects an 80/20 Pareto pattern when no single category dominates', () => {
        // 12 categories; top 20% (3) hold ~81%, but no single one ≥30%.
        const rows = [
            { label: 'a', v: 270 }, { label: 'b', v: 270 }, { label: 'c', v: 270 },
            ...Array.from({ length: 9 }, (_, i) => ({ label: `x${i}`, v: 21 })),
        ];
        const out = analyzeConcentration(rows, dept, revenue);
        expect(out.some(f => f.type === 'concentration')).toBe(false); // top is <30%
        expect(out.some(f => f.type === 'pareto')).toBe(true);
    });

    it('says nothing when the measure is evenly spread', () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ label: `c${i}`, v: 100 }));
        expect(analyzeConcentration(rows, dept, revenue)).toHaveLength(0);
    });
});

describe('analyzeOutliers — z-score', () => {
    it('flags a category far above its peers', () => {
        const rows = [
            { label: 'HospA', v: 1000 },
            ...Array.from({ length: 8 }, (_, i) => ({ label: `H${i}`, v: 100 + i })),
        ];
        const f = analyzeOutliers(rows, dept, revenue)[0];
        expect(f).toBeTruthy();
        expect(f.headline).toContain('HospA');
        expect(f.evidence.z).toBeGreaterThan(THRESHOLDS.outlierZ);
    });

    it('says nothing when peers are uniform (std = 0)', () => {
        const rows = Array.from({ length: 8 }, (_, i) => ({ label: `H${i}`, v: 100 }));
        expect(analyzeOutliers(rows, dept, revenue)).toHaveLength(0);
    });

    it('needs enough peers for a meaningful std dev', () => {
        const rows = [{ label: 'a', v: 1 }, { label: 'b', v: 100 }, { label: 'c', v: 2 }];
        expect(analyzeOutliers(rows, dept, revenue)).toHaveLength(0);
    });
});

describe('analyzeGap + rankFindings', () => {
    it('flags a column that is ≥20% missing', () => {
        const f = analyzeGap({ total: 1000, nonnull: 700 }, 'email')!;
        expect(f.type).toBe('data_gap');
        expect(f.evidence.missingShare).toBeCloseTo(0.3, 3);
    });
    it('ignores a mostly-complete column', () => {
        expect(analyzeGap({ total: 1000, nonnull: 990 }, 'email')).toBeNull();
    });
    it('ranks by severity×magnitude, de-dupes, and caps', () => {
        const mk = (id: string, score: number): Finding =>
            ({ id, type: 'info' as any, severity: 'info', headline: id, detail: '', score, evidence: {} });
        const ranked = rankFindings([mk('a', 10), mk('b', 90), mk('a', 50), mk('c', 30)], 2);
        // sorts by score first, so the surviving 'a' is the higher-scored (50); top-2 → b, a
        expect(ranked.map(f => f.id)).toEqual(['b', 'a']);
    });
});

// ─────────────────────────────────────────────────────────────────────
// END-TO-END through real DuckDB
// ─────────────────────────────────────────────────────────────────────
describe('discovery SQL runs in DuckDB and produces real findings', () => {
    let duck: DuckHandle;
    // A dataset with a deliberate April crash and a dominant department.
    const rows: any[] = [];
    beforeAll(async () => {
        duck = await createDuck();
        const monthTotals: Record<string, number> = { '01': 1000, '02': 1000, '03': 1000, '04': 500 };
        let id = 0;
        for (const [mm, total] of Object.entries(monthTotals)) {
            const per = total / 10;
            for (let i = 0; i < 10; i++) {
                // "Cardiology" gets an outsized share to trigger concentration.
                const department = i < 6 ? 'Cardiology' : ['Onco', 'Neuro', 'Ortho', 'Peds'][i % 4];
                rows.push({ id: id++, order_date: `2024-${mm}-${String((i % 27) + 1).padStart(2, '0')}`, department, revenue: per });
            }
        }
        duck.loadTable('data', rows);
    }, 60000);
    afterAll(() => duck?.close());

    it('period SQL yields a monthly series and the analyzer sees the April drop', () => {
        const data = duck.query(normalizeSQLForDuckDB(buildPeriodSQL(revenue, 'order_date')));
        expect(data.length).toBe(4);
        // sum of the series equals the grand total (proves aggregation is correct)
        const total = data.reduce((a: number, r: any) => a + num(r.v), 0);
        expect(total).toBeCloseTo(3500, 1);
        const f = analyzePeriodSeries(data as any, revenue, 'order_date');
        const change = f.find(x => x.type === 'period_change')!;
        expect(change.severity).toBe('critical'); // 1000 → 500 is a 50% drop
    });

    it('group SQL yields per-department totals and the analyzer flags concentration', () => {
        const data = duck.query(normalizeSQLForDuckDB(buildGroupSQL(dept, revenue)));
        const f = analyzeConcentration(data as any, dept, revenue).find(x => x.type === 'concentration');
        expect(f).toBeTruthy();
        expect(f!.headline).toContain('Cardiology');
    });

    it('gap SQL reports completeness (no false data-gap on a full column)', () => {
        const data = duck.query(normalizeSQLForDuckDB(buildGapSQL('revenue')));
        expect(analyzeGap(data[0] as any, 'revenue')).toBeNull();
    });
});
