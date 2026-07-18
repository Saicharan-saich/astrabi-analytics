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
    entityId?: string;      // patient/customer/employee/student/order id
    primaryDate?: string;
    endDate?: string;       // discharge / termination / delivery
    money?: string;         // billing / revenue / salary measure
    department?: string;
    region?: string;
    gender?: string;
    status?: string;
    age?: string;
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
    // education
    course?: string;
    teacher?: string;
    score?: string;
    // manufacturing
    machine?: string;
    shift?: string;
    unitsProduced?: string;
    defects?: string;
    downtime?: string;
    // marketing
    campaign?: string;
    channel?: string;
    impressions?: string;
    clicks?: string;
    conversions?: string;
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

    // Columns whose CONTENT is numeric, regardless of how the ETL classified
    // them. Low-cardinality numerics (age, conversions, defect counts, ratings)
    // are often classified as DIMENSION or ID and never reach model.measures —
    // but they're still perfectly aggregatable (all KPI SQL uses TRY_CAST).
    const dateSet = new Set(dateNames);
    const numericish = allNames.filter(nm => {
        if (dateSet.has(nm)) return false;
        let seen = 0, ok = 0;
        for (const row of dataset.rows) {
            const v = row[nm];
            if (v === null || v === undefined || v === '') continue;
            seen++;
            if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) ok++;
            if (seen >= 50) break;
        }
        return seen > 0 && ok / seen >= 0.9;
    });
    /** Numeric role: prefer a recognized measure, fall back to numeric content. */
    const findNum = (pat: RegExp) => findCol(measureNames, pat) || findCol(numericish, pat);

    const r: ResolvedRoles = {};
    r.entityId = findCol(allNames, /\b(patient|customer|employee|member|client|person|student|user)\b.*\b(id|no|number|code)\b/)
        || findCol(allNames, /\bmrn\b/);
    r.orderId = findCol(allNames, /\b(order|invoice|transaction|receipt|ticket)\b.*\b(id|no|number)\b/);

    r.hireDate = findCol(dateNames, /\b(hire|hired|join|joining|start)\b/);
    r.termDate = findCol(dateNames, /\b(term|termination|exit|leave|resignation|end)\b/);
    const admitDate = findCol(dateNames, /\b(admission|admit|check in|arrival|visit|order|purchase|transaction|enrollment|enrolled)\b/);
    r.endDate = findCol(dateNames, /\b(discharge|release|check out|departure|delivery|ship)\b/);
    r.primaryDate = admitDate || model.primaryDateColumn || dateNames[0];

    r.money = findNum(/\b(billing|bill|charge|revenue|sales|amount|cost|fee|price|payment|total|spend|budget|tuition)\b/)
        || model.measures.find(m => (m.format === 'currency_usd' || m.format === 'currency_eur') && !m.isHidden)?.column;
    r.salary = findNum(/\b(salary|wage|pay|compensation|income)\b/);
    r.quantity = findNum(/\b(quantity|qty|units)\b/);
    r.age = findNum(/\bage\b/);
    r.score = findNum(/\b(score|grade|marks|gpa|result|percentage)\b/);
    r.unitsProduced = findNum(/\b(units|output|production|produced|volume|yield)\b/) || r.quantity;
    r.defects = findNum(/\b(defect|defects|reject|rejects|scrap|fault|faults|failures)\b/);
    r.downtime = findNum(/\b(downtime|down time|idle|outage)\b/);
    r.impressions = findNum(/\b(impression|impressions|views|reach)\b/);
    r.clicks = findNum(/\b(click|clicks)\b/);
    r.conversions = findNum(/\b(conversion|conversions|signups|leads|acquisitions|purchases)\b/);

    r.doctor = findCol(dimNames, /\b(doctor|physician|provider|surgeon|clinician|nurse)\b/);
    r.condition = findCol(dimNames, /\b(condition|diagnosis|disease|illness|procedure|treatment)\b/);
    r.insurance = findCol(dimNames, /\b(insurance|payer|coverage|carrier)\b/);
    r.department = findCol(dimNames, /\b(department|dept|division|unit|ward|specialty|team)\b/)
        || findCol(dimNames, /\b(hospital|facility|clinic|branch|store|site)\b/);
    r.region = findCol(dimNames, /\b(region|state|country|city|location|market|territory)\b/);
    r.gender = findCol(dimNames, /\b(gender|sex)\b/);
    r.status = findCol(dimNames, /\b(status|state|stage|outcome|result)\b/);
    r.product = findCol(dimNames, /\b(product|item|sku|service)\b/);
    r.category = findCol(dimNames, /\b(category|segment|class|brand|type)\b/);
    r.customer = findCol(dimNames, /\b(customer|client|buyer|account)\b/);
    r.role = findCol(dimNames, /\b(role|title|position|job|designation)\b/);
    r.course = findCol(dimNames, /\b(course|subject|program|major|module|degree)\b/);
    r.teacher = findCol(dimNames, /\b(teacher|instructor|professor|faculty|tutor|lecturer)\b/);
    r.machine = findCol(dimNames, /\b(machine|line|equipment|workstation|plant|factory|cell)\b/);
    r.shift = findCol(dimNames, /\bshift\b/);
    r.campaign = findCol(dimNames, /\b(campaign|promo|promotion|ad group|adset|creative)\b/);
    r.channel = findCol(dimNames, /\b(channel|source|medium|platform)\b/);

    return r;
}

