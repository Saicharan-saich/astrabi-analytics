/**
 * derivedMetricEngine.ts — Analytical Planning & Derived Metrics Engine (APDME)
 *
 * The missing brain between NLQ intent planning and SQL generation.
 * Detects when a question requires computed/derived metrics (date differences,
 * ratios, profit calculations) and injects the correct SQL expressions.
 *
 * Pipeline position:
 *   Intent Planner → ★ APDME ★ → SQL Generator
 *
 * Components:
 *   1. Domain Intelligence (semantic dictionaries)
 *   2. Operation Parser (detects difference, ratio, percentage, growth)
 *   3. Function Registry (maps operations → SQL templates)
 *   4. Derived Metric Builder (creates executable metric expressions)
 *   5. Validation Guardrails (rejects invalid operations like SUM(date))
 */

import { AnalysisPlan, PlanMetric, SemanticField, SemanticModel } from './types';

// ═══════════════════════════════════════════════════════════════════
// 1. DOMAIN INTELLIGENCE — Semantic dictionaries for common derived metrics
// ═══════════════════════════════════════════════════════════════════

export interface DerivedMetricPattern {
    name: string;
    triggers: string[];
    operation: OperationType;
    leftHint: string[];
    rightHint: string[];
    resultType: 'duration' | 'number' | 'percentage' | 'currency';
    allowedAggs: string[];
}

const DERIVED_METRIC_PATTERNS: DerivedMetricPattern[] = [
    // ─── Healthcare ───
    {
        name: 'length_of_stay',
        triggers: ['length of stay', 'stay duration', 'days admitted', 'hospitalization duration', 'days stayed', 'days in hospital', 'hospital stay'],
        operation: 'difference',
        leftHint: ['discharge', 'discharge_date', 'date_of_discharge', 'checkout', 'end_date'],
        rightHint: ['admission', 'admit', 'admission_date', 'date_of_admission', 'checkin', 'start_date'],
        resultType: 'duration',
        allowedAggs: ['AVG', 'SUM', 'MIN', 'MAX', 'COUNT'],
    },
    {
        name: 'patient_age',
        triggers: ['patient age', 'age of patient', 'age at admission', 'how old'],
        operation: 'difference',
        leftHint: ['admission_date', 'date_of_admission', 'visit_date'],
        rightHint: ['dob', 'date_of_birth', 'birth_date', 'birthdate'],
        resultType: 'duration',
        allowedAggs: ['AVG', 'MIN', 'MAX', 'COUNT'],
    },
    // ─── Sales / Finance ───
    {
        name: 'profit',
        triggers: ['profit', 'earnings', 'net income', 'margin amount'],
        operation: 'difference',
        leftHint: ['revenue', 'sales', 'income', 'total_sales', 'sale_amt', 'selling_price', 'price'],
        rightHint: ['cost', 'expense', 'cogs', 'cost_of_goods', 'purchase_price', 'buying_price'],
        resultType: 'currency',
        allowedAggs: ['SUM', 'AVG', 'MIN', 'MAX'],
    },
    {
        name: 'profit_margin',
        triggers: ['profit margin', 'margin percentage', 'margin %', 'gross margin'],
        operation: 'ratio_percent',
        leftHint: ['profit', 'revenue', 'sales'],
        rightHint: ['revenue', 'sales', 'income'],
        resultType: 'percentage',
        allowedAggs: ['AVG'],
    },
    {
        name: 'conversion_rate',
        triggers: ['conversion rate', 'conversion %', 'conversion percentage'],
        operation: 'ratio_percent',
        leftHint: ['conversions', 'orders', 'purchases', 'converted'],
        rightHint: ['visits', 'views', 'sessions', 'clicks', 'impressions', 'leads'],
        resultType: 'percentage',
        allowedAggs: ['AVG'],
    },
    // ─── HR ───
    {
        name: 'tenure',
        triggers: ['tenure', 'years employed', 'time at company', 'employment duration', 'service length'],
        operation: 'difference',
        leftHint: ['termination_date', 'end_date', 'last_day'],
        rightHint: ['hire_date', 'start_date', 'join_date', 'date_of_joining'],
        resultType: 'duration',
        allowedAggs: ['AVG', 'MIN', 'MAX', 'COUNT'],
    },
    {
        name: 'attrition_rate',
        triggers: ['attrition rate', 'turnover rate', 'churn rate', 'attrition %'],
        operation: 'ratio_percent',
        leftHint: ['attrition', 'terminated', 'left', 'churned'],
        rightHint: ['total_employees', 'headcount', 'total', 'employee_count'],
        resultType: 'percentage',
        allowedAggs: ['AVG'],
    },
    // ─── General ───
    {
        name: 'age',
        triggers: ['age', 'years old', 'how old'],
        operation: 'difference',
        leftHint: [],
        rightHint: ['dob', 'date_of_birth', 'birth_date', 'birthdate'],
        resultType: 'duration',
        allowedAggs: ['AVG', 'MIN', 'MAX', 'COUNT'],
    },
    {
        name: 'duration',
        triggers: ['duration', 'time between', 'days between', 'elapsed time', 'time taken', 'turnaround time', 'response time', 'lead time', 'cycle time', 'processing time'],
        operation: 'difference',
        leftHint: ['end_date', 'completed_date', 'close_date', 'resolved_date', 'delivery_date'],
        rightHint: ['start_date', 'created_date', 'open_date', 'order_date', 'request_date'],
        resultType: 'duration',
        allowedAggs: ['AVG', 'SUM', 'MIN', 'MAX'],
    },
];

