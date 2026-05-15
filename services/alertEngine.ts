/**
 * alertEngine.ts — QueryPlan-Powered Alert Evaluation Engine
 * 
 * Alerts generate QueryPlans → evaluateLocally() → compare against conditions.
 * NO separate SQL generation — reuses the existing semantic query pipeline.
 */
import { AlertRule, AlertEvent, AlertCondition, AlertTimeRange, Dataset } from '../types';
import { buildQueryPlan, UIQueryConfig } from './queryPlan/buildQueryPlan';
import { executeQueryPlan } from './queryPlan/executeQueryPlan';
import { getDates } from './dateHelpers';

// ── TIME RANGE RESOLVER ──────────────────────────────────────────
// Maps AlertTimeRange → the timeFilter string used by buildQueryPlan

function resolveAlertTimeFilter(range: AlertTimeRange): string {
    switch (range.type) {
        case 'today': return 'today';
        case 'yesterday': return 'yesterday';
        case 'last_n_days': return `last_${range.value}_days`;
        case 'this_month': return 'this_month';
        case 'this_quarter': return 'this_quarter';
        case 'this_year': return 'this_year';
        case 'all_time': return 'all_time';
        default: return 'all_time';
    }
}

// For trend alerts: shift the time range to the comparison period
function resolveTrendComparisonTimeFilter(
    period: 'previous_day' | 'previous_week' | 'previous_month' | 'previous_quarter'
): string {
    switch (period) {
        case 'previous_day': return 'yesterday';
        case 'previous_week': return 'last_7_days';
        case 'previous_month': return 'last_30_days';
        case 'previous_quarter': return 'last_90_days';
        default: return 'last_30_days';
    }
}

// ── ALERT → QUERY CONFIG ────────────────────────────────────────
// Converts an AlertRule into a UIQueryConfig that buildQueryPlan understands

function buildAlertQueryConfig(rule: AlertRule, timeFilterOverride?: string): UIQueryConfig {
    // Convert alert filters to the format QueryPlan expects
    const filters: Record<string, string[]> = {};
    if (rule.filters) {
        for (const f of rule.filters) {
            if (!filters[f.column]) filters[f.column] = [];
            filters[f.column].push(f.value);
        }
    }

    return {
        metric: rule.metric,
        aggregation: rule.aggregation,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        timeFilter: timeFilterOverride || resolveAlertTimeFilter(rule.timeRange),
        // No dimension — we want a single aggregate scalar
    };
}

// ── CONDITION EVALUATOR ─────────────────────────────────────────

