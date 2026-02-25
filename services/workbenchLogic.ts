/**
 * workbenchLogic.ts
 * 
 * Pure business logic extracted from Workbench.tsx.
 * All functions here are pure (no React state, no side effects).
 * This makes them independently testable and reusable.
 */

import { Dataset, ColumnType, AggregationType, QueryConfig, AnalysisType, TimeGrain } from '../types';

// ─── QUESTION CLICK INFERENCE ────────────────────────────────
// Semantic inference for clicking predefined questions

interface QuestionDef {
    id: string;
    req?: string[];
    label?: string;
}

interface InferredConfig {
    metric: string;
    dimension: string;
    aggregation: AggregationType;
    timeFilter: string;
    limit: number;
    sort: string;
    allowedControls: string[];
}

/**
 * Infers the correct metric column from a question's requirements.
 * Uses alias mapping to find the best column match.
 */
export const inferMetricFromQuestion = (
    dataset: Dataset,
    questionDef: QuestionDef | undefined,
    questionId: string
): { metric: string; aggregation: AggregationType } => {
    let inferredMetric = '';
    let inferredAgg = AggregationType.SUM;

    if (!questionDef?.req) return { metric: inferredMetric, aggregation: inferredAgg };

    const metricReq = questionDef.req.find(r =>
        ['revenue', 'quantity', 'stock', 'order_id', 'customer_id', 'id'].some(k => r.includes(k))
    );

    if (metricReq) {
        const aliases: Record<string, string[]> = {
            revenue: ['revenue', 'sales', 'amount', 'price', 'value'],
            quantity: ['quantity', 'units', 'qty', 'volume', 'count'],
            stock: ['stock', 'inventory', 'on_hand'],
            order_id: ['order_id', 'order', 'id'],
            customer_id: ['customer_id', 'customer', 'user']
        };

        let keywords = [metricReq];
        for (const [key, val] of Object.entries(aliases)) {
            if (metricReq.includes(key)) {
                keywords = val;
                break;
            }
        }

        const allCols = dataset.columns.map(c => c.name);
        inferredMetric = allCols.find(m => keywords.some(k => m.toLowerCase().includes(k))) || '';
    }

    // Infer aggregation from question ID patterns
    if (questionId.includes('_aov')) inferredAgg = AggregationType.AVG;
    else if (questionId.includes('count') || questionId.includes('orders')) inferredAgg = AggregationType.COUNT_DISTINCT;
    else if (questionId.includes('units')) inferredAgg = AggregationType.SUM;

    return { metric: inferredMetric, aggregation: inferredAgg };
};

/**
 * Infers the correct dimension column from a question's requirements.
 */
export const inferDimensionFromQuestion = (
    dataset: Dataset,
    questionDef: QuestionDef | undefined,
    questionLabel: string,
    questionId: string,
    availableDims: string[]
): string => {
    let inferredDim = '';

    if (questionDef?.req) {
        const dimReq = questionDef.req.find(r => ['product_name', 'source', 'campaign'].includes(r));
        if (dimReq) {
            const aliases: Record<string, string[]> = {
                product_name: ['product', 'item', 'sku'],
                source: ['source', 'channel', 'medium', 'referrer'],
                campaign: ['campaign', 'promo', 'ad']
            };
            const keywords = aliases[dimReq] || [dimReq];
            // Score-based matching: prefer columns that match earlier (higher priority) keywords
            let bestCol = '';
            let bestScore = -1;
            for (const d of availableDims) {
                const dl = d.toLowerCase();
                for (let ki = 0; ki < keywords.length; ki++) {
                    if (dl.includes(keywords[ki])) {
                        // Higher score for earlier keywords AND for _name suffix over _id
                        let score = (keywords.length - ki) * 10;
                        if (dl.endsWith('_name') || dl.endsWith(' name')) score += 5;
                        if (dl.endsWith('_id') || dl.endsWith(' id')) score -= 10;
                        if (score > bestScore) {
                            bestScore = score;
                            bestCol = d;
                        }
                        break;
                    }
                }
            }
            inferredDim = bestCol;
        }
    }

    if (!inferredDim) {
        const qLabel = questionLabel.toLowerCase();
        if (qLabel.includes(' by ') || qLabel.includes(' per ') || qLabel.includes(' trend')) {
            if (questionId.startsWith('d_')) inferredDim = 'day';
            else if (questionId.startsWith('w_')) inferredDim = 'week';
            else if (questionId.startsWith('m_')) inferredDim = 'month';
            else {
                inferredDim = availableDims.find(d =>
                    d.toLowerCase().includes('product') ||
                    d.toLowerCase().includes('source') ||
                    d.toLowerCase().includes('category')
                ) || availableDims[0] || '';
            }
        }
    }

    return inferredDim;
};

/**
 * Infers the time filter from a question ID pattern.
 */
export const inferTimeFilter = (questionId: string): string => {
    if (questionId.includes('today') || questionId.startsWith('d_') || questionId === 'op_track_vs_y' || questionId === 'op_target') return 'today';
    if (questionId.includes('week') || questionId.startsWith('w_') || questionId === 'op_losing_mo' || questionId === 'op_gaining_share') return 'last_7_days';
    if (questionId.includes('month') || questionId.startsWith('m_')) return 'this_month';
    if (questionId.includes('quarter') || questionId.startsWith('q_')) return 'this_quarter';
    if (questionId.includes('year') || questionId.startsWith('y_') || questionId.startsWith('ytd')) return 'this_year';
    if (questionId.includes('30d')) return 'last_30_days';
    if (questionId.includes('7d')) return 'last_7_days';
    return 'all_time';
};

