/**
 * domainKpiEngine.ts — Domain KPI Recommendation Engine
 *
 * Once the business domain is known (AI-detected or inferred from column names),
 * instantiate that domain's STANDARD KPIs against the dataset's real columns and
 * render them as visuals — no user question required:
 *
 *   Healthcare → Admissions/month, Average length of stay, Billing by department,
 *                Doctor workload, Condition frequency, Readmission rate,
 *                Billing by insurance, Gender split
 *   HR         → Headcount, Average salary (+ by department), Hires/month, Attrition
 *   Retail     → Revenue/month, Top products, Revenue by category/region,
 *                Orders/month, Average order value, Top customers
 *
 * Each template declares the ROLES it needs (a doctor column, a discharge date,
 * a billing measure, …); roles are resolved against the actual schema by name
 * pattern, and templates whose roles are missing are silently skipped — so only
 * KPIs the data can genuinely answer are shown.
 *
 * 100% DETERMINISTIC: pattern-matching + SQL aggregates in DuckDB. No LLM.
 */

import { Dataset, QueryConfig, AggregationType, AnalysisType } from '../types';
import { SemanticModel } from './semanticModel';

// Local copies (tiny) to avoid a circular import with autoInsightsEngine,
// which consumes this module's defs.
const q = (col: string) => `"${col.replace(/"/g, '""')}"`;
const humanize = (col: string) => col.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Shape-compatible with autoInsightsEngine's internal InsightDef. */
export interface DomainKpiDef {
    id: string;
    title: string;
    subtitle: string;
    category: 'kpi' | 'ranking' | 'trend' | 'distribution' | 'diagnostic' | 'comparative';
    priority: number;
    chartType: 'kpiCard' | 'bar' | 'horizontalBar' | 'line' | 'area' | 'donut' | 'pie';
    sql: string;
    xKey: string;
    yKey: string;
    kpiFormat?: 'currency_usd' | 'number' | 'percent' | 'compact';
    config?: Partial<QueryConfig>;
}

// ═══════════════════════════════════════════════════════════════════
// ROLE RESOLUTION — abstract concept → real column
// ═══════════════════════════════════════════════════════════════════

export interface ResolvedRoles {
    // shared
    entityId?: string;      // patient/customer/employee/order id
    primaryDate?: string;
    endDate?: string;       // discharge / termination / delivery
    money?: string;         // billing / revenue / salary measure
    department?: string;
    region?: string;
    gender?: string;
    // healthcare
    doctor?: string;
    condition?: string;
    insurance?: string;
    // retail
    product?: string;
    category?: string;
    customer?: string;
    orderId?: string;
    quantity?: string;
    // hr
    salary?: string;
    hireDate?: string;
    termDate?: string;
    role?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]+/g, ' ');

function findCol(names: string[], pattern: RegExp): string | undefined {
    return names.find(n => pattern.test(norm(n)));
}

