/**
 * sqlTemplateResolver.ts — Deterministic SQL template resolver.
 *
 * Strategy (in order):
 * 1. HEURISTIC — Match column names directly against known patterns (most reliable)
 * 2. AI PROFILE — If available, use AI-detected column semantics as verification
 * 3. TYPE FALLBACK — Find columns by their detected data type (ID, DATE, METRIC)
 *
 * "FROM data" explanation: alasql loads the uploaded dataset rows into an in-memory
 * table called "data". This is NOT duplicating data — it's the standard way alasql
 * accesses the uploaded rows for SQL execution.
 */
import type { Dataset } from '../types';
import { ColumnType } from '../types';

// ═══════════════════════════════════════════════════════════════════
// Direct column name patterns for each semantic placeholder.
// These are checked FIRST and are the most reliable resolution method.
// Order matters: first match wins, so put most specific patterns first.
// ═══════════════════════════════════════════════════════════════════
const PLACEHOLDER_PATTERNS: Record<string, string[]> = {
    // ─── UNIVERSAL ENTITY PLACEHOLDERS ───────────────────────────────
    '{entity_id}': [
        'emp_id', 'employee_id', 'empid', 'staff_id', 'worker_id',
        'patient_id', 'patientid', 'mrn',
        'student_id', 'studentid', 'learner_id', 'enrollment_id',
        'customer_id', 'customerid', 'cust_id', 'client_id',
        'user_id', 'userid', 'member_id', 'account_id',
        'person_id', 'contact_id', 'subscriber_id',
        'order_id', 'orderid', 'transaction_id', 'txn_id', 'invoice_id',
        'ticket_id', 'case_id', 'lead_id', 'deal_id',
    ],
    '{entity_name}': [
        'emp_name', 'employee_name', 'staff_name', 'worker_name',
        'patient_name', 'student_name', 'learner_name',
        'customer_name', 'cust_name', 'client_name',
        'user_name', 'username', 'full_name', 'name',
        'first_name', 'display_name', 'person_name',
    ],

    // ─── DIMENSION PLACEHOLDERS ──────────────────────────────────────
    '{dept}': [
        'dept_name', 'department_name', 'department', 'dept',
        'division', 'division_name', 'section', 'section_name',
        'business_unit', 'unit', 'team', 'team_name',
        'program', 'program_name', 'faculty', 'school',
        'ward', 'ward_name', 'unit_name',
    ],
    '{category}': [
        'category', 'product_category', 'sub_category', 'subcategory',
        'item_category', 'type', 'segment', 'group', 'class',
        'classification', 'tier', 'grade', 'level',
        'plan_type', 'plan', 'subscription_type', 'plan_name',
        'account_type', 'expense_type', 'cost_center',
        'diagnosis', 'diagnosis_group', 'condition', 'icd_code',
        'payer_type', 'insurance_type', 'coverage_type',
    ],
    '{product}': [
        'product_name', 'product', 'item_name', 'item', 'sku',
        'service', 'service_name', 'offering',
        'course', 'course_name', 'subject', 'module',
        'campaign', 'campaign_name', 'ad_name',
        'feature', 'feature_name', 'content', 'content_name',
    ],
    '{region}': [
        'region', 'territory', 'zone', 'area', 'market',
        'geo', 'geography', 'continent',
        'country', 'country_name', 'state', 'province',
    ],
    '{location}': [
        'city', 'location', 'location_name', 'branch', 'branch_name',
        'office', 'office_name', 'site', 'site_name',
        'campus', 'warehouse', 'warehouse_name', 'store', 'store_name',
        'facility', 'facility_name', 'clinic', 'hospital',
    ],
    '{source}': [
        'source', 'channel', 'traffic_source', 'medium', 'platform',
        'marketing_channel', 'origin', 'referral_source',
        'utm_source', 'acquisition_channel', 'lead_source',
        'supplier', 'supplier_name', 'vendor', 'vendor_name',
    ],
    '{gender}': [
        'gender', 'sex', 'gender_identity',
    ],
    '{emp_type}': [
        'employment_type', 'emp_type', 'work_type', 'job_type',
        'contract_type', 'full_time_part_time', 'employee_type',
        'worker_type', 'status_type',
    ],
    '{status}': [
        'status', 'employee_status', 'emp_status',
        'is_active', 'active', 'current_status',
        'employment_status', 'work_status',
        'order_status', 'payment_status', 'subscription_status',
        'patient_status', 'enrollment_status', 'account_status',
    ],
    '{exit_type}': [
        'exit_type', 'separation_type', 'termination_type',
        'reason_for_leaving', 'exit_reason', 'departure_type',
        'voluntary_involuntary', 'resignation_type',
        'churn_reason', 'cancellation_reason',
    ],

    // ─── METRIC PLACEHOLDERS ─────────────────────────────────────────
    '{salary}': [
        'salary', 'base_salary', 'annual_salary', 'pay', 'wage',
        'compensation', 'base_pay', 'gross_pay', 'net_pay',
        'total_pay', 'hourly_rate', 'monthly_salary',
    ],
    '{revenue}': [
        'revenue', 'sales', 'total_sales', 'gross_revenue', 'net_revenue',
        'income', 'total_income', 'amount', 'total_amount',
        'billing', 'total_billing', 'proceeds', 'turnover',
        'mrr', 'arr', 'recurring_revenue', 'subscription_revenue',
        'tuition', 'fees', 'total_fees',
    ],
    '{cost}': [
        'cost', 'expense', 'total_cost', 'total_expense', 'cogs',
        'cost_of_goods', 'operating_expense', 'opex',
        'spend', 'ad_spend', 'marketing_spend', 'budget',
        'price', 'unit_price', 'unit_cost',
    ],
    '{profit}': [
        'profit', 'net_profit', 'gross_profit', 'net_income',
        'ebitda', 'operating_income', 'margin',
        'contribution', 'contribution_margin',
    ],
    '{quantity}': [
        'quantity', 'qty', 'units', 'volume', 'count',
        'stock', 'stock_on_hand', 'on_hand', 'inventory',
        'impressions', 'clicks', 'views', 'visits', 'sessions',
        'hours', 'days', 'items', 'pieces',
    ],
    '{rating}': [
        'performance_rating', 'rating', 'overall_rating',
        'review_rating', 'appraisal_rating', 'performance_score',
        'eval_rating', 'assessment_rating',
        'star_rating', 'quality_rating', 'satisfaction_rating',
    ],
    '{score}': [
        'engagement_score', 'satisfaction_score', 'score',
        'nps', 'feedback_score', 'survey_score',
        'happiness_score', 'wellness_score',
        'gpa', 'grade', 'test_score', 'exam_score',
        'quality_score', 'compliance_score', 'risk_score',
    ],
    '{rate}': [
        'rate', 'percentage', 'pct', 'attrition_rate',
        'turnover_rate', 'retention_rate', 'absenteeism_rate',
        'conversion_rate', 'churn_rate', 'growth_rate',
        'occupancy_rate', 'utilization_rate', 'fill_rate',
        'acceptance_rate', 'pass_rate', 'completion_rate',
        'open_rate', 'click_rate', 'bounce_rate',
    ],

    // ─── DATE PLACEHOLDERS ───────────────────────────────────────────
    '{hire_date}': [
        'doj', 'date_of_joining', 'hire_date', 'hired_date',
        'start_date', 'join_date', 'joining_date',
        'enrollment_date', 'admission_date', 'onboard_date',
        'created_at', 'registration_date', 'signup_date',
    ],
    '{order_date}': [
        'order_date', 'transaction_date', 'sale_date', 'purchase_date',
        'invoice_date', 'billing_date', 'payment_date',
        'date', 'created_at', 'created_date', 'event_date',
        'activity_date', 'report_date', 'period_date',
        'visit_date', 'appointment_date', 'service_date',
        'campaign_date', 'send_date', 'post_date',
    ],
    '{term_date}': [
        'termination_date', 'exit_date', 'end_date',
        'separation_date', 'last_working_date', 'departure_date',
        'discharge_date', 'leave_date', 'resigned_date',
        'last_date', 'date_of_exit', 'date_of_leaving',
        'cancellation_date', 'churn_date', 'expiry_date',
    ],
    '{date}': [
        'doj', 'hire_date', 'date', 'created_at',
        'order_date', 'transaction_date', 'event_date',
    ],
};