/**
 * Determines which customizer controls are allowed for a given question.
 */
export const getAllowedControls = (inferredDim: string): string[] => {
    const allowed: string[] = ['metric', 'time'];
    if (inferredDim) {
        allowed.push('dimension', 'sort', 'limit');
    }
    return allowed;
};

// ─── DYNAMIC LABEL GENERATION ────────────────────────────────

const TIME_MAP: Record<string, string> = {
    'today': 'today',
    'yesterday': 'yesterday',
    'this_week': 'this week',
    'this_month': 'this month',
    'this_quarter': 'this quarter',
    'this_year': 'this year',
    'last_7_days': 'in the last 7 days',
    'last_30_days': 'in the last 30 days',
    'last_90_days': 'in the last 90 days',
    'all_time': 'of all time'
};

const TIME_PATTERNS = [
    'today', 'yesterday', 'this week', 'this month', 'this quarter', 'this year',
    'in the last \\d+ days?', 'in the last \\d+ weeks?', 'in the last \\d+ months?', 'in the last \\d+ years?',
    'last \\d+ days?', 'last \\d+ weeks?', 'last \\d+ months?', 'last \\d+ years?',
    'of all time'
];

/**
 * Generates a human-readable question label from a config.
 * If an original question template is provided, performs smart substitution.
 * Pure function — no side effects.
 */
export const generateDynamicLabel = (cfg: any, originalQuestion?: string): string => {
    if (!originalQuestion) {
        const metricName = cfg.metric ? cfg.metric.replace(/_/g, ' ') : 'Records';
        const dimName = cfg.dimension ? ` by ${cfg.dimension.replace(/_/g, ' ')}` : '';
        const timeName = cfg.timeFilter && cfg.timeFilter !== 'all_time'
            ? ` ${cfg.timeFilter.replace(/^last_/, 'Last ').replace(/^this_/, 'This ').replace(/_/g, ' ')}`
            : '';

        let aggName = cfg.aggregation || 'Total';
        if (aggName === 'SUM') aggName = 'Total';
        if (aggName === 'COUNT') aggName = 'Count of';
        if (aggName === 'AVG') aggName = 'Average';

        const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        return `${capitalize(aggName)} ${capitalize(metricName)}${dimName}${timeName}`;
    }

    let result = originalQuestion;

    // Resolve time phrase
    let timePhrase = TIME_MAP[cfg.timeFilter] || cfg.timeFilter;
    if (cfg.timeFilter && cfg.timeFilter.startsWith('last_') && !TIME_MAP[cfg.timeFilter]) {
        const parts = cfg.timeFilter.split('_');
        timePhrase = `in the last ${parts[1]} ${parts[2]}`;
    }

    // Replace time references
    for (const pattern of TIME_PATTERNS) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(result) && timePhrase) {
            result = result.replace(regex, timePhrase);
            break;
        }
    }

    // Replace metric names
    if (cfg.metric) {
        const metricName = cfg.metric.replace(/_/g, ' ').toLowerCase();
        const metricPatterns = ['revenue', 'sales', 'profit', 'orders', 'units', 'quantity', 'cost', 'discount'];
        for (const oldMetric of metricPatterns) {
            if (result.toLowerCase().includes(oldMetric) && oldMetric !== metricName) {
                result = result.replace(new RegExp(oldMetric, 'i'), metricName);
                break;
            }
        }
    }

    return result;
};

// ─── CUSTOMIZER CONFIG BUILDER ─────────────────────────────

/**
 * Builds a QueryConfig from customizer settings.
 * Pure function — no side effects.
 */
export const buildCustomizerQueryConfig = (
    customConfig: any,
    asOfDate: string,
    existingConfig?: any
): QueryConfig => {
    const hasDimension = !!customConfig.dimension;

    return {
        questionId: 'custom_builder',
        metric: customConfig.metric,
        dimension: customConfig.dimension,
        aggregation: customConfig.aggregation || AggregationType.SUM,
        timeGrain: TimeGrain.RAW,
        analysisType: AnalysisType.STANDARD,
        asOfDate,
        filters: customConfig.filters || {},
        measureFilters: customConfig.measureFilters || [],
        dateFilters: customConfig.dateFilters || [],
        timeFilter: customConfig.timeFilter,
        limit: hasDimension ? customConfig.limit : 0,
        sort: hasDimension ? customConfig.sort : 'desc',
        comparison: existingConfig?.comparison || 'none',
    };
};

// ─── CHART TYPE AUTO-PICKER ────────────────────────────────

/**
 * Automatically picks the best chart type based on data characteristics.
 * Pure function — no side effects.
 */
export const autoPickChartType = (
    dimension: string,
    dataLength: number,
    aggregation: AggregationType
): string => {
    if (!dimension) return 'number'; // Scalar → KPI card
    if (['day', 'week', 'month', 'quarter', 'year'].includes(dimension)) return 'line'; // Time series
    if (dataLength <= 6) return 'pie'; // Small categories → pie
    if (dataLength > 20) return 'bar'; // Many categories → bar
    return 'bar'; // Default
};