/** Resolve every role we know about against the dataset's actual columns. */
export function resolveRoles(dataset: Dataset, model: SemanticModel): ResolvedRoles {
    const allNames = dataset.columns.map(c => c.name);
    const dimNames = model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden).map(d => d.column);
    const measureNames = model.measures.filter(m => !m.isHidden).map(m => m.column);
    const dateNames = model.dateColumns || [];

    const r: ResolvedRoles = {};
    r.entityId = findCol(allNames, /\b(patient|customer|employee|member|client|person)\b.*\b(id|no|number|code)\b/)
        || findCol(allNames, /\bmrn\b/);
    r.orderId = findCol(allNames, /\b(order|invoice|transaction|receipt|ticket)\b.*\b(id|no|number)\b/);

    r.hireDate = findCol(dateNames, /\b(hire|hired|join|joining|start)\b/);
    r.termDate = findCol(dateNames, /\b(term|termination|exit|leave|resignation|end)\b/);
    const admitDate = findCol(dateNames, /\b(admission|admit|check in|arrival|visit|order|purchase|transaction)\b/);
    r.endDate = findCol(dateNames, /\b(discharge|release|check out|departure|delivery|ship)\b/);
    r.primaryDate = admitDate || model.primaryDateColumn || dateNames[0];

    r.money = findCol(measureNames, /\b(billing|bill|charge|revenue|sales|amount|cost|fee|price|payment|total)\b/)
        || model.measures.find(m => (m.format === 'currency_usd' || m.format === 'currency_eur') && !m.isHidden)?.column;
    r.salary = findCol(measureNames, /\b(salary|wage|pay|compensation|income)\b/);
    r.quantity = findCol(measureNames, /\b(quantity|qty|units)\b/);

    r.doctor = findCol(dimNames, /\b(doctor|physician|provider|surgeon|clinician|nurse)\b/);
    r.condition = findCol(dimNames, /\b(condition|diagnosis|disease|illness|procedure|treatment)\b/);
    r.insurance = findCol(dimNames, /\b(insurance|payer|coverage|carrier)\b/);
    r.department = findCol(dimNames, /\b(department|dept|division|unit|ward|specialty|team)\b/)
        || findCol(dimNames, /\b(hospital|facility|clinic|branch|store|site)\b/);
    r.region = findCol(dimNames, /\b(region|state|country|city|location|market|territory)\b/);
    r.gender = findCol(dimNames, /\b(gender|sex)\b/);
    r.product = findCol(dimNames, /\b(product|item|sku|service)\b/);
    r.category = findCol(dimNames, /\b(category|segment|class|brand|type)\b/);
    r.customer = findCol(dimNames, /\b(customer|client|buyer|account)\b/);
    r.role = findCol(dimNames, /\b(role|title|position|job|designation)\b/);

    return r;
}

// ═══════════════════════════════════════════════════════════════════
// DOMAIN RESOLUTION
// ═══════════════════════════════════════════════════════════════════

export type KpiDomain = 'healthcare' | 'hr' | 'retail' | 'finance' | 'none';

/** Map the (AI or heuristic) domain string — or, failing that, the resolved
 *  roles themselves — to a KPI template set. */
export function resolveKpiDomain(domainStr: string | undefined, roles: ResolvedRoles): KpiDomain {
    const d = (domainStr || '').toLowerCase();
    if (/health|hospital|medical|clinic|patient|pharma/.test(d)) return 'healthcare';
    if (/\bhr\b|human resource|employee|workforce|people|payroll/.test(d)) return 'hr';
    if (/retail|commerce|sales|shop|marketplace/.test(d)) return 'retail';
    if (/finance|banking|accounting|financial|invoic/.test(d)) return 'finance';
    // Infer from what the columns look like when the domain label is unhelpful.
    if (roles.doctor || roles.condition || (roles.insurance && roles.endDate)) return 'healthcare';
    if (roles.salary && (roles.hireDate || roles.department)) return 'hr';
    if (roles.product && roles.money) return 'retail';
    return 'none';
}

// ═══════════════════════════════════════════════════════════════════
// SQL FRAGMENT HELPERS
// ═══════════════════════════════════════════════════════════════════

const asDate = (col: string) => `TRY_CAST(${q(col)} AS DATE)`;
const asNum = (col: string) => `TRY_CAST(${q(col)} AS DOUBLE)`;
const monthOf = (col: string) => `strftime(${asDate(col)}, '%Y-%m')`;

const monthlyCountSQL = (dateCol: string) =>
    `SELECT ${monthOf(dateCol)} AS period, COUNT(*) AS value FROM data WHERE ${asDate(dateCol)} IS NOT NULL GROUP BY period ORDER BY period`;

const countBySQL = (dim: string, limit = 10) =>
    `SELECT ${q(dim)} AS label, COUNT(*) AS value FROM data WHERE ${q(dim)} IS NOT NULL GROUP BY ${q(dim)} ORDER BY value DESC LIMIT ${limit}`;

