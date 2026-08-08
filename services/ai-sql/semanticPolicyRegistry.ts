/**
 * semanticPolicyRegistry.ts — Configurable Analytical Concept Defaults
 *
 * Describes analytical CONCEPTS (not individual questions).
 * Each policy defines how QuickInsight should interpret vague
 * language like "high", "top", "recent", "best", etc.
 *
 * Policies are:
 *   - Configurable per domain (Sales vs Healthcare vs Finance)
 *   - Resolved locally via DuckDB statistics (not LLM guessing)
 *   - Overridable by users post-hoc
 *
 * This is the single source of truth for default interpretations.
 */

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type PolicyResolution = 'local_stats' | 'fixed_value' | 'domain_default' | 'semantic_model';

export interface SemanticPolicy {
    /** Unique concept ID, e.g. "high_metric" */
    concept: string;
    /** Human-readable label for UI display */
    label: string;
    /** Default interpretation text */
    defaultInterpretation: string;
    /** Alternative interpretations the user can choose */
    alternatives: PolicyAlternative[];
    /** How to resolve the threshold/value */
    resolution: PolicyResolution;
    /** Fixed value (for resolution = 'fixed_value') */
    fixedValue?: number | string;
    /** DuckDB SQL fragment to compute threshold (for resolution = 'local_stats') */
    statExpression?: string;
    /** Confidence in the default (0-1) */
    confidence: number;
    /** Can the user override this? */
    configurable: boolean;
    /** Domain-specific overrides */
    domainOverrides?: Record<string, Partial<SemanticPolicy>>;
    /** Trigger phrases that activate this policy */
    triggerPhrases: string[];
    /** Category for UI grouping */
    category: 'threshold' | 'ranking' | 'time' | 'comparison' | 'aggregation' | 'scope';
}

