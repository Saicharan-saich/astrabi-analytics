/**
 * Domain KPI Recommendation Engine — once the domain is known, instantiate its
 * standard KPIs (healthcare: Average stay, Admissions, Billing, Doctor workload,
 * Readmission rate, Condition frequency) against the REAL columns.
 *
 *  1. PURE: role resolution, domain resolution (label + inference), template
 *     gating (a KPI whose columns are missing must be skipped, not broken).
 *  2. END-TO-END: the generated SQL runs in real DuckDB and the numbers match
 *     an independent JS computation (avg stay, readmission rate, workload).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/semanticModel';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import { buildDomainKpiDefs, resolveRoles, resolveKpiDomain } from '../services/domainKpiEngine';
import { num } from '../services/insightDiscoveryEngine';
import type { Dataset } from '../types';

// Patients with REPEATED patient_ids (readmissions), stay durations, doctors,
// conditions, insurance, gender, billing.
function patientRows(n = 300) {
    const docs = ['Dr Adams', 'Dr Brown', 'Dr Chen', 'Dr Diaz'];
    const conds = ['Diabetes', 'Hypertension', 'Asthma', 'Arthritis', 'Flu'];
    const ins = ['Aetna', 'Cigna', 'Medicare'];
    return Array.from({ length: n }, (_, i) => {
        const admitDay = (i % 27) + 1;
        const stay = (i % 7) + 1; // 1..7 days
        const mm = String((i % 12) + 1).padStart(2, '0');
        return {
            patient_id: 1000 + (i % 200), // 200 distinct ids → 100 readmitted rows
            gender: i % 2 ? 'Male' : 'Female',
            doctor: docs[i % 4],
            medical_condition: conds[i % 5],
            department: ['Cardio', 'Onco', 'Neuro'][i % 3],
            insurance_provider: ins[i % 3],
            admission_date: `2024-${mm}-${String(admitDay).padStart(2, '0')}`,
            discharge_date: `2024-${mm}-${String(Math.min(admitDay + stay, 28)).padStart(2, '0')}`,
            billing_amount: 500 + (i * 137) % 20000,
        };
    });
}

function mkDataset(rows: any[], fileName: string, domain?: string): Dataset {
    const etl = runETLPipeline(rows, fileName);
    const ds: any = {
        id: 't1', name: fileName, rows: etl.rows, columns: etl.columns,
        totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext,
        version: 1, createdAt: 0,
        ...(domain ? { domainProfile: { domain, summary: '', confidence: 0.95, columnSemantics: {}, detectedAt: 0 } } : {}),
    };
    ds.semanticModel = buildSemanticModel(ds);
    return ds as Dataset;
}

let hc: Dataset;
beforeAll(() => { hc = mkDataset(patientRows(), 'patients.csv', 'Healthcare'); });

describe('role + domain resolution', () => {
    it('resolves healthcare roles from real column names', () => {
        const r = resolveRoles(hc, (hc as any).semanticModel);
        expect(r.entityId).toBe('patient_id');
        expect(r.doctor).toBe('doctor');
        expect(r.condition).toBe('medical_condition');
        expect(r.insurance).toBe('insurance_provider');
        expect(r.primaryDate).toBe('admission_date');
        expect(r.endDate).toBe('discharge_date');
        expect(r.money).toBe('billing_amount');
        expect(r.gender).toBe('gender');
    });

    it('maps domain labels and infers from columns when the label is useless', () => {
        const r = resolveRoles(hc, (hc as any).semanticModel);
        expect(resolveKpiDomain('Healthcare', r)).toBe('healthcare');
        expect(resolveKpiDomain('Hospital Operations', r)).toBe('healthcare');
        expect(resolveKpiDomain(undefined, r)).toBe('healthcare');      // inferred from doctor/condition
        expect(resolveKpiDomain('General', {})).toBe('none');           // nothing to go on
    });
});

describe('healthcare template instantiation', () => {
    it('instantiates the standard healthcare KPI set', () => {
        const ids = buildDomainKpiDefs(hc).map(d => d.id);
        for (const expected of [
            'hc_admissions_trend', 'hc_avg_stay', 'hc_stay_by_condition',
            'hc_billing_total', 'hc_billing_by_dept', 'hc_billing_by_insurance',
            'hc_doctor_workload', 'hc_condition_freq', 'hc_readmission_rate', 'hc_gender_split',
        ]) expect(ids, expected).toContain(expected);
    });

    it('skips KPIs whose required columns are missing (no discharge → no avg stay)', () => {
        const rows = patientRows().map(({ discharge_date, patient_id, ...rest }) => rest);
        const ds = mkDataset(rows, 'nostay.csv', 'Healthcare');
        const ids = buildDomainKpiDefs(ds).map(d => d.id);
        expect(ids).not.toContain('hc_avg_stay');
        expect(ids).not.toContain('hc_readmission_rate'); // no patient id either
        expect(ids).toContain('hc_doctor_workload');       // still available
    });

    it('suppresses readmission rate when the id column never repeats (trivially 0%)', () => {
        const rows = patientRows().map((r, i) => ({ ...r, patient_id: 5000 + i })); // all unique
        const ds = mkDataset(rows, 'unique.csv', 'Healthcare');
        expect(buildDomainKpiDefs(ds).map(d => d.id)).not.toContain('hc_readmission_rate');
    });
});

describe('hr + retail template sets', () => {
    it('HR dataset gets headcount / salary / hires KPIs, no attrition without a term date', () => {
        const rows = Array.from({ length: 120 }, (_, i) => ({
            employee_id: `E${i}`, department: ['Eng', 'Sales', 'Ops'][i % 3],
            gender: i % 2 ? 'Male' : 'Female', salary: 40000 + (i * 997) % 80000,
            hire_date: `202${i % 4}-${String((i % 12) + 1).padStart(2, '0')}-15`,
        }));
        const ds = mkDataset(rows, 'employees.csv', 'HR');
        const ids = buildDomainKpiDefs(ds).map(d => d.id);
        expect(ids).toContain('hr_headcount');
        expect(ids).toContain('hr_avg_salary');
        expect(ids).toContain('hr_salary_by_dept');
        expect(ids).toContain('hr_hires_trend');
        expect(ids).not.toContain('hr_attrition');
    });

    it('retail is inferred from product+revenue even without a domain label', () => {
        const rows = Array.from({ length: 150 }, (_, i) => ({
            order_id: `O${i}`, product_name: `P${i % 12}`, category: ['A', 'B', 'C'][i % 3],
            region: ['East', 'West'][i % 2], revenue: 10 + (i * 37) % 500,
            order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-10`,
        }));
        const ds = mkDataset(rows, 'orders.csv'); // NO domainProfile
        const ids = buildDomainKpiDefs(ds).map(d => d.id);
        expect(ids).toContain('rt_revenue_trend');
        expect(ids).toContain('rt_top_products');
        expect(ids).toContain('rt_aov');
    });
});

describe('KPI SQL runs in DuckDB with correct numbers', () => {
    let duck: DuckHandle;
    beforeAll(async () => {
        duck = await createDuck();
        duck.loadTable('data', hc.rows);
    }, 60000);
    afterAll(() => duck?.close());

    const run = (id: string) => {
        const def = buildDomainKpiDefs(hc).find(d => d.id === id)!;
        expect(def, id).toBeTruthy();
        return duck.query(normalizeSQLForDuckDB(def.sql));
    };
    const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

    it('hc_avg_stay matches the JS-computed mean stay', () => {
        const valid = hc.rows.filter(r => r.admission_date && r.discharge_date && days(String(r.admission_date), String(r.discharge_date)) >= 0);
        const expected = valid.reduce((a, r) => a + days(String(r.admission_date), String(r.discharge_date)), 0) / valid.length;
        expect(num(run('hc_avg_stay')[0].value)).toBeCloseTo(expected, 2);
    });

    it('hc_readmission_rate matches the JS-computed % of repeat patients', () => {
        const counts = new Map<string, number>();
        for (const r of hc.rows) counts.set(String(r.patient_id), (counts.get(String(r.patient_id)) || 0) + 1);
        const expected = 100 * [...counts.values()].filter(c => c > 1).length / counts.size;
        expect(num(run('hc_readmission_rate')[0].value)).toBeCloseTo(expected, 2);
    });

    it('hc_doctor_workload counts match and are sorted desc', () => {
        const res = run('hc_doctor_workload');
        const jsCounts = new Map<string, number>();
        for (const r of hc.rows) jsCounts.set(String(r.doctor), (jsCounts.get(String(r.doctor)) || 0) + 1);
        for (const row of res) expect(num(row.value)).toBe(jsCounts.get(String(row.label)));
        const vals = res.map((r: any) => num(r.value));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
    });

    it('hc_admissions_trend buckets sum to the row count', () => {
        const res = run('hc_admissions_trend');
        expect(res.length).toBe(12);
        expect(res.reduce((a: number, r: any) => a + num(r.value), 0)).toBe(hc.rows.length);
    });
});