export interface ResolvedSQL {
    sql: string;
    resolved: boolean;
    missingPlaceholders: string[];
    columnMap: Record<string, string>;
}

/**
 * Resolve a SQL template's placeholders to actual column names from the dataset.
 * Priority: Direct Heuristic Match → AI Profile → Type-based fallback
 */
export function resolveTemplate(dataset: Dataset, sqlTemplate: string): ResolvedSQL {
    const columnNames = dataset.columns.map(c => c.name);
    const lowerColMap = new Map<string, string>(); // lowercase → original
    for (const col of columnNames) {
        lowerColMap.set(col.toLowerCase(), col);
    }

    // Find all unique placeholders in the template
    const placeholders = sqlTemplate.match(/\{[a-z_]+\}/g) || [];
    const uniquePlaceholders = [...new Set(placeholders)];

    const columnMap: Record<string, string> = {};
    const missing: string[] = [];

    for (const ph of uniquePlaceholders) {
        let resolved: string | null = null;

        // ── Strategy 1: HEURISTIC — Direct column name match (MOST RELIABLE) ──
        const patterns = PLACEHOLDER_PATTERNS[ph];
        if (patterns) {
            // Pass 1: Exact match (highest confidence)
            for (const pattern of patterns) {
                const exact = lowerColMap.get(pattern.toLowerCase());
                if (exact) {
                    resolved = exact;
                    break;
                }
            }
        }

        // ── Strategy 2: AI Profile Semantics (secondary) ──────────────
        // Only used if heuristics didn't find a match
        if (!resolved) {
            const aiSemantics = dataset.domainProfile?.columnSemantics || {};
            // Dimension placeholders that should skip ID-typed columns
            const dimPlaceholders = new Set(['{dept}', '{entity_name}', '{category}', '{product}', '{region}', '{location}', '{source}']);
            for (const [col, sem] of Object.entries(aiSemantics)) {
                const role = String((sem as any).semanticRole || '').toLowerCase();
                const label = String((sem as any).humanLabel || '').toLowerCase();
                const colType = dataset.columns.find(c => c.name === col)?.type;

                // For dimension placeholders, skip ID columns — we want the NAME
                if (dimPlaceholders.has(ph) && colType === ColumnType.ID) continue;

                const matched =
                    // Entity
                    (ph === '{entity_id}' && (role === 'identifier' || role === 'entity_id' || role === 'primary_key')) ||
                    (ph === '{entity_name}' && (role === 'entity_name' || (label.includes('name') && colType === ColumnType.DIMENSION))) ||
                    // Dimensions
                    (ph === '{dept}' && (role === 'department' || role === 'group' || label.includes('department'))) ||
                    (ph === '{category}' && (role === 'category' || role === 'segment' || label.includes('category') || label.includes('type'))) ||
                    (ph === '{product}' && (role === 'product' || role === 'item' || label.includes('product') || label.includes('campaign') || label.includes('course'))) ||
                    (ph === '{region}' && (role === 'region' || role === 'territory' || label.includes('region') || label.includes('country'))) ||
                    (ph === '{location}' && (role === 'location' || role === 'geography' || label.includes('city') || label.includes('warehouse'))) ||
                    (ph === '{source}' && (role === 'source' || role === 'channel' || label.includes('channel') || label.includes('source'))) ||
                    (ph === '{gender}' && (role === 'gender' || label.includes('gender'))) ||
                    (ph === '{status}' && (role === 'status' || label.includes('status'))) ||
                    (ph === '{exit_type}' && (role === 'exit_type' || label.includes('exit') || label.includes('churn reason'))) ||
                    // Metrics
                    (ph === '{salary}' && (role === 'salary' || (role === 'monetary' && label.includes('salary')))) ||
                    (ph === '{revenue}' && (role === 'revenue' || role === 'monetary' || label.includes('revenue') || label.includes('sales') || label.includes('income'))) ||
                    (ph === '{cost}' && (role === 'cost' || role === 'expense' || label.includes('cost') || label.includes('expense') || label.includes('spend'))) ||
                    (ph === '{profit}' && (role === 'profit' || label.includes('profit') || label.includes('margin'))) ||
                    (ph === '{quantity}' && (role === 'quantity' || role === 'volume' || label.includes('quantity') || label.includes('units') || label.includes('stock'))) ||
                    (ph === '{rating}' && (role === 'rating' || label.includes('rating'))) ||
                    (ph === '{score}' && (role === 'score' || label.includes('score') || label.includes('gpa'))) ||
                    (ph === '{rate}' && (role === 'rate' || role === 'percentage' || label.includes('rate'))) ||
                    // Dates
                    (ph === '{hire_date}' && (role === 'start_date' || role === 'hire_date' || label.includes('join') || label.includes('hire'))) ||
                    (ph === '{order_date}' && (role === 'transaction_date' || role === 'order_date' || role === 'event_date' || label.includes('order date') || label.includes('transaction'))) ||
                    (ph === '{term_date}' && (role === 'end_date' || role === 'termination' || label.includes('exit') || label.includes('termination')));

                if (matched) {
                    resolved = col;
                    break;
                }
            }
        }

        // ── Strategy 3: Heuristic partial match (lower confidence) ────
        if (!resolved && patterns) {
            const dimPlaceholders = new Set(['{dept}', '{entity_name}', '{category}', '{product}', '{region}', '{location}', '{source}']);
            for (const pattern of patterns) {
                for (const [colLower, colOriginal] of lowerColMap.entries()) {
                    // Only match if the column name CONTAINS the pattern
                    // but NOT if the pattern is shorter than 4 chars (too ambiguous)
                    if (pattern.length >= 4 && colLower.includes(pattern.toLowerCase())) {
                        // Skip ID columns for dimension placeholders
                        if (dimPlaceholders.has(ph) &&
                            dataset.columns.find(c => c.name === colOriginal)?.type === ColumnType.ID) {
                            continue;
                        }
                        resolved = colOriginal;
                        break;
                    }
                }
                if (resolved) break;
            }
        }

        // ── Strategy 4: Column Type Fallback ──────────────────────────
        if (!resolved) {
            const idPlaceholders = ['{entity_id}'];
            const datePlaceholders = ['{hire_date}', '{order_date}', '{date}', '{term_date}'];
            const metricPlaceholders = ['{salary}', '{revenue}', '{cost}', '{profit}', '{quantity}'];

            if (idPlaceholders.includes(ph)) {
                const idCol = dataset.columns.find(c => c.type === ColumnType.ID);
                if (idCol) resolved = idCol.name;
            } else if (datePlaceholders.includes(ph)) {
                const dateCol = dataset.columns.find(c => c.type === ColumnType.DATE);
                if (dateCol) resolved = dateCol.name;
            } else if (metricPlaceholders.includes(ph)) {
                const metricCol = dataset.columns.find(c => c.type === ColumnType.METRIC);
                if (metricCol) resolved = metricCol.name;
            }
        }

        if (resolved) {
            columnMap[ph] = resolved;
        } else {
            missing.push(ph);
        }
    }

    // Replace placeholders in the SQL with quoted column names
    let resolvedSql = sqlTemplate;
    for (const [ph, col] of Object.entries(columnMap)) {
        resolvedSql = resolvedSql.replaceAll(ph, `[${col}]`);
    }

    // ── Replace CURRENT_DATE() with dataset's actual max date ──────
    // CURRENT_DATE() would return today's real date, but the dataset may be
    // historical (e.g., data up to 2021-04-25). We compute the max date from
    // the resolved date column and substitute it in.
    if (resolvedSql.includes('CURRENT_DATE()')) {
        const dateCol = columnMap['{order_date}'] || columnMap['{hire_date}'] || columnMap['{date}'] || columnMap['{term_date}'];
        if (dateCol && dataset.rows.length > 0) {
            let maxDate: Date | null = null;
            for (const row of dataset.rows) {
                const val = row[dateCol];
                if (val != null) {
                    const d = new Date(val);
                    if (!isNaN(d.getTime()) && (maxDate === null || d > maxDate)) {
                        maxDate = d;
                    }
                }
            }
            if (maxDate) {
                const maxDateStr = maxDate.toISOString().split('T')[0]; // YYYY-MM-DD
                resolvedSql = resolvedSql.replaceAll('CURRENT_DATE()', `'${maxDateStr}'`);
                console.log('[SQLTemplateResolver] Replaced CURRENT_DATE() with dataset max date:', maxDateStr);
            }
        }
    }

    console.log('[SQLTemplateResolver] Resolution:', columnMap, missing.length > 0 ? 'MISSING:' + missing : 'ALL RESOLVED');

    return {
        sql: resolvedSql,
        resolved: missing.length === 0,
        missingPlaceholders: missing,
        columnMap,
    };
}

/**
 * Lightweight check: can this template be resolved against the dataset?
 * Does NOT generate SQL — just checks if all placeholders have matching columns.
 * Used by the question bank to grey out unresolvable questions.
 */
export function canResolveTemplate(dataset: Dataset, sqlTemplate: string): boolean {
    try {
        const result = resolveTemplate(dataset, sqlTemplate);
        return result.resolved;
    } catch {
        return false;
    }
}
