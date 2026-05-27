/**
 * Metric Template Dictionary — Index
 * Aggregates all industry template libraries into a single registry.
 */

export type { MetricTemplate, MetricInput, Industry } from './types';
export { INDUSTRY_META, IN, m } from './types';

import { MetricTemplate, Industry, INDUSTRY_META } from './types';
import { SALES_TEMPLATES } from './sales';
import { HR_TEMPLATES } from './hr';
import { HEALTHCARE_TEMPLATES } from './healthcare';
import { MANUFACTURING_TEMPLATES } from './manufacturing';
import { MARKETING_TEMPLATES } from './marketing';
import { EDUCATION_TEMPLATES } from './education';

/** All templates across all industries */
export const ALL_TEMPLATES: MetricTemplate[] = [
    ...SALES_TEMPLATES,
    ...HR_TEMPLATES,
    ...HEALTHCARE_TEMPLATES,
    ...MANUFACTURING_TEMPLATES,
    ...MARKETING_TEMPLATES,
    ...EDUCATION_TEMPLATES,
];

/** Industry-specific template maps */
export const TEMPLATES_BY_INDUSTRY: Record<Industry, MetricTemplate[]> = {
    sales: SALES_TEMPLATES,
    hr: HR_TEMPLATES,
    healthcare: HEALTHCARE_TEMPLATES,
    manufacturing: MANUFACTURING_TEMPLATES,
    marketing: MARKETING_TEMPLATES,
    education: EDUCATION_TEMPLATES,
};

/** Map domain profile names to industry keys */
const DOMAIN_TO_INDUSTRY: Record<string, Industry> = {
    'sales': 'sales', 'revenue': 'sales', 'commerce': 'sales', 'retail': 'sales', 'ecommerce': 'sales',
    'finance': 'sales', 'financial': 'sales', 'accounting': 'sales',
    'hr': 'hr', 'human resources': 'hr', 'workforce': 'hr', 'people': 'hr', 'talent': 'hr', 'payroll': 'hr',
    'healthcare': 'healthcare', 'health': 'healthcare', 'medical': 'healthcare', 'clinical': 'healthcare',
    'hospital': 'healthcare', 'patient': 'healthcare', 'pharma': 'healthcare',
    'manufacturing': 'manufacturing', 'production': 'manufacturing', 'supply chain': 'manufacturing',
    'logistics': 'manufacturing', 'operations': 'manufacturing', 'factory': 'manufacturing',
    'marketing': 'marketing', 'advertising': 'marketing', 'digital': 'marketing', 'campaign': 'marketing',
    'social media': 'marketing', 'seo': 'marketing', 'growth': 'marketing',
    'education': 'education', 'academic': 'education', 'university': 'education', 'school': 'education',
    'student': 'education', 'learning': 'education', 'training': 'education',
};

/** Resolve detected domain profile to industry key */
export function resolveIndustry(domainProfile?: string): Industry | null {
    if (!domainProfile) return null;
    const key = domainProfile.toLowerCase().trim();
    return DOMAIN_TO_INDUSTRY[key] || null;
}

/**
 * Get templates relevant to a dataset's detected domain.
 * Returns the matched industry first, then all others.
 */
export function getTemplatesForDomain(domainProfile?: string): {
    primary: { industry: Industry; label: string; icon: string; templates: MetricTemplate[] } | null;
    others: { industry: Industry; label: string; icon: string; templates: MetricTemplate[] }[];
} {
    const matched = resolveIndustry(domainProfile);

    if (matched) {
        const meta = INDUSTRY_META[matched];
        const others = (Object.keys(TEMPLATES_BY_INDUSTRY) as Industry[])
            .filter(k => k !== matched)
            .map(k => ({ industry: k, ...INDUSTRY_META[k], templates: TEMPLATES_BY_INDUSTRY[k] }));
        return {
            primary: { industry: matched, ...meta, templates: TEMPLATES_BY_INDUSTRY[matched] },
            others,
        };
    }

    return {
        primary: null,
        others: (Object.keys(TEMPLATES_BY_INDUSTRY) as Industry[])
            .map(k => ({ industry: k, ...INDUSTRY_META[k], templates: TEMPLATES_BY_INDUSTRY[k] })),
    };
}

/** Search templates by name, description, category, or formula */
export function searchTemplates(query: string, templates: MetricTemplate[]): MetricTemplate[] {
    const q = query.toLowerCase().trim();
    if (!q) return templates;
    return templates.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.formulaPreview.toLowerCase().includes(q)
    );
}

/** Auto-suggest column mappings based on fuzzy name matching */
export function autoSuggestMappings(
    template: MetricTemplate,
    columns: { name: string; type: string; semanticRole?: string; label?: string }[]
): Record<string, string> {
    const suggestions: Record<string, string> = {};
    const numericCols = columns.filter(c => c.type === 'METRIC' || c.type === 'number');

    for (const input of template.requiredInputs) {
        const role = input.semanticRole.toLowerCase();
        const label = input.label.toLowerCase();

        let match = numericCols.find(c => String(c.semanticRole || '').toLowerCase() === role);
        if (!match) {
            const keywords = label.split(/\s+/);
            match = numericCols.find(c => {
                const n = (c.label || c.name).toLowerCase().replace(/_/g, ' ');
                return keywords.some(kw => n.includes(kw));
            });
        }
        if (!match) {
            match = numericCols.find(c => (c.label || c.name).toLowerCase().replace(/_/g, ' ').includes(role));
        }
        if (match) suggestions[input.key] = match.name;
    }
    return suggestions;
}
