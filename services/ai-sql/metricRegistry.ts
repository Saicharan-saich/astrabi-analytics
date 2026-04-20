/**
 * Metric Registry — Governed composite metric definitions
 *
 * Auto-generates complex business formulas (e.g., Gross Margin %, AOV)
 * from the semantic fields in the dataset. These formulas are injected
 * into the LLM prompt so it uses the governed formula, not guesswork.
 */

import { SemanticField, MetricDefinition, DerivedMetricDefinition } from './types';

/**
 * Build derived metrics (two-stage aggregations) from the semantic fields.
 * For each numeric measure × each date column, generates:
 *   - avg_daily_{field}:   AVG( SUM({field}) GROUP BY {date_col} per day )
 *   - avg_weekly_{field}:  AVG( SUM({field}) GROUP BY {date_col} per week )
 *   - avg_monthly_{field}: AVG( SUM({field}) GROUP BY {date_col} per month )
 *
 * This is how real BI tools define compound metrics.
 */
export function buildDerivedMetrics(fields: SemanticField[]): DerivedMetricDefinition[] {
    const derived: DerivedMetricDefinition[] = [];

    // Find all measure fields and date fields
    const measures = fields.filter(f => f.role === 'metric' && (f.semanticType === 'currency' || f.semanticType === 'quantity' || f.semanticType === 'count'));
    const dateFields = fields.filter(f => f.semanticType === 'date' && f.role === 'dimension');

    if (dateFields.length === 0 || measures.length === 0) return derived;

    const primaryDate = dateFields[0]; // Use the first date field as default

    const grains: Array<{ grain: 'day' | 'week' | 'month' | 'quarter' | 'year'; label: string; synonymPrefix: string }> = [
        { grain: 'day', label: 'Daily', synonymPrefix: 'daily' },
        { grain: 'week', label: 'Weekly', synonymPrefix: 'weekly' },
        { grain: 'month', label: 'Monthly', synonymPrefix: 'monthly' },
        { grain: 'quarter', label: 'Quarterly', synonymPrefix: 'quarterly' },
        { grain: 'year', label: 'Yearly', synonymPrefix: 'yearly' },
    ];

    for (const measure of measures) {
        const fieldLabel = measure.displayLabel || measure.name.replace(/_/g, ' ');

        for (const { grain, label, synonymPrefix } of grains) {
            const id = `avg_${grain === 'day' ? 'daily' : grain === 'week' ? 'weekly' : grain === 'month' ? 'monthly' : grain === 'quarter' ? 'quarterly' : 'yearly'}_${measure.name}`;

            derived.push({
                id,
                label: `Average ${label} ${fieldLabel}`,
                type: 'derived',
                baseMetric: {
                    field: measure.name,
                    agg: measure.defaultAgg === 'avg' ? 'avg' : 'sum',
                },
                groupBy: {
                    field: primaryDate.name,
                    grain,
                },
                finalAgg: 'avg',
                semanticType: measure.semanticType,
                description: `Average of ${grain}ly total ${measure.name}. Computed as AVG(SUM(${measure.name}) GROUP BY ${primaryDate.name} per ${grain}).`,
                synonyms: [
                    `average ${synonymPrefix} ${fieldLabel.toLowerCase()}`,
                    `avg ${synonymPrefix} ${fieldLabel.toLowerCase()}`,
                    `mean ${synonymPrefix} ${fieldLabel.toLowerCase()}`,
                    `${synonymPrefix} average ${fieldLabel.toLowerCase()}`,
                ],
            });
        }
    }

    return derived;
}

/**
 * Build composite metrics automatically from the semantic fields present in the dataset.
 * Only generates metrics that are actually computable from the available columns.
 */