// ═══════════════════════════════════════════════════════════════════
// 2. OPERATION PARSER
// ═══════════════════════════════════════════════════════════════════

export type OperationType = 'difference' | 'ratio' | 'ratio_percent' | 'multiplication' | 'none';

export interface DetectedOperation {
    type: OperationType;
    left: string;
    right: string;
    semanticType: 'duration' | 'number' | 'percentage' | 'currency';
    derivedName: string;
    allowedAggs: string[];
    matchedPattern?: string;
}

/** Helper: get all date fields from the model */
function getDateFields(model: SemanticModel): SemanticField[] {
    return model.fields.filter(f => f.physicalType === 'date');
}

/** Helper: check if a field name is a date */
function isDateField(fieldName: string, model: SemanticModel): boolean {
    const field = model.fields.find(f => f.name === fieldName);
    return field ? field.physicalType === 'date' : false;
}

/** Helper: resolve a column from hint keywords */
function resolveColumn(hints: string[], model: SemanticModel): SemanticField | null {
    if (hints.length === 0) return null;
    for (const hint of hints) {
        const hintLower = hint.toLowerCase();
        const exact = model.fields.find(f => f.name.toLowerCase() === hintLower);
        if (exact) return exact;
        const partial = model.fields.find(f =>
            f.name.toLowerCase().includes(hintLower) || hintLower.includes(f.name.toLowerCase())
        );
        if (partial) return partial;
    }
    return null;
}

/** Helper: fuzzy match text to a column name */
function fuzzyMatchColumn(text: string, model: SemanticModel): string | null {
    const clean = text.toLowerCase().replace(/[^a-z0-9_\s]/g, '').trim();
    const exact = model.fields.find(f => f.name.toLowerCase() === clean);
    if (exact) return exact.name;
    const underscored = clean.replace(/\s+/g, '_');
    const underscoredMatch = model.fields.find(f => f.name.toLowerCase() === underscored);
    if (underscoredMatch) return underscoredMatch.name;
    const substr = model.fields.find(f =>
        f.name.toLowerCase().includes(clean) || clean.includes(f.name.toLowerCase())
    );
    if (substr) return substr.name;
    const labelMatch = model.fields.find(f =>
        (f.displayLabel || '').toLowerCase().includes(clean)
    );
    if (labelMatch) return labelMatch.name;
    return null;
}

