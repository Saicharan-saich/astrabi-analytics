/**
 * Metric Templates — Curated business metric library.
 *
 * Each template declares:
 *   - Human-readable name, description, formula preview
 *   - Required inputs with semantic roles + allowed types
 *   - A pure compute function (inputs → number | null)
 *   - Semantic output metadata (behavior, aggregation, format)
 *
 * Privacy: No data leaves the browser. All computation is local.
 */

export interface MetricInput {
    key: string;           // internal key used in formulaFn
    label: string;         // human-readable label shown in mapping UI
    semanticRole: string;  // expected semantic role (e.g. 'price', 'quantity')
    allowedTypes: string[]; // e.g. ['METRIC', 'number', 'currency']
}

export interface MetricTemplate {
    id: string;
    name: string;
    description: string;
    category: MetricCategory;
    formulaPreview: string;         // human-readable formula e.g. "price × qty"
    requiredInputs: MetricInput[];
    formulaFn: (inputs: Record<string, number>) => number | null;
    outputBehavior: 'additive' | 'semi_additive' | 'non_additive';
    defaultAggregation: 'SUM' | 'AVG' | 'MIN' | 'MAX';
    outputFormat: 'currency' | 'percent' | 'number' | 'integer';
    icon: string;  // emoji
}

export type MetricCategory =
    | 'financial'
    | 'unit_economics'
    | 'customer'
    | 'inventory'
    | 'ecommerce'
    | 'operational';

export const CATEGORY_META: Record<MetricCategory, { label: string; icon: string }> = {
    financial:      { label: 'Financial Metrics',     icon: '💰' },
    unit_economics: { label: 'Unit Economics',        icon: '📊' },
    customer:       { label: 'Customer Analytics',    icon: '👥' },
    inventory:      { label: 'Inventory & Ops',       icon: '📦' },
    ecommerce:      { label: 'Ecommerce Metrics',     icon: '🛒' },
    operational:    { label: 'Operational KPIs',       icon: '⚙️' },
};

// ────────────────────────────────────────────────────────────────
// Template Library
// ────────────────────────────────────────────────────────────────