export function buildCompositeMetrics(fields: SemanticField[]): MetricDefinition[] {
    const metrics: MetricDefinition[] = [];
    const fieldNames = new Set(fields.map(f => f.name.toLowerCase()));
    const fieldsByName = new Map(fields.map(f => [f.name.toLowerCase(), f]));

    // Helper: find a METRIC field matching any of the given patterns
    // Only matches fields with role='metric' to avoid matching text columns
    // (e.g., 'sales_rep' should NOT match pattern 'sales')
    const findField = (...patterns: string[]): SemanticField | undefined => {
        for (const p of patterns) {
            for (const [name, field] of fieldsByName) {
                if (field.role === 'metric' && name.includes(p)) return field;
            }
        }
        return undefined;
    };

    // Helper: find ANY field (dimension or metric) matching patterns
    const findAnyField = (...patterns: string[]): SemanticField | undefined => {
        for (const p of patterns) {
            for (const [name, field] of fieldsByName) {
                if (name.includes(p)) return field;
            }
        }
        return undefined;
    };

    // ---------- Revenue / Sales based metrics ----------

    const revenueField = findField('revenue', 'sale_amt', 'sales_amt', 'sales', 'total', 'amount', 'line_total');
    const costField = findField('cost', 'cogs', 'expense');
    const profitField = findField('profit');
    const quantityField = findField('quantity', 'qty', 'units');
    const discountField = findField('discount');
    const orderIdField = findAnyField('order_id', 'transaction_id', 'invoice');
    const customerIdField = findAnyField('customer_id', 'client_id', 'customer');

    // Gross Margin %
    if (revenueField && costField) {
        metrics.push({
            id: 'gross_margin_pct',
            label: 'Gross Margin %',
            formula: `(SUM(${revenueField.name}) - SUM(${costField.name})) / NULLIF(SUM(${revenueField.name}), 0) * 100`,
            dependsOn: [revenueField.name, costField.name],
            semanticType: 'percentage',
            preAggregated: true,
            description: 'Revenue minus cost as a percentage of revenue',
            synonyms: ['gross margin', 'margin percent', 'margin pct', 'markup'],
        });
    }

    // Net Profit Margin %
    if (profitField && revenueField) {
        metrics.push({
            id: 'net_profit_margin_pct',
            label: 'Net Profit Margin %',
            formula: `SUM(${profitField.name}) / NULLIF(SUM(${revenueField.name}), 0) * 100`,
            dependsOn: [profitField.name, revenueField.name],
            semanticType: 'percentage',
            preAggregated: true,
            description: 'Profit as a percentage of revenue',
            synonyms: ['profit margin', 'net margin', 'profit pct'],
        });
    }

    // Average Order Value (AOV)
    if (revenueField && orderIdField) {
        metrics.push({
            id: 'avg_order_value',
            label: 'Average Order Value',
            formula: `SUM(${revenueField.name}) / NULLIF(COUNT(DISTINCT ${orderIdField.name}), 0)`,
            dependsOn: [revenueField.name, orderIdField.name],
            semanticType: 'currency',
            preAggregated: true,
            description: 'Total revenue divided by number of unique orders',
            synonyms: ['aov', 'average order', 'order average', 'avg order'],
        });
    }

    // Average Items Per Order
    if (quantityField && orderIdField) {
        metrics.push({
            id: 'avg_items_per_order',
            label: 'Average Items per Order',
            formula: `SUM(${quantityField.name}) / NULLIF(COUNT(DISTINCT ${orderIdField.name}), 0)`,
            dependsOn: [quantityField.name, orderIdField.name],
            semanticType: 'quantity',
            preAggregated: true,
            description: 'Average number of items per order',
            synonyms: ['items per order', 'basket size', 'order size'],
        });
    }

    // Revenue Per Customer
    if (revenueField && customerIdField) {
        metrics.push({
            id: 'revenue_per_customer',
            label: 'Revenue per Customer',
            formula: `SUM(${revenueField.name}) / NULLIF(COUNT(DISTINCT ${customerIdField.name}), 0)`,
            dependsOn: [revenueField.name, customerIdField.name],
            semanticType: 'currency',
            preAggregated: true,
            description: 'Total revenue divided by number of unique customers',
            synonyms: ['customer value', 'arpu', 'ltv', 'clv', 'per customer revenue'],
        });
    }

    // Discount Rate
    if (discountField && revenueField) {
        metrics.push({
            id: 'discount_rate',
            label: 'Discount Rate',
            formula: `SUM(${discountField.name}) / NULLIF(SUM(${revenueField.name}), 0) * 100`,
            dependsOn: [discountField.name, revenueField.name],
            semanticType: 'percentage',
            preAggregated: true,
            description: 'Total discount as a percentage of revenue',
            synonyms: ['discount pct', 'markdown rate', 'discount percentage'],
        });
    }

    // Total Orders
    if (orderIdField) {
        metrics.push({
            id: 'total_orders',
            label: 'Total Orders',
            formula: `COUNT(DISTINCT ${orderIdField.name})`,
            dependsOn: [orderIdField.name],
            semanticType: 'count',
            preAggregated: true,
            description: 'Count of unique orders',
            synonyms: ['order count', 'number of orders', 'orders'],
        });
    }

    // Total Customers
    if (customerIdField) {
        metrics.push({
            id: 'total_customers',
            label: 'Total Customers',
            formula: `COUNT(DISTINCT ${customerIdField.name})`,
            dependsOn: [customerIdField.name],
            semanticType: 'count',
            preAggregated: true,
            description: 'Count of unique customers',
            synonyms: ['customer count', 'number of customers', 'unique customers'],
        });
    }

    return metrics;
}