export interface PolicyAlternative {
    id: string;
    label: string;
    interpretation: string;
    statExpression?: string;
    fixedValue?: number | string;
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULT POLICIES
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_POLICIES: SemanticPolicy[] = [
    // ─── Threshold Policies ──────────────────────────────────────
    {
        concept: 'high_metric',
        label: 'High Metric',
        defaultInterpretation: 'Above the entity-level average',
        alternatives: [
            { id: 'above_avg', label: 'Above average', interpretation: 'Greater than the mean', statExpression: 'AVG({metric})' },
            { id: 'top_quartile', label: 'Top 25%', interpretation: 'Above the 75th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.75)' },
            { id: 'top_decile', label: 'Top 10%', interpretation: 'Above the 90th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.90)' },
            { id: 'above_median', label: 'Above median', interpretation: 'Greater than the median', statExpression: 'MEDIAN({metric})' },
        ],
        resolution: 'local_stats',
        statExpression: 'AVG({metric})',
        confidence: 0.85,
        configurable: true,
        triggerPhrases: ['high', 'strong', 'good', 'above', 'exceeding', 'over', 'more than average'],
        category: 'threshold',
    },
    {
        concept: 'very_high_metric',
        label: 'Very High Metric',
        defaultInterpretation: 'Top quartile (75th percentile and above)',
        alternatives: [
            { id: 'top_quartile', label: 'Top 25%', interpretation: 'Above 75th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.75)' },
            { id: 'top_decile', label: 'Top 10%', interpretation: 'Above 90th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.90)' },
            { id: 'top_5pct', label: 'Top 5%', interpretation: 'Above 95th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.95)' },
            { id: 'above_2sigma', label: '2σ above mean', interpretation: 'More than 2 standard deviations above mean', statExpression: 'AVG({metric}) + 2 * STDDEV({metric})' },
        ],
        resolution: 'local_stats',
        statExpression: 'QUANTILE_CONT({metric}, 0.75)',
        confidence: 0.80,
        configurable: true,
        triggerPhrases: ['very high', 'extremely high', 'outstanding', 'exceptional', 'top-performing'],
        category: 'threshold',
    },
    {
        concept: 'low_metric',
        label: 'Low Metric',
        defaultInterpretation: 'Below the entity-level average',
        alternatives: [
            { id: 'below_avg', label: 'Below average', interpretation: 'Less than the mean', statExpression: 'AVG({metric})' },
            { id: 'bottom_quartile', label: 'Bottom 25%', interpretation: 'Below the 25th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.25)' },
            { id: 'bottom_decile', label: 'Bottom 10%', interpretation: 'Below the 10th percentile', statExpression: 'QUANTILE_CONT({metric}, 0.10)' },
            { id: 'below_median', label: 'Below median', interpretation: 'Less than the median', statExpression: 'MEDIAN({metric})' },
        ],
        resolution: 'local_stats',
        statExpression: 'AVG({metric})',
        confidence: 0.85,
        configurable: true,
        triggerPhrases: ['low', 'weak', 'poor', 'below', 'under', 'less than average', 'underperforming'],
        category: 'threshold',
    },
    {
        concept: 'negative_metric',
        label: 'Negative Metric',
        defaultInterpretation: 'Aggregate value is zero or below',
        alternatives: [
            { id: 'zero_or_below', label: 'Zero or negative', interpretation: 'Value ≤ 0', fixedValue: 0 },
            { id: 'strictly_negative', label: 'Strictly negative', interpretation: 'Value < 0', fixedValue: 0 },
            { id: 'loss_making', label: 'Loss-making', interpretation: 'Profit < 0 or margin < 0', fixedValue: 0 },
        ],
        resolution: 'fixed_value',
        fixedValue: 0,
        confidence: 0.95,
        configurable: true,
        triggerPhrases: ['negative', 'loss', 'losing', 'deficit', 'in the red'],
        category: 'threshold',
    },
    {
        concept: 'unusual_metric',
        label: 'Unusual / Outlier',
        defaultInterpretation: 'Beyond 2 standard deviations from the mean',
        alternatives: [
            { id: '2sigma', label: '2σ outlier', interpretation: 'More than 2 standard deviations', statExpression: 'AVG({metric}) + 2 * STDDEV({metric})' },
            { id: '3sigma', label: '3σ outlier', interpretation: 'More than 3 standard deviations', statExpression: 'AVG({metric}) + 3 * STDDEV({metric})' },
            { id: 'iqr', label: 'IQR outlier', interpretation: 'Outside 1.5× interquartile range', statExpression: 'QUANTILE_CONT({metric}, 0.75) + 1.5 * (QUANTILE_CONT({metric}, 0.75) - QUANTILE_CONT({metric}, 0.25))' },
        ],
        resolution: 'local_stats',
        statExpression: 'AVG({metric}) + 2 * STDDEV({metric})',
        confidence: 0.80,
        configurable: true,
        triggerPhrases: ['unusual', 'outlier', 'anomaly', 'abnormal', 'unexpected', 'spike', 'anomalous'],
        category: 'threshold',
    },

    // ─── Ranking Policies ────────────────────────────────────────
    {
        concept: 'top_entities',
        label: 'Top N Entities',
        defaultInterpretation: 'Top 10 entities by the primary metric',
        alternatives: [
            { id: 'top_5', label: 'Top 5', interpretation: 'Show top 5', fixedValue: 5 },
            { id: 'top_10', label: 'Top 10', interpretation: 'Show top 10', fixedValue: 10 },
            { id: 'top_20', label: 'Top 20', interpretation: 'Show top 20', fixedValue: 20 },
            { id: 'top_50', label: 'Top 50', interpretation: 'Show top 50', fixedValue: 50 },
        ],
        resolution: 'fixed_value',
        fixedValue: 10,
        confidence: 0.90,
        configurable: true,
        triggerPhrases: ['top', 'best', 'leading', 'highest', 'most'],
        category: 'ranking',
    },
    {
        concept: 'bottom_entities',
        label: 'Bottom N Entities',
        defaultInterpretation: 'Bottom 10 entities by the primary metric',
        alternatives: [
            { id: 'bottom_5', label: 'Bottom 5', interpretation: 'Show bottom 5', fixedValue: 5 },
            { id: 'bottom_10', label: 'Bottom 10', interpretation: 'Show bottom 10', fixedValue: 10 },
            { id: 'bottom_20', label: 'Bottom 20', interpretation: 'Show bottom 20', fixedValue: 20 },
        ],
        resolution: 'fixed_value',
        fixedValue: 10,
        confidence: 0.90,
        configurable: true,
        triggerPhrases: ['bottom', 'worst', 'lowest', 'least', 'fewest', 'underperforming'],
        category: 'ranking',
    },

    // ─── Time Policies ───────────────────────────────────────────
    {
        concept: 'recent',
        label: 'Recent Time Period',
        defaultInterpretation: 'Latest 30 days relative to the dataset maximum date',
        alternatives: [
            { id: 'last_7', label: 'Last 7 days', interpretation: 'Past week', fixedValue: 7 },
            { id: 'last_30', label: 'Last 30 days', interpretation: 'Past month', fixedValue: 30 },
            { id: 'last_90', label: 'Last 90 days', interpretation: 'Past quarter', fixedValue: 90 },
            { id: 'this_month', label: 'This month', interpretation: 'Current calendar month', fixedValue: 'this_month' },
            { id: 'this_quarter', label: 'This quarter', interpretation: 'Current calendar quarter', fixedValue: 'this_quarter' },
        ],
        resolution: 'fixed_value',
        fixedValue: 30,
        confidence: 0.75,
        configurable: true,
        triggerPhrases: ['recent', 'recently', 'latest', 'current', 'now', 'currently', 'right now'],
        category: 'time',
        domainOverrides: {
            'healthcare': { fixedValue: 90, defaultInterpretation: 'Latest 90 days (clinical standard)' },
            'finance': { fixedValue: 30, defaultInterpretation: 'Latest 30 days (financial period)' },
        },
    },
    {
        concept: 'last_period',
        label: 'Last Period',
        defaultInterpretation: 'Previous comparable time period (auto-detected grain)',
        alternatives: [
            { id: 'prev_day', label: 'Yesterday', interpretation: 'Previous day' },
            { id: 'prev_week', label: 'Last week', interpretation: 'Previous 7 days' },
            { id: 'prev_month', label: 'Last month', interpretation: 'Previous calendar month' },
            { id: 'prev_quarter', label: 'Last quarter', interpretation: 'Previous calendar quarter' },
            { id: 'prev_year', label: 'Last year', interpretation: 'Previous calendar year' },
        ],
        resolution: 'domain_default',
        confidence: 0.70,
        configurable: true,
        triggerPhrases: ['last period', 'previous period', 'prior period', 'compared to before'],
        category: 'time',
    },

    // ─── Comparison Policies ─────────────────────────────────────
    {
        concept: 'growth',
        label: 'Growth Comparison',
        defaultInterpretation: 'Compared to the previous comparable period',
        alternatives: [
            { id: 'pop', label: 'Period over period', interpretation: 'vs same-length previous period' },
            { id: 'yoy', label: 'Year over year', interpretation: 'vs same period last year' },
            { id: 'mom', label: 'Month over month', interpretation: 'vs previous month' },
            { id: 'wow', label: 'Week over week', interpretation: 'vs previous week' },
        ],
        resolution: 'domain_default',
        confidence: 0.80,
        configurable: true,
        triggerPhrases: ['growth', 'growing', 'increase', 'change', 'trend', 'momentum'],
        category: 'comparison',
    },
    {
        concept: 'contribution',
        label: 'Contribution / Share',
        defaultInterpretation: 'Percentage of the total',
        alternatives: [
            { id: 'pct_total', label: '% of total', interpretation: 'value / SUM(value) × 100' },
            { id: 'pct_category', label: '% of category', interpretation: 'value / category_total × 100' },
        ],
        resolution: 'local_stats',
        confidence: 0.90,
        configurable: true,
        triggerPhrases: ['contribution', 'share', 'portion', 'percentage of', 'proportion', 'mix'],
        category: 'comparison',
    },

    // ─── Aggregation Policies ────────────────────────────────────
    {
        concept: 'performance',
        label: 'Performance (Multi-KPI)',
        defaultInterpretation: 'Governed KPI bundle: primary metric, secondary metric, growth, and margin',
        alternatives: [
            { id: 'revenue_only', label: 'Revenue only', interpretation: 'Primary revenue metric' },
            { id: 'profit_only', label: 'Profit only', interpretation: 'Profit or margin metric' },
            { id: 'full_bundle', label: 'Full KPI bundle', interpretation: 'Revenue + Profit + Growth + Margin' },
        ],
        resolution: 'semantic_model',
        confidence: 0.65,
        configurable: true,
        triggerPhrases: ['performance', 'performing', 'how are we doing', 'kpi', 'metrics', 'results'],
        category: 'aggregation',
    },
    {
        concept: 'best_entity',
        label: 'Best Entity',
        defaultInterpretation: 'Ranked by the primary governed KPI from the semantic model',
        alternatives: [
            { id: 'by_revenue', label: 'By revenue', interpretation: 'Highest total revenue' },
            { id: 'by_profit', label: 'By profit', interpretation: 'Highest total profit' },
            { id: 'by_count', label: 'By volume', interpretation: 'Highest transaction count' },
            { id: 'by_margin', label: 'By margin', interpretation: 'Highest profit margin %' },
        ],
        resolution: 'semantic_model',
        confidence: 0.75,
        configurable: true,
        triggerPhrases: ['best', 'most successful', 'highest performing', 'number one', 'leader'],
        category: 'aggregation',
    },
    {
        concept: 'significant',
        label: 'Significant Contribution',
        defaultInterpretation: 'Contributes at least 5% of the total',
        alternatives: [
            { id: 'pct_5', label: '≥ 5% of total', interpretation: 'At least 5% contribution', fixedValue: 0.05 },
            { id: 'pct_10', label: '≥ 10% of total', interpretation: 'At least 10% contribution', fixedValue: 0.10 },
            { id: 'pct_1', label: '≥ 1% of total', interpretation: 'At least 1% contribution', fixedValue: 0.01 },
        ],
        resolution: 'fixed_value',
        fixedValue: 0.05,
        confidence: 0.85,
        configurable: true,
        triggerPhrases: ['significant', 'meaningful', 'material', 'important', 'notable', 'major'],
        category: 'scope',
    },
];

// ═══════════════════════════════════════════════════════════════════
// REGISTRY CLASS
// ═══════════════════════════════════════════════════════════════════

export class SemanticPolicyRegistry {
    private policies: Map<string, SemanticPolicy>;
    private domain: string | null;

