/**
 * DEMO: realistic patient questions run through the REAL deterministic engine
 * (plan → correctSQL → DuckDB). Plans are hand-built here to stand in for what the
 * LLM planner would produce; the SQL + numbers are the engine's, verified against
 * an independent JS computation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

// A patient dataset like the one on screen: names, gender, department, dates,
// billing, a 1–5 satisfaction rating, and a 0–1 readmission RATE (non-additive).
function patients(n = 500) {
    const gender = ['Male', 'Female'];
    const dept = ['Cardiology', 'Oncology', 'Pediatrics', 'Neurology', 'Orthopedics'];
    const first = ['DaNnY', 'andrEw', 'EMILY', 'CHrisTInA', 'aaRon', 'haley', 'LuKE', 'jamiE'];
    const last = ['sMitH', 'waTtS', 'JOHNSOn', 'MARtinez', 'HANsEn', 'perkins', 'BuRgEss', 'schmIdt'];
    return Array.from({ length: n }, (_, i) => ({
        patient_id: 100000 + i,
        name: `${first[i % first.length]} ${last[(i * 3) % last.length]}`,
        gender: gender[i % 2],
        age: 18 + (i * 7) % 70,
        department: dept[i % 5],
        admission_date: `${2023 + (i % 2)}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        billing_amount: 500 + (i * 137) % 45000,
        satisfaction: 1 + (i % 5),
        readmission_rate: (i % 40) / 100, // 0–0.39 → a RATE
    }));
}

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(patients(), 'patients.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const run = (p: AnalysisPlan) => duck.query(normalizeSQLForDuckDB(correctSQL(p, model)));
const sql = (p: AnalysisPlan) => normalizeSQLForDuckDB(correctSQL(p, model)).replace(/\s+/g, ' ').trim();
const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'breakdown', dimensions: [], metrics: [{ field: 'billing_amount', agg: 'sum' }], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: '', ...o,
} as AnalysisPlan);
const show = (q: string, p: AnalysisPlan) => {
    const res = run(p);
    console.log(`\nQ: ${q}\n  SQL: ${sql(p)}\n  →`, JSON.stringify(res.slice(0, 6), (k, v) => typeof v === 'bigint' ? Number(v) : v));
    return res;
};
const groupRows = (dim: string) => { const m = new Map<string, any[]>(); for (const r of rows) { const k = String(r[dim]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };

describe('Patient dataset — question demo', () => {
    it('Q1: "Total billing amount by gender"', () => {
        const res = show('Total billing amount by gender', P({ dimensions: [{ field: 'gender' }] }));
        for (const r of res) {
            const g = String(r.gender ?? Object.values(r)[0]);
            const exp = groupRows('gender').get(g)!.reduce((a, x) => a + Number(x.billing_amount), 0);
            expect(num(r.billing_amount_sum)).toBeCloseTo(exp, 1);
        }
    });

    it('Q2: "Average billing by department"', () => {
        const res = show('Average billing by department', P({ metrics: [{ field: 'billing_amount', agg: 'avg' }], dimensions: [{ field: 'department' }] }));
        expect(res.length).toBe(5);
    });

    it('Q3: "Total billing this year" (uses the dataset anchor, not real today)', () => {
        const maxDate = rows.map(r => String(r.admission_date)).sort().at(-1)!;
        const yr = maxDate.slice(0, 4);
        const res = show(`Total billing this year (anchor year = ${yr})`, P({ intent: 'single_metric', filters: [{ field: 'admission_date', op: 'this_year', value: null }] }));
        const exp = rows.filter(r => String(r.admission_date).startsWith(yr)).reduce((a, x) => a + Number(x.billing_amount), 0);
        expect(num(Object.values(res[0])[0])).toBeCloseTo(exp, 1);
        expect(rows.filter(r => String(r.admission_date).startsWith(yr)).length).toBeLessThan(rows.length); // proves it filtered
    });

    it('Q4: "Top 5 patients by billing" (10k names would freeze the chart; SQL still returns top 5)', () => {
        const res = show('Top 5 patients by total billing', P({ intent: 'ranking', dimensions: [{ field: 'name' }], sort: [{ field: 'billing_amount', dir: 'desc' }], limit: 5 }));
        expect(res.length).toBe(5);
        const vals = res.map(r => num(r.billing_amount_sum));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
    });

    it('Q5: "Average patient satisfaction by department" (ordinal rating → AVG, never SUM)', () => {
        // Even though this plan (wrongly) asks SUM, the additivity guard makes it AVG.
        const res = show('Average satisfaction by department', P({ metrics: [{ field: 'satisfaction', agg: 'sum' }], dimensions: [{ field: 'department' }] }));
        for (const r of res) {
            const d = String(r.department ?? Object.values(r)[0]);
            const rs = groupRows('department').get(d)!;
            const expAvg = rs.reduce((a, x) => a + Number(x.satisfaction), 0) / rs.length;
            const val = num(Object.values(r).find((v, idx) => idx > 0)!);
            expect(val).toBeCloseTo(expAvg, 2); // 1–5, an average — not a giant sum
        }
    });

    it('Q6: "Sum of readmission rate by gender" (a RATE → guarded to AVG, not a nonsense sum)', () => {
        const res = show('Readmission rate by gender', P({ metrics: [{ field: 'readmission_rate', agg: 'sum' }], dimensions: [{ field: 'gender' }] }));
        for (const r of res) {
            const g = String(r.gender ?? Object.values(r)[0]);
            const rs = groupRows('gender').get(g)!;
            const expAvg = rs.reduce((a, x) => a + Number(x.readmission_rate), 0) / rs.length;
            expect(num(Object.values(r).find((v, idx) => idx > 0)!)).toBeCloseTo(expAvg, 3); // ~0.2, not ~50
        }
    });
});