/** Helper: guess best date pair for a DATEDIFF */
function guessBestDatePair(
    dateFields: SemanticField[],
    question: string
): { left: string; right: string } | null {
    if (dateFields.length < 2) return null;
    const endHints = ['discharge', 'end', 'close', 'completion', 'resolved', 'delivery', 'termination', 'last'];
    const startHints = ['admission', 'admit', 'start', 'open', 'created', 'order', 'request', 'hire', 'join', 'birth', 'first'];

    let leftCandidate: string | null = null;
    let rightCandidate: string | null = null;

    for (const f of dateFields) {
        const colLower = f.name.toLowerCase();
        if (!leftCandidate && endHints.some(h => colLower.includes(h))) leftCandidate = f.name;
        if (!rightCandidate && startHints.some(h => colLower.includes(h))) rightCandidate = f.name;
    }

    for (const f of dateFields) {
        if (question.includes(f.name.toLowerCase())) {
            if (!leftCandidate) leftCandidate = f.name;
            else if (!rightCandidate && f.name !== leftCandidate) rightCandidate = f.name;
        }
    }

    if (leftCandidate && rightCandidate) return { left: leftCandidate, right: rightCandidate };
    if (dateFields.length >= 2) return { left: dateFields[1].name, right: dateFields[0].name };
    return null;
}

/**
 * Parse a question to detect if it requires a derived metric operation.
 */
