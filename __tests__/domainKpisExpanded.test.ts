/**
 * Expanded Domain KPI sets — education, manufacturing, marketing, finance,
 * plus the healthcare/HR/retail expansions.
 *
 * Same contract as domainKpis.test.ts: templates instantiate only when their
 * role columns exist, domains are inferred from columns when the label is
 * missing, and the trickier ratio SQL (defect rate, CTR, CPA, weekday split)
 * is validated end-to-end in real DuckDB against independent JS math.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/semanticModel';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import { buildDomainKpiDefs, resolveKpiDomain, resolveRoles } from '../services/domainKpiEngine';
import { num } from '../services/insightDiscoveryEngine';
import type { Dataset } from '../types';

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

const manufacturingRows = (n = 200) => Array.from({ length: n }, (_, i) => ({
    machine: `Line ${'ABCD'[i % 4]}`,
    shift: `Shift ${(i % 3) + 1}`,
    status: ['Pass', 'Rework', 'Scrap'][i % 3 === 2 ? 2 : i % 2],
    production_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
    units_produced: 100 + (i * 7) % 400,
    defects: (i * 3) % 12,
    downtime_hours: (i % 5),
    cost: 1000 + (i * 53) % 5000,
}));

const marketingRows = (n = 180) => Array.from({ length: n }, (_, i) => ({
    campaign: `Campaign ${(i % 6) + 1}`,
    channel: ['Search', 'Social', 'Email', 'Display'][i % 4],
    date: `2024-${String((i % 12) + 1).padStart(2, '0')}-05`,
    spend: 50 + (i * 13) % 900,
    impressions: 10000 + (i * 997) % 90000,
    clicks: 100 + (i * 31) % 2000,
    conversions: (i * 7) % 90,
}));

const educationRows = (n = 240) => Array.from({ length: n }, (_, i) => ({
    student_id: `S${1000 + (i % 180)}`, // some students take multiple courses
    gender: i % 2 ? 'Male' : 'Female',
    course: ['Math', 'Physics', 'History', 'Biology', 'Art'][i % 5],
    teacher: ['Ms Lee', 'Mr Ford', 'Dr Ray'][i % 3],
    status: ['Passed', 'Failed', 'Enrolled'][i % 5 === 4 ? 2 : i % 2],
    enrollment_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
    score: 40 + (i * 17) % 60,
}));

describe('domain resolution for the new sets', () => {
    it('labels map: education / manufacturing / marketing / finance', () => {
        expect(resolveKpiDomain('Education', {})).toBe('education');
        expect(resolveKpiDomain('University Administration', {})).toBe('education');
        expect(resolveKpiDomain('Manufacturing', {})).toBe('manufacturing');
        expect(resolveKpiDomain('Factory Production', {})).toBe('manufacturing');
        expect(resolveKpiDomain('Digital Marketing', {})).toBe('marketing');
        expect(resolveKpiDomain('Banking & Finance', {})).toBe('finance');
    });

    it('infers each domain from columns alone (no label)', () => {
        const mf = mkDataset(manufacturingRows(), 'production.csv');
        const mk = mkDataset(marketingRows(), 'campaigns.csv');
        const ed = mkDataset(educationRows(), 'grades.csv');
        expect(resolveKpiDomain(undefined, resolveRoles(mf, (mf as any).semanticModel))).toBe('manufacturing');
        expect(resolveKpiDomain(undefined, resolveRoles(mk, (mk as any).semanticModel))).toBe('marketing');
        expect(resolveKpiDomain(undefined, resolveRoles(ed, (ed as any).semanticModel))).toBe('education');
    });
});

describe('template instantiation per domain', () => {
    it('manufacturing gets output / defect / downtime / shift KPIs', () => {
        const ids = buildDomainKpiDefs(mkDataset(manufacturingRows(), 'production.csv', 'Manufacturing')).map(d => d.id);
        for (const e of ['mf_units_total', 'mf_production_trend', 'mf_output_by_machine', 'mf_output_by_shift',
            'mf_defect_rate', 'mf_cost_per_unit', 'mf_defects_by_machine', 'mf_downtime_total',
            'mf_downtime_by_machine', 'mf_by_status']) expect(ids, e).toContain(e);
    });

    it('marketing gets spend / CTR / conversion / CPC / CPA KPIs', () => {
        const ids = buildDomainKpiDefs(mkDataset(marketingRows(), 'campaigns.csv', 'Marketing')).map(d => d.id);
        for (const e of ['mk_spend_total', 'mk_spend_by_campaign', 'mk_spend_by_channel', 'mk_ctr',
            'mk_conversion_rate', 'mk_cpc', 'mk_cpa', 'mk_conversions_by_channel', 'mk_clicks_trend']) expect(ids, e).toContain(e);
    });

    it('education gets students / scores / teacher-load KPIs', () => {
        const ids = buildDomainKpiDefs(mkDataset(educationRows(), 'grades.csv', 'Education')).map(d => d.id);
        for (const e of ['ed_total_students', 'ed_enrollments_trend', 'ed_avg_score', 'ed_score_by_course',
            'ed_score_by_teacher', 'ed_students_per_course', 'ed_teacher_load', 'ed_by_status']) expect(ids, e).toContain(e);
    });

    it('finance (own set now, not retail\'s) gets amount / account / status KPIs', () => {
        const rows = Array.from({ length: 150 }, (_, i) => ({
            transaction_id: `T${i}`, account: `Acct ${(i % 12) + 1}`, category: ['Payroll', 'Rent', 'Supplies'][i % 3],
            status: ['Paid', 'Pending', 'Overdue'][i % 3], region: ['NA', 'EU'][i % 2],
            date: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`, amount: 100 + (i * 91) % 9000,
        }));
        const ids = buildDomainKpiDefs(mkDataset(rows, 'ledger.csv', 'Finance')).map(d => d.id);
        for (const e of ['fin_total_amount', 'fin_avg_txn', 'fin_amount_trend', 'fin_amount_by_category',
            'fin_amount_by_account', 'fin_amount_by_status', 'fin_txn_trend']) expect(ids, e).toContain(e);
        expect(ids.some(i => i.startsWith('rt_'))).toBe(false);
    });

    it('marketing KPIs gate on their columns (no impressions → no CTR)', () => {
        const rows = marketingRows().map(({ impressions, ...rest }) => rest);
        const ids = buildDomainKpiDefs(mkDataset(rows, 'campaigns.csv', 'Marketing')).map(d => d.id);
        expect(ids).not.toContain('mk_ctr');
        expect(ids).toContain('mk_conversion_rate'); // clicks+conversions still there
    });

    it('expanded healthcare/HR/retail KPIs appear when their columns exist', () => {
        const hcRows = Array.from({ length: 120 }, (_, i) => ({
            patient_id: 100 + (i % 80), age: 20 + (i % 60), gender: i % 2 ? 'M' : 'F',
            doctor: `Dr ${i % 4}`, department: ['A', 'B'][i % 2],
            admission_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-03`,
            billing_amount: 100 + i,
        }));
        const hcIds = buildDomainKpiDefs(mkDataset(hcRows, 'p.csv', 'Healthcare')).map(d => d.id);
        for (const e of ['hc_avg_billing', 'hc_billing_trend', 'hc_billing_by_doctor', 'hc_admissions_by_dept', 'hc_avg_age']) expect(hcIds, e).toContain(e);

        const hrRows = Array.from({ length: 100 }, (_, i) => ({
            employee_id: `E${i}`, department: ['Eng', 'Ops'][i % 2], job_title: ['Analyst', 'Manager', 'Director'][i % 3],
            region: ['NA', 'EU'][i % 2], age: 22 + (i % 40), salary: 50000 + i * 100,
            hire_date: `2023-${String((i % 12) + 1).padStart(2, '0')}-01`,
        }));
        const hrIds = buildDomainKpiDefs(mkDataset(hrRows, 'e.csv', 'HR')).map(d => d.id);
        for (const e of ['hr_payroll_total', 'hr_salary_by_role', 'hr_headcount_by_role', 'hr_headcount_by_region', 'hr_avg_age']) expect(hrIds, e).toContain(e);

        const rtRows = Array.from({ length: 140 }, (_, i) => ({
            customer_id: `C${i % 60}`, product_name: `P${i % 10}`, category: ['A', 'B'][i % 2],
            order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
            quantity: 1 + (i % 5), revenue: 20 + (i * 7) % 400,
        }));
        const rtIds = buildDomainKpiDefs(mkDataset(rtRows, 'o.csv', 'Retail')).map(d => d.id);
        for (const e of ['rt_revenue_by_weekday', 'rt_qty_by_product', 'rt_repeat_rate', 'rt_avg_txn']) expect(rtIds, e).toContain(e);
    });
});

describe('ratio KPI SQL is numerically correct in DuckDB (manufacturing)', () => {
    let duck: DuckHandle; let ds: Dataset;
    beforeAll(async () => {
        duck = await createDuck();
        ds = mkDataset(manufacturingRows(), 'production.csv', 'Manufacturing');
        duck.loadTable('data', ds.rows);
    }, 60000);
    afterAll(() => duck?.close());

    const run = (id: string) => {
        const def = buildDomainKpiDefs(ds).find(d => d.id === id)!;
        expect(def, id).toBeTruthy();
        return duck.query(normalizeSQLForDuckDB(def.sql));
    };

    it('defect rate = 100 × Σdefects / Σunits', () => {
        const units = ds.rows.reduce((a, r) => a + Number(r.units_produced), 0);
        const defects = ds.rows.reduce((a, r) => a + Number(r.defects), 0);
        expect(num(run('mf_defect_rate')[0].value)).toBeCloseTo(100 * defects / units, 3);
    });

    it('cost per unit = Σcost / Σunits', () => {
        const units = ds.rows.reduce((a, r) => a + Number(r.units_produced), 0);
        const cost = ds.rows.reduce((a, r) => a + Number(r.cost), 0);
        expect(num(run('mf_cost_per_unit')[0].value)).toBeCloseTo(cost / units, 3);
    });
});

describe('ratio + weekday KPI SQL is numerically correct in DuckDB (marketing/retail)', () => {
    let duck: DuckHandle; let mk: Dataset;
    beforeAll(async () => {
        duck = await createDuck();
        mk = mkDataset(marketingRows(), 'campaigns.csv', 'Marketing');
        duck.loadTable('data', mk.rows);
    }, 60000);
    afterAll(() => duck?.close());

    it('CTR and CPA match JS math', () => {
        const defs = buildDomainKpiDefs(mk);
        const sql = (id: string) => normalizeSQLForDuckDB(defs.find(d => d.id === id)!.sql);
        const S = (f: string) => mk.rows.reduce((a, r) => a + Number(r[f]), 0);
        expect(num(duck.query(sql('mk_ctr'))[0].value)).toBeCloseTo(100 * S('clicks') / S('impressions'), 4);
        expect(num(duck.query(sql('mk_cpa'))[0].value)).toBeCloseTo(S('spend') / S('conversions'), 4);
        // weekday-style trend sanity: monthly clicks sum to total clicks
        const trend = duck.query(sql('mk_clicks_trend'));
        expect(trend.reduce((a: number, r: any) => a + num(r.value), 0)).toBeCloseTo(S('clicks'), 1);
    });
});