function meetsThresholdCondition(
    value: number,
    condition: { operator: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
): boolean {
    switch (condition.operator) {
        case '>': return value > condition.value;
        case '<': return value < condition.value;
        case '>=': return value >= condition.value;
        case '<=': return value <= condition.value;
        case '==': return value === condition.value;
        case '!=': return value !== condition.value;
        default: return false;
    }
}

// ── HUMAN-READABLE MESSAGE BUILDER ──────────────────────────────

function formatValue(value: number): string {
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(2);
}

function buildThresholdMessage(rule: AlertRule, currentValue: number): string {
    const cond = rule.condition as { type: 'threshold'; operator: string; value: number };
    const metricName = rule.metric.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const aggLabel: Record<string, string> = {
        'SUM': 'Total', 'AVG': 'Average', 'COUNT': 'Count of',
        'COUNT_DISTINCT': 'Unique', 'MIN': 'Lowest', 'MAX': 'Highest'
    };
    const agg = aggLabel[rule.aggregation] || rule.aggregation;
    const opLabels: Record<string, string> = {
        '>': 'exceeded', '<': 'dropped below', '>=': 'reached or exceeded',
        '<=': 'dropped to or below', '==': 'equals', '!=': 'changed from'
    };
    const opLabel = opLabels[cond.operator] || cond.operator;
    return `${agg} ${metricName} ${opLabel} ${formatValue(cond.value)} — current value is ${formatValue(currentValue)}`;
}

function buildTrendMessage(rule: AlertRule, currentValue: number, previousValue: number, changePct: number): string {
    const metricName = rule.metric.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const aggLabel: Record<string, string> = {
        'SUM': 'Total', 'AVG': 'Average', 'COUNT': 'Count of',
        'COUNT_DISTINCT': 'Unique', 'MIN': 'Lowest', 'MAX': 'Highest'
    };
    const agg = aggLabel[rule.aggregation] || rule.aggregation;
    const cond = rule.condition as { type: 'trend'; direction: string; comparisonPeriod: string };
    const periodLabels: Record<string, string> = {
        'previous_day': 'yesterday', 'previous_week': 'last week',
        'previous_month': 'last month', 'previous_quarter': 'last quarter'
    };
    const periodLabel = periodLabels[cond.comparisonPeriod] || cond.comparisonPeriod;
    const direction = changePct >= 0 ? 'increased' : 'decreased';
    return `${agg} ${metricName} ${direction} by ${Math.abs(changePct).toFixed(1)}% vs ${periodLabel} — ${formatValue(previousValue)} → ${formatValue(currentValue)}`;
}

// ── SINGLE RULE EVALUATOR ───────────────────────────────────────

export async function evaluateAlertRule(
    rule: AlertRule,
    dataset: Dataset
): Promise<{ event: AlertEvent | null; currentValue?: number }> {
    try {
        // Skip if disabled, snoozed (and not expired), or dataset mismatch
        if (rule.status === 'disabled') return { event: null };
        if (rule.status === 'snoozed' && rule.snoozedUntil && Date.now() < rule.snoozedUntil) {
            return { event: null };
        }
        if (rule.datasetId !== dataset.id) return { event: null };

        // Resolve date context
        const dateCol = dataset.timeContext?.anchorDateColumn || '';
        const asOfDate = dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0];
        const dates = getDates(asOfDate);

        if (!dateCol && rule.timeRange.type !== 'all_time') {
            // No date column available but time filter requested — skip gracefully
            return { event: null };
        }

        // Build QueryPlan and execute for CURRENT period
        const config = buildAlertQueryConfig(rule);
        const plan = buildQueryPlan(config, dateCol, dates, dataset.name);
        const result = executeQueryPlan(plan, dataset.rows);

        if (!result || !result.data || result.data.length === 0) return { event: null };

        // Extract the scalar metric value
        const metricAlias = plan.metrics[0]?.alias;
        if (!metricAlias) return { event: null };
        const currentValue = Number(result.data[0][metricAlias]);
        if (isNaN(currentValue)) return { event: null };

        // ── THRESHOLD evaluation ─────────────────────────────────
        if (rule.condition.type === 'threshold') {
            if (meetsThresholdCondition(currentValue, rule.condition)) {
                return {
                    currentValue,
                    event: {
                        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        severity: rule.severity,
                        triggeredAt: Date.now(),
                        currentValue,
                        thresholdValue: rule.condition.value,
                        message: buildThresholdMessage(rule, currentValue),
                        acknowledged: false,
                    }
                };
            }
            return { currentValue, event: null };
        }

        // ── TREND evaluation ─────────────────────────────────────
        if (rule.condition.type === 'trend') {
            const prevTimeFilter = resolveTrendComparisonTimeFilter(rule.condition.comparisonPeriod);
            const prevConfig = buildAlertQueryConfig(rule, prevTimeFilter);
            const prevPlan = buildQueryPlan(prevConfig, dateCol, dates, dataset.name);
            const prevResult = executeQueryPlan(prevPlan, dataset.rows);

            if (!prevResult || !prevResult.data || prevResult.data.length === 0) return { currentValue, event: null };

            const prevMetricAlias = prevPlan.metrics[0]?.alias;
            const previousValue = Number(prevResult.data[0][prevMetricAlias || '']);
            if (isNaN(previousValue) || previousValue === 0) return { currentValue, event: null };

            const changePct = ((currentValue - previousValue) / Math.abs(previousValue)) * 100;

            const triggered =
                (rule.condition.direction === 'decreases' && changePct <= -rule.condition.changePercent) ||
                (rule.condition.direction === 'increases' && changePct >= rule.condition.changePercent);

            if (triggered) {
                return {
                    currentValue,
                    event: {
                        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        severity: rule.severity,
                        triggeredAt: Date.now(),
                        currentValue,
                        previousValue,
                        changePercent: changePct,
                        message: buildTrendMessage(rule, currentValue, previousValue, changePct),
                        acknowledged: false,
                    }
                };
            }
            return { currentValue, event: null };
        }

        return { currentValue, event: null };
    } catch (err) {
        console.warn(`[AlertEngine] Error evaluating rule "${rule.name}":`, err);
        return { event: null };
    }
}

// ── BATCH EVALUATOR ─────────────────────────────────────────────
// Evaluate all active rules against all loaded datasets

export async function evaluateAllAlerts(
    rules: AlertRule[],
    datasets: Dataset[]
): Promise<{ events: AlertEvent[]; updatedRules: AlertRule[] }> {
    const events: AlertEvent[] = [];
    const updatedRules = [...rules];
    const datasetMap = new Map(datasets.map(d => [d.id, d]));

    for (let i = 0; i < updatedRules.length; i++) {
        const rule = updatedRules[i];
        const dataset = datasetMap.get(rule.datasetId);
        if (!dataset) continue;

        const { event, currentValue } = await evaluateAlertRule(rule, dataset);

        // Update rule metadata
        updatedRules[i] = {
            ...rule,
            lastEvaluatedAt: Date.now(),
            lastValue: currentValue ?? rule.lastValue,
            ...(event ? { lastTriggeredAt: Date.now() } : {}),
            // Auto-unsnoose expired rules
            ...(rule.status === 'snoozed' && rule.snoozedUntil && Date.now() >= rule.snoozedUntil
                ? { status: 'active' as const, snoozedUntil: undefined }
                : {}),
        };

        if (event) {
            events.push(event);
        }
    }

    return { events, updatedRules };
}