// ═══════════════════════════════════════════════════════════════════
// DOMAIN RESOLUTION
// ═══════════════════════════════════════════════════════════════════

export type KpiDomain =
    | 'healthcare' | 'hr' | 'retail' | 'finance'
    | 'education' | 'manufacturing' | 'marketing' | 'none';

/** Map the (AI or heuristic) domain string — or, failing that, the resolved
 *  roles themselves — to a KPI template set. */
export function resolveKpiDomain(domainStr: string | undefined, roles: ResolvedRoles): KpiDomain {
    const d = (domainStr || '').toLowerCase();
    if (/health|hospital|medical|clinic|patient|pharma/.test(d)) return 'healthcare';
    if (/\bhr\b|human resource|employee|workforce|people|payroll/.test(d)) return 'hr';
    if (/education|school|university|college|academic|student/.test(d)) return 'education';
    if (/manufactur|production|factory|plant|industrial|assembly/.test(d)) return 'manufacturing';
    if (/marketing|advertis|campaign|\bads?\b|media/.test(d)) return 'marketing';
    if (/retail|commerce|sales|shop|marketplace/.test(d)) return 'retail';
    if (/finance|banking|accounting|financial|invoic|payment|transaction|expense/.test(d)) return 'finance';
    // Infer from what the columns look like when the domain label is unhelpful.
    // Order: most-specific signals first.
    if (roles.doctor || roles.condition || (roles.insurance && roles.endDate)) return 'healthcare';
    if (roles.machine || roles.defects || (roles.unitsProduced && roles.shift)) return 'manufacturing';
    if (roles.campaign || (roles.impressions && roles.clicks)) return 'marketing';
    if (roles.course || roles.teacher || (roles.score && roles.entityId && /student/.test(norm(roles.entityId)))) return 'education';
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

const avgBySQL = (measure: string, dim: string, limit = 10) =>
    `SELECT ${q(dim)} AS label, AVG(${asNum(measure)}) AS value FROM data WHERE ${q(dim)} IS NOT NULL GROUP BY ${q(dim)} ORDER BY value DESC LIMIT ${limit}`;

const monthlySumSQL = (measure: string, dateCol: string) =>
    `SELECT ${monthOf(dateCol)} AS period, SUM(${asNum(measure)}) AS value FROM data WHERE ${asDate(dateCol)} IS NOT NULL GROUP BY period ORDER BY period`;

/** mult × SUM(numerator) / SUM(denominator) as a single KPI value. */
const ratioKpiSQL = (numerator: string, denominator: string, mult = 1) =>
    `SELECT ${mult} * SUM(${asNum(numerator)}) / NULLIF(SUM(${asNum(denominator)}), 0) AS value FROM data`;

/** Aggregate by day-of-week, ordered Sun→Sat. */
const byWeekdaySQL = (measure: string, dateCol: string) =>
    `SELECT dayname(${asDate(dateCol)}) AS label, MIN(strftime(${asDate(dateCol)}, '%w')) AS idx, SUM(${asNum(measure)}) AS value FROM data WHERE ${asDate(dateCol)} IS NOT NULL GROUP BY label ORDER BY idx`;

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
        add({
            id: 'hc_avg_billing', title: `Average ${humanize(r.money)} per Admission`,
            subtitle: 'Healthcare KPI · mean cost per record',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
        if (r.primaryDate) {
            add({
                id: 'hc_billing_trend', title: `${humanize(r.money)} per Month`,
                subtitle: 'Healthcare KPI · monthly billing volume',
                category: 'trend', chartType: 'area', sql: monthlySumSQL(r.money, r.primaryDate),
                xKey: 'period', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.primaryDate, agg: AggregationType.SUM, chartType: 'area' }),
            });
        }
        if (r.doctor) {
            add({
                id: 'hc_billing_by_doctor', title: `${humanize(r.money)} by ${humanize(r.doctor)}`,
                subtitle: 'Healthcare KPI · revenue per doctor (top 10)',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.doctor),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.doctor, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
    }

    // Admissions by department + average patient age
    if (r.department) {
        add({
            id: 'hc_admissions_by_dept', title: `Admissions by ${humanize(r.department)}`,
            subtitle: 'Healthcare KPI · caseload per department',
            category: 'ranking', chartType: 'horizontalBar', sql: countBySQL(r.department),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.department, agg: AggregationType.COUNT, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    if (r.age) {
        add({
            id: 'hc_avg_age', title: 'Average Patient Age',
            subtitle: 'Healthcare KPI · mean age across admissions',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.age)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
            config: cfg({ metric: r.age, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
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
        if (r.department) {
            add({
                id: 'hr_attrition_by_dept', title: `Attrition Rate by ${humanize(r.department)}`,
                subtitle: 'HR KPI · where people are leaving',
                category: 'ranking', chartType: 'horizontalBar',
                sql: `SELECT ${q(r.department)} AS label, 100.0 * COUNT(${asDate(r.termDate)}) / COUNT(*) AS value FROM data WHERE ${q(r.department)} IS NOT NULL GROUP BY ${q(r.department)} ORDER BY value DESC LIMIT 10`,
                xKey: 'label', yKey: 'value',
            });
        }
    }
    if (r.salary) {
        add({
            id: 'hr_payroll_total', title: `Total ${humanize(r.salary)} Cost`,
            subtitle: 'HR KPI · total payroll across the dataset',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.salary)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.salary, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        if (r.role) {
            add({
                id: 'hr_salary_by_role', title: `Average ${humanize(r.salary)} by ${humanize(r.role)}`,
                subtitle: 'HR KPI · compensation by role',
                category: 'ranking', chartType: 'horizontalBar', sql: avgBySQL(r.salary, r.role),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.salary, dimension: r.role, agg: AggregationType.AVG, limit: 10, chartType: 'horizontalBar' }),
            });
        }
    }
    if (r.role) {
        add({
            id: 'hr_headcount_by_role', title: `Headcount by ${humanize(r.role)}`,
            subtitle: 'HR KPI · role distribution',
            category: 'distribution', chartType: 'bar', sql: countBySQL(r.role),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.role, agg: AggregationType.COUNT, limit: 10, chartType: 'bar' }),
        });
    }
    if (r.age) {
        add({
            id: 'hr_avg_age', title: 'Average Employee Age',
            subtitle: 'HR KPI · workforce age profile',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.age)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
            config: cfg({ metric: r.age, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
    }
    if (r.region) {
        add({
            id: 'hr_headcount_by_region', title: `Headcount by ${humanize(r.region)}`,
            subtitle: 'HR KPI · geographic footprint',
            category: 'ranking', chartType: 'horizontalBar', sql: countBySQL(r.region),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.region, agg: AggregationType.COUNT, limit: 10, chartType: 'horizontalBar' }),
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
    if (r.money && r.primaryDate) {
        add({
            id: 'rt_revenue_by_weekday', title: `${humanize(r.money)} by Day of Week`,
            subtitle: 'Retail KPI · busiest sales days',
            category: 'comparative', chartType: 'bar', sql: byWeekdaySQL(r.money, r.primaryDate),
            xKey: 'label', yKey: 'value',
        });
    }
    if (r.money && !r.orderId) {
        // No order id → per-row average stands in for AOV.
        add({
            id: 'rt_avg_txn', title: 'Average Transaction Value',
            subtitle: `Retail KPI · mean ${humanize(r.money).toLowerCase()} per record`,
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
    }
    if (r.quantity && r.product) {
        add({
            id: 'rt_qty_by_product', title: `${humanize(r.quantity)} Sold by ${humanize(r.product)}`,
            subtitle: 'Retail KPI · volume leaders',
            category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.quantity, r.product),
            xKey: 'label', yKey: 'value',
            config: cfg({ metric: r.quantity, dimension: r.product, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    // Repeat-customer rate — only when the customer identifier actually repeats.
    const custCol = r.entityId || r.customer;
    if (custCol) {
        const ids = new Set<string>();
        let nonNull = 0;
        for (const row of dataset.rows) {
            const v = row[custCol];
            if (v !== null && v !== undefined && v !== '') { ids.add(String(v)); nonNull++; }
        }
        if (nonNull > ids.size) {
            add({
                id: 'rt_repeat_rate', title: 'Repeat Customer Rate',
                subtitle: `Retail KPI · % of ${humanize(custCol).toLowerCase()}s with more than one purchase`,
                category: 'kpi', chartType: 'kpiCard',
                sql: `SELECT 100.0 * COUNT(DISTINCT CASE WHEN c > 1 THEN cid END) / NULLIF(COUNT(DISTINCT cid), 0) AS value FROM (SELECT ${q(custCol)} AS cid, COUNT(*) AS c FROM data WHERE ${q(custCol)} IS NOT NULL GROUP BY ${q(custCol)})`,
                xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
            });
        }
    }
}

function financeDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    if (r.money) {
        add({
            id: 'fin_total_amount', title: `Total ${humanize(r.money)}`,
            subtitle: 'Finance KPI · sum across all transactions',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        add({
            id: 'fin_avg_txn', title: `Average ${humanize(r.money)}`,
            subtitle: 'Finance KPI · mean transaction size',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
        if (r.primaryDate) {
            add({
                id: 'fin_amount_trend', title: `${humanize(r.money)} per Month`,
                subtitle: 'Finance KPI · monthly flow',
                category: 'trend', chartType: 'area', sql: monthlySumSQL(r.money, r.primaryDate),
                xKey: 'period', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.primaryDate, agg: AggregationType.SUM, chartType: 'area' }),
            });
        }
        if (r.category) {
            add({
                id: 'fin_amount_by_category', title: `${humanize(r.money)} by ${humanize(r.category)}`,
                subtitle: 'Finance KPI · where the money flows',
                category: 'distribution', chartType: 'donut', sql: sumBySQL(r.money, r.category, 8),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.category, agg: AggregationType.SUM, limit: 8, chartType: 'donut' }),
            });
        }
        if (r.customer) {
            add({
                id: 'fin_amount_by_account', title: `${humanize(r.money)} by ${humanize(r.customer)}`,
                subtitle: 'Finance KPI · largest accounts (top 10)',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.customer),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.customer, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.region) {
            add({
                id: 'fin_amount_by_region', title: `${humanize(r.money)} by ${humanize(r.region)}`,
                subtitle: 'Finance KPI · geographic mix',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.region),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.region, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.status) {
            add({
                id: 'fin_amount_by_status', title: `${humanize(r.money)} by ${humanize(r.status)}`,
                subtitle: 'Finance KPI · paid vs pending vs overdue',
                category: 'distribution', chartType: 'donut', sql: sumBySQL(r.money, r.status, 6),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.status, agg: AggregationType.SUM, limit: 6, chartType: 'donut' }),
            });
        }
    }
    if (r.primaryDate) {
        add({
            id: 'fin_txn_trend', title: 'Transactions per Month',
            subtitle: 'Finance KPI · activity volume',
            category: 'trend', chartType: 'line', sql: monthlyCountSQL(r.primaryDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ dimension: r.primaryDate, agg: AggregationType.COUNT, chartType: 'line' }),
        });
    }
}

function educationDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    add({
        id: 'ed_total_students', title: 'Total Students',
        subtitle: 'Education KPI · students in the dataset',
        category: 'kpi', chartType: 'kpiCard',
        sql: r.entityId
            ? `SELECT COUNT(DISTINCT ${q(r.entityId)}) AS value FROM data`
            : `SELECT COUNT(*) AS value FROM data`,
        xKey: 'metric', yKey: 'value', kpiFormat: 'number',
    });
    if (r.primaryDate) {
        add({
            id: 'ed_enrollments_trend', title: 'Enrollments per Month',
            subtitle: 'Education KPI · intake over time',
            category: 'trend', chartType: 'area', sql: monthlyCountSQL(r.primaryDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ dimension: r.primaryDate, agg: AggregationType.COUNT, chartType: 'area' }),
        });
    }
    if (r.score) {
        add({
            id: 'ed_avg_score', title: `Average ${humanize(r.score)}`,
            subtitle: 'Education KPI · overall academic performance',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT AVG(${asNum(r.score)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
            config: cfg({ metric: r.score, agg: AggregationType.AVG, chartType: 'kpi' }),
        });
        if (r.course) {
            add({
                id: 'ed_score_by_course', title: `Average ${humanize(r.score)} by ${humanize(r.course)}`,
                subtitle: 'Education KPI · strongest and weakest subjects',
                category: 'ranking', chartType: 'horizontalBar', sql: avgBySQL(r.score, r.course),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.score, dimension: r.course, agg: AggregationType.AVG, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.teacher) {
            add({
                id: 'ed_score_by_teacher', title: `Average ${humanize(r.score)} by ${humanize(r.teacher)}`,
                subtitle: 'Education KPI · outcomes per instructor',
                category: 'ranking', chartType: 'horizontalBar', sql: avgBySQL(r.score, r.teacher),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.score, dimension: r.teacher, agg: AggregationType.AVG, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.gender) {
            add({
                id: 'ed_score_by_gender', title: `Average ${humanize(r.score)} by ${humanize(r.gender)}`,
                subtitle: 'Education KPI · performance split',
                category: 'comparative', chartType: 'bar', sql: avgBySQL(r.score, r.gender, 6),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.score, dimension: r.gender, agg: AggregationType.AVG, limit: 6, chartType: 'bar' }),
            });
        }
    }
    if (r.course) {
        add({
            id: 'ed_students_per_course', title: `Students per ${humanize(r.course)}`,
            subtitle: 'Education KPI · most popular courses',
            category: 'distribution', chartType: 'bar', sql: countBySQL(r.course),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.course, agg: AggregationType.COUNT, limit: 10, chartType: 'bar' }),
        });
    }
    if (r.teacher) {
        add({
            id: 'ed_teacher_load', title: `Students per ${humanize(r.teacher)}`,
            subtitle: 'Education KPI · teaching load (top 10)',
            category: 'ranking', chartType: 'horizontalBar', sql: countBySQL(r.teacher),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.teacher, agg: AggregationType.COUNT, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    if (r.status) {
        add({
            id: 'ed_by_status', title: `Students by ${humanize(r.status)}`,
            subtitle: 'Education KPI · pass / fail / enrolled mix',
            category: 'distribution', chartType: 'donut', sql: countBySQL(r.status, 6),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.status, agg: AggregationType.COUNT, limit: 6, chartType: 'donut' }),
        });
    }
    if (r.money) {
        add({
            id: 'ed_fees_total', title: `Total ${humanize(r.money)}`,
            subtitle: 'Education KPI · fees / tuition collected',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
    }
}

function manufacturingDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    if (r.unitsProduced) {
        add({
            id: 'mf_units_total', title: `Total ${humanize(r.unitsProduced)}`,
            subtitle: 'Manufacturing KPI · units produced',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.unitsProduced)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
            config: cfg({ metric: r.unitsProduced, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        if (r.primaryDate) {
            add({
                id: 'mf_production_trend', title: 'Production per Month',
                subtitle: 'Manufacturing KPI · output over time',
                category: 'trend', chartType: 'area', sql: monthlySumSQL(r.unitsProduced, r.primaryDate),
                xKey: 'period', yKey: 'value',
                config: cfg({ metric: r.unitsProduced, dimension: r.primaryDate, agg: AggregationType.SUM, chartType: 'area' }),
            });
        }
        if (r.machine) {
            add({
                id: 'mf_output_by_machine', title: `${humanize(r.unitsProduced)} by ${humanize(r.machine)}`,
                subtitle: 'Manufacturing KPI · output per machine/line',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.unitsProduced, r.machine),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.unitsProduced, dimension: r.machine, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.shift) {
            add({
                id: 'mf_output_by_shift', title: `${humanize(r.unitsProduced)} by ${humanize(r.shift)}`,
                subtitle: 'Manufacturing KPI · shift comparison',
                category: 'comparative', chartType: 'bar', sql: sumBySQL(r.unitsProduced, r.shift, 6),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.unitsProduced, dimension: r.shift, agg: AggregationType.SUM, limit: 6, chartType: 'bar' }),
            });
        }
        if (r.defects) {
            add({
                id: 'mf_defect_rate', title: 'Defect Rate',
                subtitle: `Manufacturing KPI · ${humanize(r.defects).toLowerCase()} as % of ${humanize(r.unitsProduced).toLowerCase()}`,
                category: 'kpi', chartType: 'kpiCard',
                sql: ratioKpiSQL(r.defects, r.unitsProduced, 100),
                xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
            });
        }
        if (r.money) {
            add({
                id: 'mf_cost_per_unit', title: 'Cost per Unit',
                subtitle: `Manufacturing KPI · SUM(${humanize(r.money)}) ÷ SUM(${humanize(r.unitsProduced)})`,
                category: 'kpi', chartType: 'kpiCard',
                sql: ratioKpiSQL(r.money, r.unitsProduced),
                xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            });
        }
    }
    if (r.defects && r.machine) {
        add({
            id: 'mf_defects_by_machine', title: `${humanize(r.defects)} by ${humanize(r.machine)}`,
            subtitle: 'Manufacturing KPI · quality problem hotspots',
            category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.defects, r.machine),
            xKey: 'label', yKey: 'value',
            config: cfg({ metric: r.defects, dimension: r.machine, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    if (r.downtime) {
        add({
            id: 'mf_downtime_total', title: `Total ${humanize(r.downtime)}`,
            subtitle: 'Manufacturing KPI · lost capacity',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.downtime)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'number',
            config: cfg({ metric: r.downtime, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        if (r.machine) {
            add({
                id: 'mf_downtime_by_machine', title: `${humanize(r.downtime)} by ${humanize(r.machine)}`,
                subtitle: 'Manufacturing KPI · least reliable equipment',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.downtime, r.machine),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.downtime, dimension: r.machine, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
    }
    if (r.status) {
        add({
            id: 'mf_by_status', title: `Records by ${humanize(r.status)}`,
            subtitle: 'Manufacturing KPI · pass / rework / scrap mix',
            category: 'distribution', chartType: 'donut', sql: countBySQL(r.status, 6),
            xKey: 'label', yKey: 'value',
            config: cfg({ dimension: r.status, agg: AggregationType.COUNT, limit: 6, chartType: 'donut' }),
        });
    }
}

function marketingDefs(r: ResolvedRoles, dataset: Dataset, add: DefSink): void {
    if (r.money) {
        add({
            id: 'mk_spend_total', title: `Total ${humanize(r.money)}`,
            subtitle: 'Marketing KPI · budget spent',
            category: 'kpi', chartType: 'kpiCard',
            sql: `SELECT SUM(${asNum(r.money)}) AS value FROM data`,
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
            config: cfg({ metric: r.money, agg: AggregationType.SUM, chartType: 'kpi' }),
        });
        if (r.campaign) {
            add({
                id: 'mk_spend_by_campaign', title: `${humanize(r.money)} by ${humanize(r.campaign)}`,
                subtitle: 'Marketing KPI · budget allocation',
                category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.money, r.campaign),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.campaign, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
            });
        }
        if (r.channel) {
            add({
                id: 'mk_spend_by_channel', title: `${humanize(r.money)} by ${humanize(r.channel)}`,
                subtitle: 'Marketing KPI · channel mix',
                category: 'distribution', chartType: 'donut', sql: sumBySQL(r.money, r.channel, 8),
                xKey: 'label', yKey: 'value',
                config: cfg({ metric: r.money, dimension: r.channel, agg: AggregationType.SUM, limit: 8, chartType: 'donut' }),
            });
        }
    }
    if (r.impressions && r.clicks) {
        add({
            id: 'mk_ctr', title: 'Click-Through Rate (CTR)',
            subtitle: `Marketing KPI · ${humanize(r.clicks).toLowerCase()} ÷ ${humanize(r.impressions).toLowerCase()}`,
            category: 'kpi', chartType: 'kpiCard',
            sql: ratioKpiSQL(r.clicks, r.impressions, 100),
            xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
        });
    }
    if (r.clicks && r.conversions) {
        add({
            id: 'mk_conversion_rate', title: 'Conversion Rate',
            subtitle: `Marketing KPI · ${humanize(r.conversions).toLowerCase()} ÷ ${humanize(r.clicks).toLowerCase()}`,
            category: 'kpi', chartType: 'kpiCard',
            sql: ratioKpiSQL(r.conversions, r.clicks, 100),
            xKey: 'metric', yKey: 'value', kpiFormat: 'percent',
        });
    }
    if (r.money && r.clicks) {
        add({
            id: 'mk_cpc', title: 'Cost per Click (CPC)',
            subtitle: 'Marketing KPI · spend ÷ clicks',
            category: 'kpi', chartType: 'kpiCard',
            sql: ratioKpiSQL(r.money, r.clicks),
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
        });
    }
    if (r.money && r.conversions) {
        add({
            id: 'mk_cpa', title: 'Cost per Conversion (CPA)',
            subtitle: 'Marketing KPI · spend ÷ conversions',
            category: 'kpi', chartType: 'kpiCard',
            sql: ratioKpiSQL(r.money, r.conversions),
            xKey: 'metric', yKey: 'value', kpiFormat: 'currency_usd',
        });
    }
    if (r.conversions && r.channel) {
        add({
            id: 'mk_conversions_by_channel', title: `${humanize(r.conversions)} by ${humanize(r.channel)}`,
            subtitle: 'Marketing KPI · which channels convert',
            category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.conversions, r.channel),
            xKey: 'label', yKey: 'value',
            config: cfg({ metric: r.conversions, dimension: r.channel, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
        });
    }
    if (r.clicks && r.primaryDate) {
        add({
            id: 'mk_clicks_trend', title: `${humanize(r.clicks)} per Month`,
            subtitle: 'Marketing KPI · engagement over time',
            category: 'trend', chartType: 'area', sql: monthlySumSQL(r.clicks, r.primaryDate),
            xKey: 'period', yKey: 'value',
            config: cfg({ metric: r.clicks, dimension: r.primaryDate, agg: AggregationType.SUM, chartType: 'area' }),
        });
    }
    if (r.campaign && r.conversions) {
        add({
            id: 'mk_conversions_by_campaign', title: `${humanize(r.conversions)} by ${humanize(r.campaign)}`,
            subtitle: 'Marketing KPI · best performing campaigns',
            category: 'ranking', chartType: 'horizontalBar', sql: sumBySQL(r.conversions, r.campaign),
            xKey: 'label', yKey: 'value',
            config: cfg({ metric: r.conversions, dimension: r.campaign, agg: AggregationType.SUM, limit: 10, chartType: 'horizontalBar' }),
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
        case 'retail': retailDefs(roles, dataset, add); break;
        case 'finance': financeDefs(roles, dataset, add); break;
        case 'education': educationDefs(roles, dataset, add); break;
        case 'manufacturing': manufacturingDefs(roles, dataset, add); break;
        case 'marketing': marketingDefs(roles, dataset, add); break;
    }

    console.log(`[DomainKPI] domain=${domain} → ${defs.length} KPI templates instantiated:`, defs.map(d => d.id));
    return defs;
}
