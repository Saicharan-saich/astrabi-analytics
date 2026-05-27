/** Shared types for Metric Template Dictionary */

export interface MetricInput {
    key: string;
    label: string;
    semanticRole: string;
    allowedTypes: string[];
}

export interface MetricTemplate {
    id: string;
    name: string;
    description: string;
    category: string;
    industry: string;
    formulaPreview: string;
    requiredInputs: MetricInput[];
    formulaFn: (i: Record<string, number>) => number | null;
    outputBehavior: 'additive' | 'semi_additive' | 'non_additive';
    defaultAggregation: 'SUM' | 'AVG' | 'MIN' | 'MAX';
    outputFormat: 'currency' | 'percent' | 'number' | 'integer';
    icon: string;
}

export type Industry = 'sales' | 'hr' | 'healthcare' | 'manufacturing' | 'marketing' | 'education';

export const INDUSTRY_META: Record<Industry, { label: string; icon: string }> = {
    sales:          { label: 'Sales & Revenue',       icon: '💰' },
    hr:             { label: 'HR & Workforce',        icon: '👥' },
    healthcare:     { label: 'Healthcare',            icon: '🏥' },
    manufacturing:  { label: 'Manufacturing',         icon: '🏭' },
    marketing:      { label: 'Marketing & Ads',       icon: '📣' },
    education:      { label: 'Education',             icon: '🎓' },
};

// Common input presets for reuse
export const IN = {
    price:    (l = 'Unit Price')    => ({ key: 'price', label: l, semanticRole: 'price', allowedTypes: ['METRIC'] }),
    cost:     (l = 'Cost')         => ({ key: 'cost', label: l, semanticRole: 'cost', allowedTypes: ['METRIC'] }),
    qty:      (l = 'Quantity')     => ({ key: 'qty', label: l, semanticRole: 'quantity', allowedTypes: ['METRIC'] }),
    rev:      (l = 'Revenue')      => ({ key: 'revenue', label: l, semanticRole: 'revenue', allowedTypes: ['METRIC'] }),
    disc:     (l = 'Discount %')   => ({ key: 'discount', label: l, semanticRole: 'discount', allowedTypes: ['METRIC'] }),
    rate:     (l = 'Rate')         => ({ key: 'rate', label: l, semanticRole: 'rate', allowedTypes: ['METRIC'] }),
    hours:    (l = 'Hours')        => ({ key: 'hours', label: l, semanticRole: 'hours', allowedTypes: ['METRIC'] }),
    count:    (l = 'Count')        => ({ key: 'count', label: l, semanticRole: 'count', allowedTypes: ['METRIC'] }),
    total:    (l = 'Total')        => ({ key: 'total', label: l, semanticRole: 'total', allowedTypes: ['METRIC'] }),
    actual:   (l = 'Actual')       => ({ key: 'actual', label: l, semanticRole: 'actual', allowedTypes: ['METRIC'] }),
    target:   (l = 'Target')       => ({ key: 'target', label: l, semanticRole: 'target', allowedTypes: ['METRIC'] }),
    budget:   (l = 'Budget')       => ({ key: 'budget', label: l, semanticRole: 'budget', allowedTypes: ['METRIC'] }),
    weight:   (l = 'Weight/Score') => ({ key: 'weight', label: l, semanticRole: 'weight', allowedTypes: ['METRIC'] }),
    pct:      (l = 'Percentage')   => ({ key: 'pct', label: l, semanticRole: 'percentage', allowedTypes: ['METRIC'] }),
    days:     (l = 'Days')         => ({ key: 'days', label: l, semanticRole: 'days', allowedTypes: ['METRIC'] }),
    a:        (l: string, k = 'a') => ({ key: k, label: l, semanticRole: k, allowedTypes: ['METRIC'] as string[] }),
    b:        (l: string, k = 'b') => ({ key: k, label: l, semanticRole: k, allowedTypes: ['METRIC'] as string[] }),
    c:        (l: string, k = 'c') => ({ key: k, label: l, semanticRole: k, allowedTypes: ['METRIC'] as string[] }),
};

/** Shorthand metric builder */
export function m(
    industry: string, category: string, id: string, name: string, desc: string,
    icon: string, preview: string, inputs: MetricInput[],
    fn: (i: Record<string, number>) => number | null,
    fmt: MetricTemplate['outputFormat'] = 'number',
    agg: MetricTemplate['defaultAggregation'] = 'SUM',
    beh: MetricTemplate['outputBehavior'] = 'additive',
): MetricTemplate {
    return { id, name, description: desc, category, industry, formulaPreview: preview, icon, requiredInputs: inputs, formulaFn: fn, outputFormat: fmt, defaultAggregation: agg, outputBehavior: beh };
}