export function parseOperation(
    question: string,
    model: SemanticModel,
    plan: AnalysisPlan
): DetectedOperation | null {
    const qLower = question.toLowerCase();

    // ─── Step 1: Check domain intelligence patterns ───
    for (const pattern of DERIVED_METRIC_PATTERNS) {
        const triggerMatch = pattern.triggers.find(t => qLower.includes(t));
        if (!triggerMatch) continue;

        const left = resolveColumn(pattern.leftHint, model);
        const right = resolveColumn(pattern.rightHint, model);

        if (left && right) {
            return {
                type: pattern.operation,
                left: left.name,
                right: right.name,
                semanticType: pattern.resultType,
                derivedName: pattern.name,
                allowedAggs: pattern.allowedAggs,
                matchedPattern: pattern.name,
            };
        }
    }

    // ─── Step 2: Detect explicit "X - Y" or "X minus Y" patterns ───
    const diffPatterns = [
        /(\w+)\s*-\s*(\w+)/,
        /(\w[\w\s]*?)\s+minus\s+(\w[\w\s]*)/i,
        /difference\s+between\s+(\w[\w\s]*?)\s+and\s+(\w[\w\s]*)/i,
    ];

    for (const rx of diffPatterns) {
        const m = qLower.match(rx);
        if (!m) continue;
        const leftCol = fuzzyMatchColumn(m[1].trim(), model);
        const rightCol = fuzzyMatchColumn(m[2].trim(), model);
        if (leftCol && rightCol && leftCol !== rightCol) {
            const bothDates = isDateField(leftCol, model) && isDateField(rightCol, model);
            return {
                type: 'difference',
                left: leftCol,
                right: rightCol,
                semanticType: bothDates ? 'duration' : 'number',
                derivedName: bothDates ? 'date_diff' : 'calculated_diff',
                allowedAggs: ['AVG', 'SUM', 'MIN', 'MAX'],
            };
        }
    }

    // ─── Step 3: Detect ratio patterns ───
    const ratioPatterns = [
        /(\w[\w\s]*?)\s+(?:divided by|over|per)\s+(\w[\w\s]*)/i,
        /ratio\s+of\s+(\w[\w\s]*?)\s+to\s+(\w[\w\s]*)/i,
    ];
    for (const rx of ratioPatterns) {
        const m = qLower.match(rx);
        if (!m) continue;
        const leftCol = fuzzyMatchColumn(m[1].trim(), model);
        const rightCol = fuzzyMatchColumn(m[2].trim(), model);
        if (leftCol && rightCol && leftCol !== rightCol) {
            return {
                type: 'ratio',
                left: leftCol,
                right: rightCol,
                semanticType: 'number',
                derivedName: `${leftCol}_per_${rightCol}`,
                allowedAggs: ['AVG'],
            };
        }
    }

    // ─── Step 4: Detect multiplication patterns ───
    const multPatterns = [
        /(\w[\w\s]*?)\s+(?:times|multiplied by|x)\s+(\w[\w\s]*)/i,
        /(\w[\w\s]*?)\s*\*\s*(\w[\w\s]*)/,
    ];
    for (const rx of multPatterns) {
        const m = qLower.match(rx);
        if (!m) continue;
        const leftCol = fuzzyMatchColumn(m[1].trim(), model);
        const rightCol = fuzzyMatchColumn(m[2].trim(), model);
        if (leftCol && rightCol && leftCol !== rightCol) {
            return {
                type: 'multiplication',
                left: leftCol,
                right: rightCol,
                semanticType: 'number',
                derivedName: `${leftCol}_x_${rightCol}`,
                allowedAggs: ['SUM', 'AVG', 'MIN', 'MAX'],
            };
        }
    }

    // ─── Step 5: Guardrail — plan tries to aggregate a date column ───
    for (const met of plan.metrics) {
        if (isDateField(met.field, model) && ['sum', 'avg'].includes(met.agg)) {
            const dateFields = getDateFields(model);
            if (dateFields.length >= 2) {
                const pair = guessBestDatePair(dateFields, qLower);
                if (pair) {
                    return {
                        type: 'difference',
                        left: pair.left,
                        right: pair.right,
                        semanticType: 'duration',
                        derivedName: 'date_diff',
                        allowedAggs: ['AVG', 'SUM', 'MIN', 'MAX'],
                    };
                }
            }
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
// 3. FUNCTION REGISTRY — Maps operations to SQL templates (NO AI HERE)
// ═══════════════════════════════════════════════════════════════════

interface SQLTemplate {
    expression: string;
    aliasPattern: string;
}

const FUNCTION_REGISTRY: Record<string, Record<string, SQLTemplate>> = {
    difference: {
        duration: {
            expression: `CAST(JULIANDAY({left}) - JULIANDAY({right}) AS INTEGER)`,
            aliasPattern: '{name}_days',
        },
        number: { expression: `({left} - {right})`, aliasPattern: '{name}' },
        currency: { expression: `({left} - {right})`, aliasPattern: '{name}' },
        percentage: { expression: `({left} - {right})`, aliasPattern: '{name}' },
    },
    ratio: {
        number: { expression: `CASE WHEN {right} != 0 THEN CAST({left} AS REAL) / {right} ELSE 0 END`, aliasPattern: '{name}_ratio' },
        percentage: { expression: `CASE WHEN {right} != 0 THEN CAST({left} AS REAL) / {right} ELSE 0 END`, aliasPattern: '{name}_ratio' },
        currency: { expression: `CASE WHEN {right} != 0 THEN CAST({left} AS REAL) / {right} ELSE 0 END`, aliasPattern: '{name}_ratio' },
        duration: { expression: `CASE WHEN {right} != 0 THEN CAST({left} AS REAL) / {right} ELSE 0 END`, aliasPattern: '{name}_ratio' },
    },
    ratio_percent: {
        number: { expression: `CASE WHEN {right} != 0 THEN ROUND(CAST({left} AS REAL) / {right} * 100, 2) ELSE 0 END`, aliasPattern: '{name}_pct' },
        percentage: { expression: `CASE WHEN {right} != 0 THEN ROUND(CAST({left} AS REAL) / {right} * 100, 2) ELSE 0 END`, aliasPattern: '{name}_pct' },
        currency: { expression: `CASE WHEN {right} != 0 THEN ROUND(CAST({left} AS REAL) / {right} * 100, 2) ELSE 0 END`, aliasPattern: '{name}_pct' },
        duration: { expression: `CASE WHEN {right} != 0 THEN ROUND(CAST({left} AS REAL) / {right} * 100, 2) ELSE 0 END`, aliasPattern: '{name}_pct' },
    },
    multiplication: {
        number: { expression: `({left} * {right})`, aliasPattern: '{name}' },
        currency: { expression: `({left} * {right})`, aliasPattern: '{name}' },
        percentage: { expression: `({left} * {right})`, aliasPattern: '{name}' },
        duration: { expression: `({left} * {right})`, aliasPattern: '{name}' },
    },
};

// ═══════════════════════════════════════════════════════════════════
// 4. DERIVED METRIC BUILDER
// ═══════════════════════════════════════════════════════════════════

export interface DerivedMetric {
    name: string;
    expression: string;
    alias: string;
    aggregatedExpression: string;
    aggregation: string;
    resultType: 'duration' | 'number' | 'percentage' | 'currency';
    sourceColumns: string[];
}

export function buildDerivedMetric(
    op: DetectedOperation,
    aggregation: string
): DerivedMetric {
    const semType = op.semanticType;
    const template = FUNCTION_REGISTRY[op.type]?.[semType];

    if (!template) {
        throw new Error(`[APDME] No SQL template for operation=${op.type}, type=${semType}`);
    }

    const expression = template.expression
        .replace(/\{left\}/g, op.left)
        .replace(/\{right\}/g, op.right);

    const alias = template.aliasPattern.replace(/\{name\}/g, op.derivedName);

    const agg = aggregation.toUpperCase();
    const validAgg = op.allowedAggs.includes(agg) ? agg : op.allowedAggs[0] || 'AVG';
    const aggregatedExpression = `${validAgg}(${expression})`;

    return {
        name: op.derivedName,
        expression,
        alias,
        aggregatedExpression,
        aggregation: validAgg,
        resultType: semType,
        sourceColumns: [op.left, op.right],
    };
}

// ═══════════════════════════════════════════════════════════════════
// 5. VALIDATION GUARDRAILS
// ═══════════════════════════════════════════════════════════════════

export interface GuardrailViolation {
    rule: string;
    message: string;
    severity: 'error' | 'warning';
    penalty: number;
}

export function validateGuardrails(
    plan: AnalysisPlan,
    model: SemanticModel
): GuardrailViolation[] {
    const violations: GuardrailViolation[] = [];

    for (const met of plan.metrics) {
        const field = model.fields.find(f => f.name === met.field);

        // Rule 1: SUM or AVG on a DATE column
        if (isDateField(met.field, model) && ['sum', 'avg'].includes(met.agg)) {
            violations.push({
                rule: 'NO_AGG_ON_DATE',
                message: `Cannot ${met.agg.toUpperCase()}(${met.field}) — it is a date column. A derived metric (like DATEDIFF) may be needed.`,
                severity: 'error',
                penalty: 50,
            });
        }

        // Rule 2: SUM on ID/identifier column
        if (field && field.semanticType === 'identifier' && met.agg === 'sum') {
            violations.push({
                rule: 'NO_SUM_ON_ID',
                message: `Cannot SUM(${met.field}) — it is an identifier.`,
                severity: 'error',
                penalty: 40,
            });
        }

        // Rule 3: AVG on a dimension column
        if (field && field.role === 'dimension' && met.agg === 'avg') {
            violations.push({
                rule: 'AVG_ON_DIMENSION',
                message: `AVG(${met.field}) is suspicious — '${met.field}' is a dimension.`,
                severity: 'warning',
                penalty: 20,
            });
        }

        // Rule 4: COUNT on a date column (usually meaningless — should use DATEDIFF)
        if (isDateField(met.field, model) && met.agg === 'count') {
            violations.push({
                rule: 'COUNT_ON_DATE',
                message: `COUNT(${met.field}) on a date column is usually meaningless. Did you mean a date-based calculation?`,
                severity: 'warning',
                penalty: 10,
            });
        }

        // Rule 5: SUM/AVG on text/category field
        if (field && (field.physicalType === 'string' || field.semanticType === 'category') && ['sum', 'avg'].includes(met.agg)) {
            violations.push({
                rule: 'AGG_ON_TEXT',
                message: `Cannot ${met.agg.toUpperCase()}(${met.field}) — it is a text/category field.`,
                severity: 'error',
                penalty: 45,
            });
        }

        // Rule 6: Aggregation on boolean/flag field (except COUNT)
        if (field && field.physicalType === 'boolean' && ['sum', 'avg', 'min', 'max'].includes(met.agg)) {
            violations.push({
                rule: 'AGG_ON_BOOLEAN',
                message: `${met.agg.toUpperCase()}(${met.field}) on a boolean field is suspicious. Did you mean COUNT?`,
                severity: 'warning',
                penalty: 15,
            });
        }

        // Rule 7: Metric field doesn't exist in model (phantom field)
        if (!field && !met.compositeId && !met.derivedMetricId && met.field !== '*') {
            violations.push({
                rule: 'PHANTOM_FIELD',
                message: `Field "${met.field}" does not exist in the dataset.`,
                severity: 'error',
                penalty: 60,
            });
        }
    }

    // Rule 8: Breakdown with no dimensions
    if (plan.dimensions.length === 0 && plan.intent === 'breakdown') {
        violations.push({
            rule: 'MISSING_DIMENSION',
            message: 'Breakdown intent with no dimension.',
            severity: 'warning',
            penalty: 15,
        });
    }

    // Rule 9: Trend with no time dimension
    if (plan.intent === 'trend' && !plan.dimensions.some(d => d.timeGrain)) {
        violations.push({
            rule: 'TREND_NO_TIME',
            message: 'Trend intent but no time-granulated dimension.',
            severity: 'warning',
            penalty: 20,
        });
    }

    // Rule 10: High-cardinality dimension (>100 unique values) in breakdown
    for (const dim of plan.dimensions) {
        const field = model.fields.find(f => f.name === dim.field);
        if (field && field.distinctCount && field.distinctCount > 100 && !dim.timeGrain) {
            violations.push({
                rule: 'HIGH_CARDINALITY',
                message: `Dimension "${dim.field}" has ${field.distinctCount} unique values — results may be overwhelming. Consider filtering or using a different dimension.`,
                severity: 'warning',
                penalty: 10,
            });
        }
    }

    return violations;
}

// ═══════════════════════════════════════════════════════════════════
// 6. MAIN: processPlan (between Intent Planner and SQL Generator)
// ═══════════════════════════════════════════════════════════════════

export interface APDMEResult {
    plan: AnalysisPlan;
    derivedMetrics: DerivedMetric[];
    violations: GuardrailViolation[];
    confidencePenalty: number;
    derivedMetricApplied: boolean;
}

/**
 * MAIN ENTRY POINT — Run the APDME engine on a plan.
 * Call AFTER Intent Planner, BEFORE SQL Generator.
 */
export function processPlan(
    plan: AnalysisPlan,
    model: SemanticModel
): APDMEResult {
    const question = plan.originalQuestion;
    const derivedMetrics: DerivedMetric[] = [];

    // Step 1: Parse for operations
    let op = parseOperation(question, model, plan);

    // A native metric is authoritative. For example, if the dataset already has
    // a profit column and the plan asks for profit, do not reinterpret it as the
    // generic sales-minus-cost derived metric.
    if (op) {
        const nativeMetric = model.fields.find(field =>
            field.role === 'metric'
            && field.name.toLowerCase() === op!.derivedName.toLowerCase()
        );
        const planUsesNativeMetric = nativeMetric && plan.metrics.some(metric =>
            metric.field.toLowerCase() === nativeMetric.name.toLowerCase()
        );
        if (planUsesNativeMetric) {
            console.log(`[APDME] Native metric "${nativeMetric!.name}" exists; derived fallback skipped`);
            op = null;
        }
    }

    if (op) {
        console.log(`[APDME] Detected operation: ${op.type} → ${op.derivedName} (${op.left} → ${op.right})`);

        // Step 2: Build derived metric
        const requestedAgg = plan.metrics[0]?.agg || 'avg';
        const derived = buildDerivedMetric(op, requestedAgg);
        derivedMetrics.push(derived);

        console.log(`[APDME] Built derived metric: ${derived.aggregatedExpression} AS ${derived.alias}`);

        // Step 3: Mutate plan — replace the metric with derived reference
        plan.metrics = [{
            field: derived.alias,
            agg: derived.aggregation.toLowerCase() as any,
            derivedMetricId: derived.name,
        }];

        // Remove source date columns from dimensions
        plan.dimensions = plan.dimensions.filter(
            d => !derived.sourceColumns.includes(d.field)
        );
    }

    // Step 4: Validate guardrails
    const violations = op ? [] : validateGuardrails(plan, model);
    const confidencePenalty = violations.reduce((sum, v) => sum + v.penalty, 0);

    if (violations.length > 0) {
        console.warn(`[APDME] Guardrail violations:`, violations.map(v => v.message));
    }

    return {
        plan,
        derivedMetrics,
        violations,
        confidencePenalty,
        derivedMetricApplied: op !== null,
    };
}