    constructor(domain?: string) {
        this.policies = new Map();
        this.domain = domain || null;

        // Load defaults
        for (const policy of DEFAULT_POLICIES) {
            this.policies.set(policy.concept, policy);
        }
    }

    /** Get all policies */
    getAll(): SemanticPolicy[] {
        return Array.from(this.policies.values());
    }

    /** Get a specific policy by concept ID */
    get(concept: string): SemanticPolicy | undefined {
        const policy = this.policies.get(concept);
        if (!policy) return undefined;

        // Apply domain override if available
        if (this.domain && policy.domainOverrides?.[this.domain.toLowerCase()]) {
            return { ...policy, ...policy.domainOverrides[this.domain.toLowerCase()] };
        }
        return policy;
    }

    /** Find policies matching a trigger phrase */
    findByPhrase(phrase: string): SemanticPolicy[] {
        const lower = phrase.toLowerCase().trim();
        return this.getAll().filter(p =>
            p.triggerPhrases.some(tp => lower.includes(tp))
        );
    }

    /** Find the single best-matching policy for a phrase */
    matchPhrase(phrase: string): { policy: SemanticPolicy; matchedTrigger: string } | null {
        const lower = phrase.toLowerCase().trim();
        let bestMatch: { policy: SemanticPolicy; matchedTrigger: string; length: number } | null = null;

        for (const policy of this.getAll()) {
            for (const trigger of policy.triggerPhrases) {
                if (lower.includes(trigger) && (!bestMatch || trigger.length > bestMatch.length)) {
                    bestMatch = { policy, matchedTrigger: trigger, length: trigger.length };
                }
            }
        }

        return bestMatch ? { policy: bestMatch.policy, matchedTrigger: bestMatch.matchedTrigger } : null;
    }