export const METRIC_TEMPLATES: MetricTemplate[] = [

    // ── Financial ──────────────────────────────────────────────

    {
        id: 'total_sales',
        name: 'Total Sales',
        description: 'Revenue generated from sold units.',
        category: 'financial',
        formulaPreview: 'unit_price × quantity',
        icon: '💵',
        requiredInputs: [
            { key: 'price', label: 'Unit Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, qty }) => price * qty,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    {
        id: 'gross_profit',
        name: 'Gross Profit',
        description: 'Revenue minus cost of goods sold per unit.',
        category: 'financial',
        formulaPreview: '(price − cost) × quantity',
        icon: '📈',
        requiredInputs: [
            { key: 'price', label: 'Unit Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'cost', label: 'Cost Price', semanticRole: 'cost', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, cost, qty }) => (price - cost) * qty,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    {
        id: 'net_revenue',
        name: 'Net Revenue',
        description: 'Revenue after applying discounts.',
        category: 'financial',
        formulaPreview: 'price × qty × (1 − discount/100)',
        icon: '💳',
        requiredInputs: [
            { key: 'price', label: 'Unit Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
            { key: 'discount', label: 'Discount %', semanticRole: 'discount', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, qty, discount }) => price * qty * (1 - (discount || 0) / 100),
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    {
        id: 'profit_margin_pct',
        name: 'Profit Margin %',
        description: 'Percentage of revenue retained as profit.',
        category: 'financial',
        formulaPreview: '(price − cost) / price × 100',
        icon: '📉',
        requiredInputs: [
            { key: 'price', label: 'Revenue / Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'cost', label: 'Cost', semanticRole: 'cost', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, cost }) => price === 0 ? null : ((price - cost) / price) * 100,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'percent',
    },

    {
        id: 'discount_impact',
        name: 'Discount Impact',
        description: 'Revenue lost to discounts per unit.',
        category: 'financial',
        formulaPreview: 'price × quantity × (discount / 100)',
        icon: '🏷️',
        requiredInputs: [
            { key: 'price', label: 'Unit Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
            { key: 'discount', label: 'Discount %', semanticRole: 'discount', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, qty, discount }) => price * qty * ((discount || 0) / 100),
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    {
        id: 'cost_of_goods_sold',
        name: 'Cost of Goods Sold',
        description: 'Total cost incurred for goods sold.',
        category: 'financial',
        formulaPreview: 'cost_price × quantity',
        icon: '🏭',
        requiredInputs: [
            { key: 'cost', label: 'Cost Price', semanticRole: 'cost', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ cost, qty }) => cost * qty,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    // ── Unit Economics ────────────────────────────────────────

    {
        id: 'revenue_per_unit',
        name: 'Revenue Per Unit',
        description: 'Average revenue generated per unit sold.',
        category: 'unit_economics',
        formulaPreview: 'total_revenue / quantity',
        icon: '💲',
        requiredInputs: [
            { key: 'revenue', label: 'Revenue', semanticRole: 'revenue', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ revenue, qty }) => qty === 0 ? null : revenue / qty,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'currency',
    },

    {
        id: 'cost_per_unit',
        name: 'Cost Per Unit',
        description: 'Average cost incurred per unit.',
        category: 'unit_economics',
        formulaPreview: 'total_cost / quantity',
        icon: '🏷️',
        requiredInputs: [
            { key: 'cost', label: 'Total Cost', semanticRole: 'cost', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ cost, qty }) => qty === 0 ? null : cost / qty,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'currency',
    },

    {
        id: 'markup_pct',
        name: 'Markup %',
        description: 'Percentage markup over cost.',
        category: 'unit_economics',
        formulaPreview: '(price − cost) / cost × 100',
        icon: '📐',
        requiredInputs: [
            { key: 'price', label: 'Selling Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'cost', label: 'Cost Price', semanticRole: 'cost', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, cost }) => cost === 0 ? null : ((price - cost) / cost) * 100,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'percent',
    },

    {
        id: 'contribution_margin',
        name: 'Contribution Margin',
        description: 'Revenue minus variable costs per unit.',
        category: 'unit_economics',
        formulaPreview: 'price − cost',
        icon: '🎯',
        requiredInputs: [
            { key: 'price', label: 'Selling Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'cost', label: 'Variable Cost', semanticRole: 'cost', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, cost }) => price - cost,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    // ── Customer Analytics ────────────────────────────────────

    {
        id: 'revenue_per_customer',
        name: 'Revenue Per Customer',
        description: 'Average revenue generated per transaction.',
        category: 'customer',
        formulaPreview: 'price × quantity',
        icon: '👤',
        requiredInputs: [
            { key: 'price', label: 'Unit Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, qty }) => price * qty,
        outputBehavior: 'additive',
        defaultAggregation: 'AVG',
        outputFormat: 'currency',
    },

    {
        id: 'spend_efficiency',
        name: 'Spend Efficiency',
        description: 'Revenue generated per unit of cost.',
        category: 'customer',
        formulaPreview: 'revenue / cost',
        icon: '⚡',
        requiredInputs: [
            { key: 'revenue', label: 'Revenue', semanticRole: 'revenue', allowedTypes: ['METRIC'] },
            { key: 'cost', label: 'Cost', semanticRole: 'cost', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ revenue, cost }) => cost === 0 ? null : revenue / cost,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'number',
    },

    // ── Ecommerce ─────────────────────────────────────────────

    {
        id: 'basket_value',
        name: 'Basket Value',
        description: 'Total value of items in a transaction.',
        category: 'ecommerce',
        formulaPreview: 'price × quantity',
        icon: '🛒',
        requiredInputs: [
            { key: 'price', label: 'Item Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'qty', label: 'Quantity', semanticRole: 'quantity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ price, qty }) => price * qty,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    {
        id: 'discount_rate',
        name: 'Effective Discount Rate',
        description: 'Actual discount applied relative to list price.',
        category: 'ecommerce',
        formulaPreview: '(list_price − sell_price) / list_price × 100',
        icon: '🔖',
        requiredInputs: [
            { key: 'list', label: 'List/Original Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
            { key: 'sell', label: 'Selling Price', semanticRole: 'price', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ list, sell }) => list === 0 ? null : ((list - sell) / list) * 100,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'percent',
    },

    {
        id: 'revenue_after_returns',
        name: 'Revenue After Returns',
        description: 'Net revenue considering returned items.',
        category: 'ecommerce',
        formulaPreview: 'revenue − returns',
        icon: '↩️',
        requiredInputs: [
            { key: 'revenue', label: 'Gross Revenue', semanticRole: 'revenue', allowedTypes: ['METRIC'] },
            { key: 'returns', label: 'Returns Value', semanticRole: 'returns', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ revenue, returns }) => revenue - (returns || 0),
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'currency',
    },

    // ── Operational KPIs ──────────────────────────────────────

    {
        id: 'utilization_rate',
        name: 'Utilization Rate',
        description: 'Ratio of used capacity to total capacity.',
        category: 'operational',
        formulaPreview: 'used / total × 100',
        icon: '📏',
        requiredInputs: [
            { key: 'used', label: 'Used / Actual', semanticRole: 'actual', allowedTypes: ['METRIC'] },
            { key: 'total', label: 'Total / Capacity', semanticRole: 'capacity', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ used, total }) => total === 0 ? null : (used / total) * 100,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'percent',
    },

    {
        id: 'variance',
        name: 'Budget Variance',
        description: 'Difference between actual and budgeted values.',
        category: 'operational',
        formulaPreview: 'actual − budget',
        icon: '📊',
        requiredInputs: [
            { key: 'actual', label: 'Actual Value', semanticRole: 'actual', allowedTypes: ['METRIC'] },
            { key: 'budget', label: 'Budget / Target', semanticRole: 'budget', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ actual, budget }) => actual - budget,
        outputBehavior: 'additive',
        defaultAggregation: 'SUM',
        outputFormat: 'number',
    },

    {
        id: 'variance_pct',
        name: 'Variance %',
        description: 'Percentage deviation from target.',
        category: 'operational',
        formulaPreview: '(actual − target) / target × 100',
        icon: '📉',
        requiredInputs: [
            { key: 'actual', label: 'Actual', semanticRole: 'actual', allowedTypes: ['METRIC'] },
            { key: 'target', label: 'Target', semanticRole: 'target', allowedTypes: ['METRIC'] },
        ],
        formulaFn: ({ actual, target }) => target === 0 ? null : ((actual - target) / target) * 100,
        outputBehavior: 'non_additive',
        defaultAggregation: 'AVG',
        outputFormat: 'percent',
    },
];

// ── Helpers ──────────────────────────────────────────────────

/** Get templates grouped by category */
export function getTemplatesByCategory(): Record<MetricCategory, MetricTemplate[]> {
    const groups: Record<string, MetricTemplate[]> = {};
    for (const t of METRIC_TEMPLATES) {
        (groups[t.category] ||= []).push(t);
    }
    return groups as Record<MetricCategory, MetricTemplate[]>;
}

/** Search templates by name, description, or category */
export function searchTemplates(query: string): MetricTemplate[] {
    const q = query.toLowerCase().trim();
    if (!q) return METRIC_TEMPLATES;
    return METRIC_TEMPLATES.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.formulaPreview.toLowerCase().includes(q)
    );
}

/**
 * Auto-suggest column mappings based on fuzzy name matching.
 * Returns best-guess mapping: { inputKey → columnName }
 */
export function autoSuggestMappings(
    template: MetricTemplate,
    columns: { name: string; type: string; semanticRole?: string; label?: string }[]
): Record<string, string> {
    const suggestions: Record<string, string> = {};
    const numericCols = columns.filter(c => c.type === 'METRIC' || c.type === 'number');

    for (const input of template.requiredInputs) {
        const role = input.semanticRole.toLowerCase();
        const label = input.label.toLowerCase();

        // Priority 1: exact semantic role match
        let match = numericCols.find(c =>
            String(c.semanticRole || '').toLowerCase() === role
        );

        // Priority 2: column name contains input label keywords
        if (!match) {
            const keywords = label.split(/\s+/);
            match = numericCols.find(c => {
                const cName = (c.label || c.name).toLowerCase().replace(/_/g, ' ');
                return keywords.some(kw => cName.includes(kw));
            });
        }

        // Priority 3: column name contains semantic role
        if (!match) {
            match = numericCols.find(c => {
                const cName = (c.label || c.name).toLowerCase().replace(/_/g, ' ');
                return cName.includes(role);
            });
        }

        if (match) suggestions[input.key] = match.name;
    }

    return suggestions;
}