const sumBySQL = (measure: string, dim: string, limit = 10) =>
    `SELECT ${q(dim)} AS label, SUM(${asNum(measure)}) AS value FROM data WHERE ${q(dim)} IS NOT NULL GROUP BY ${q(dim)} ORDER BY value DESC LIMIT ${limit}`;

const cfg = (o: { metric?: string; dimension?: string; agg?: AggregationType; chartType?: string; limit?: number }): Partial<QueryConfig> => ({
    metric: o.metric || '',
    dimension: o.dimension || '',
    aggregation: o.agg || AggregationType.COUNT,
    analysisType: AnalysisType.STANDARD,
    ...(o.limit ? { limit: o.limit, sort: 'desc' as const } : {}),
    ...(o.chartType ? { chartType: o.chartType as any } : {}),
});

// ═══════════════════════════════════════════════════════════════════
// TEMPLATE SETS
// ═══════════════════════════════════════════════════════════════════

type DefSink = (d: Omit<DomainKpiDef, 'priority'>) => void;

function healthcareDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    const grainNoun = 'admissions';

    // Admissions trend
    if (r.primaryDate) {
        add({
            id: 'hc_admissions_trend', title: 'Admissions per Month',
            subtitle: `Healthcare KPI · number of ${grainNoun} recorded each month`,
            category: 'trend', chartType: 'area', sql: monthlyCountSQL(r.primaryDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ dimension: r.primaryDate, agg: AggregationType.COUNT, chartType: 'area' }),
        });
    }

    // Average length of stay (needs both dates)
    if (r.primaryDate && r.endDate) {
        const stay = `date_diff('day', ${asDate(r.primaryDate)}, ${asDate(r.endDate)})`;
        const valid = `${asDate(r.primaryDate)} IS NOT NULL AND ${asDate(r.endDate)} IS NOT NULL AND ${asDate(r.endDate)} >= ${asDate(r.primaryDate)}`;
        add({
            id: 'hc_avg_stay', title: 'Average Length of Stay (days)',
            subtitle: `Healthcare KPI · ${humanize(r.primaryDate)} → ${humanize(r.endDate)}`,
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${stay}) AS value FROM data WHERE ${valid}`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
        });
        if (r.condition) {
            add({
                id: 'hc_stay_by_condition', title: 'Average Stay by Condition',
                subtitle: 'Healthcare KPI · which conditions keep patients longest',
                category: 'ranking', chartType: 'horizontalBar',
                sql: `SELECT ${q(r.condition)} AS label, AVG(${stay}) AS value FROM data WHERE ${valid} AND ${q(r.condition)} IS NOT NULL GROUP BY ${q(r.condition)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label', yKey: 'value',
            });
        }
    }

    // Billing
    if (r.money) {
        add({
            id: 'hc_billing_total', title: `Total ${humanize(r.money)}`,
            subtitle: 'Healthcare KPI · sum across all records',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        if (r.department) {
            add({
                id: 'hc_billing_by_dept', title: `${humanize(r.money)} by ${humanize(r.department)}`,
                subtitle: 'Healthcare KPI · where the money is going',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.department),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.department, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.insurance) {
            add({
                id: 'hc_billing_by_insurance', title: `${humanize(r.money)} by ${humanize(r.insurance)}`,
                subtitle: 'Healthcare KPI · payer mix',
                category: 'distribution', chartType: 'donut', sql: sumBySQL(r.money, r.insurance, 8),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.insurance, agg: AggregationType.SUM, limit: 8, chartType: 'donut' }),
            });
        }
    }

    // Doctor workload
    if (r.doctor) {
        add({
            id: 'hc_doctor_workload', title: 'Doctor Workload',
            subtitle: 'Healthcare KPI · patients treated per doctor (top 10)',
            category: 'ranking', chartType: 'horizontalBar', sql: countBySQL(r.doctor),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.doctor, agg: AggregationType.COUNT, limit: 10, chartType: 'horizontalBar' }),
        });
    }

    // Condition frequency
    if (r.condition) {
        add({
            id: 'hc_condition_freq', title: 'Condition Frequency',
            subtitle: 'Healthcare KPI · most common conditions',
            category: 'distribution', chartType: 'bar', sql: countBySQL(r.condition),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.condition, agg: AggregationType.COUNT, limit: 10, chartType: 'bar' }),
        });
    }

    // Readmission rate — only if the id column actually repeats (otherwise it's
    // trivially 0% and misleading).
    if (r.entityId) {
        const ids = new Set<string>();
        let nonNull = 0;
        for (const row of dataset.rows) {
            const v = row[r.entityId];
            if (v !== null && v !== undefined && v !== '') { ids.add(String(v)); nonNull++; }
        }
        if (nonNull > ids.size) {
            add({
                id: 'hc_readmission_rate', title: 'Readmission Rate',
                subtitle: `Healthcare KPI · % of ${humanize(r.entityId).toLowerCase()}s with more than one admission`,
                category: 'kpi', chartType: 'kpiCard',
                sql: `SELECT 100.0 * COUNT(DISTINCT CASE WHEN c > 1 THEN pid END) / NULLIF(COUNT(DISTINCT pid), 0) AS value FROM (SELECT ${q(r.entityId)} AS pid, COUNT(*) AS c FROM data WHERE ${q(r.entityId)} IS NOT NULL GROUP BY ${q(r.entityId)})`,
                xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
            });
        }
    }

    // Gender split
    if (r.gender) {
        add({
            id: 'hc_gender_split', title: `Patients by ${humanize(r.gender)}`,
            subtitle: 'Healthcare KPI · demographic split',
            category: 'distribution', chartType: 'donut', sql: countBySQL(r.gender, 6),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.gender, agg: AggregationType.COUNT, limit: 6, chartType: 'donut' }),
        });
    }
}

function hrDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    add({
        id: 'hr_headcount', title: 'Headcount',
        subtitle: 'HR KPI · total employees in the dataset',
        category: 'kpi', chartType: 'kpiCard',
        sql: r.entityId
            ? `SELECT COUNT(DISTINCT ${q(r.entityId)}) AS value FROM data`
            : `SELECT COUNT(*) AS value FROM data`,
        xKey: 'metric', yKey: 'value', kpiFormat: 'number',
    });
    if (r.salary) {
        add({
            id: 'hr_avg_salary', title: `Average ${humanize(r.salary)}`,
            subtitle: 'HR KPI · mean across all employees',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.salary)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
        });
        if (r.department) {
            add({
                id: 'hr_salary_by_dept', title: `Average ${humanize(r.salary)} by ${humanize(r.department)}`,
                subtitle: 'HR KPI · compensation by department',
                category: 'ranking', chartType: 'horizontalBar',
                sql: `SELECT ${q(r.department)} AS label, AVG(${asNum(r.salary)}) AS value FROM data WHERE ${q(r.department)} IS NOT NULL GROUP BY ${q(r.department)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.salary, dimension: r.department, agg: AggregationType.AVG, limit: 10, chartType: 'horizontalBar' }),
            });
        }
    }
    if (r.department) {
        add({
            id: 'hr_headcount_by_dept', title: `Headcount by ${humanize(r.department)}`,
            subtitle: 'HR KPI · team sizes',
            category: 'ranking', chartType: 'horizontalBar', sql: countBySQL(r.department),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.department, agg: AggregationType.COUNT, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    if (r.hireDate) {
        add({
            id: 'hr_hires_trend', title: 'Hires per Month',
            subtitle: 'HR KPI · hiring pace over time',
            category: 'trend', chartType: 'area', sql: monthlyCountSQL(r.hireDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ dimension: r.hireDate, agg: AggregationType.COUNT, chartType: 'area' }),
        });
    }
    if (r.termDate) {
        add({
            id: 'hr_attrition', title: 'Attrition Rate',
            subtitle: `HR KPI · % of employees with a ${humanize(r.termDate).toLowerCase()}`,
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT 100.0 * COUNT(${asDate(r.termDate)}) / COUNT(*) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
        });
    }
    if (r.gender) {
        add({
            id: 'hr_gender_split', title: `Employees by ${humanize(r.gender)}`,
            subtitle: 'HR KPI · workforce split',
            category: 'distribution', chartType: 'donut', sql: countBySQL(r.gender, 6),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.gender, agg: AggregationType.COUNT, limit: 6, chartType: 'donut' }),
        });
    }
}

function retailDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    if (r.money) {
        if (r.primaryDate) {
            add({
                id: 'rt_revenue_trend', title: `${humanize(r.money)} per Month`,
                subtitle: 'Retail KPI · monthly revenue',
                category: 'trend', chartType: 'area',
                sql: `SELECT ${monthOf(r.primaryDate)} AS period, SUM(${asNum(r.money)}) AS value FROM data WHERE ${asDate(r.primaryDate)} IS NOT NULL GROUP BY period ORDER BY period`,
                xKey: 'period', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.primaryDate, agg: AggregationType.SUM, chartType: 'area' }),
            });
        }
        if (r.product) {
            add({
                id: 'rt_top_products', title: `Top Products by ${humanize(r.money)}`,
                subtitle: 'Retail KPI · best sellers',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.product),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.product, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.category) {
            add({
                id: 'rt_revenue_by_category', title: `${humanize(r.money)} by ${humanize(r.category)}`,
                subtitle: 'Retail KPI · category mix',
                category: 'distribution', chartType: 'donut', sql: sumBySQL(r.money, r.category, 8),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.category, agg: AggregationType.SUM, limit: 8, chartType: 'donut' }),
            });
        }
        if (r.region) {
            add({
                id: 'rt_revenue_by_region', title: `${humanize(r.money)} by ${humanize(r.region)}`,
                subtitle: 'Retail KPI · geographic mix',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.region),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.region, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.customer) {
            add({
                id: 'rt_top_customers', title: `Top Customers by ${humanize(r.money)}`,
                subtitle: 'Retail KPI · who drives revenue',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.customer),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.customer, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        // Average order value
        if (r.orderId) {
            add({
                id: 'rt_aov', title: 'Average Order Value',
                subtitle: `Retail KPI · SUM(${humanize(r.money)}) ÷ distinct orders`,
                category: 'kpi', chartType: 'kpiCard',
                sql: `SELECT SUM(${asNum(r.money)}) / NULLIF(COUNT(DISTINCT ${q(r.orderId)}), 0) AS value FROM data`,
                xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            });
        }
    }
    if (r.primaryDate) {
        add({
            id: 'rt_orders_trend', title: 'Transactions per Month',
            subtitle: 'Retail KPI · order volume over time',
            category: 'trend', chartType: 'line', sql: monthlyCountSQL(r.primaryDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ dimension: r.primaryDate, agg: AggregationType.COUNT, chartType: 'line' }),
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the domain KPI definitions for a dataset. Returns [] when neither the
 * detected domain nor the columns map to a known template set (the generic
 * auto-insights still cover that case).
 */
export function buildDomainKpiDefs(dataset: Dataset): DomainKpiDef[] {
    const model = dataset.semanticModel as SemanticModel | undefined;
    if (!model) return [];

    const roles = resolveRoles(dataset, model);
    const domain = resolveKpiDomain((dataset as any).domainProfile?.domain, roles);
    if (domain === 'none') return [];

    const defs: DomainKpiDef[] = [];
    let p = 0.01;
    const add: DefSink = d => defs.push({ ...d, priority: p += 0.01 });

    switch (domain) {
        case 'healthcare': healthcareDefs(roles, dataset, add); break;
        case 'hr': hrDefs(roles, dataset, add); break;
        case 'retail':
        case 'finance': retailDefs(roles, dataset, add); break;
    }

    console.log(`[DomainKPI] domain=${domain} → ${defs.length} KPI templates instantiated:`, defs.map(d => d.id));
    return defs;
}