    /** Set the active domain (applies domain overrides) */
    setDomain(domain: string): void {
        this.domain = domain;
    }

    /** Override a policy's default for this session */
    override(concept: string, alternativeId: string): boolean {
        const policy = this.policies.get(concept);
        if (!policy) return false;

        const alt = policy.alternatives.find(a => a.id === alternativeId);
        if (!alt) return false;

        const updated: SemanticPolicy = {
            ...policy,
            defaultInterpretation: alt.interpretation,
            fixedValue: alt.fixedValue ?? policy.fixedValue,
            statExpression: alt.statExpression ?? policy.statExpression,
        };
        this.policies.set(concept, updated);
        return true;
    }

    /** Register a custom policy */
    register(policy: SemanticPolicy): void {
        this.policies.set(policy.concept, policy);
    }

    /** Get the SQL expression for a policy, substituting the metric column name */
    getStatExpression(concept: string, metricColumn: string): string | null {
        const policy = this.get(concept);
        if (!policy?.statExpression) return null;
        return policy.statExpression.replace(/\{metric\}/g, `"${metricColumn}"`);
    }

    /** Get the fixed threshold value for a policy */
    getFixedValue(concept: string): number | string | undefined {
        return this.get(concept)?.fixedValue;
    }
}

// ═══════════════════════════════════════════════════════════════════
// SINGLETON FACTORY
// ═══════════════════════════════════════════════════════════════════

let _instance: SemanticPolicyRegistry | null = null;

export function getPolicyRegistry(domain?: string): SemanticPolicyRegistry {
    if (!_instance || (domain && _instance['domain'] !== domain)) {
        _instance = new SemanticPolicyRegistry(domain);
    }
    return _instance;
}

/** Reset for testing */
export function resetPolicyRegistry(): void {
    _instance = null;
}
