/**
 * metricDictionary.ts — Living Metric Knowledge Base
 *
 * A curated, versioned dictionary that defines what every metric means,
 * how to aggregate it, what it relates to, and common confusions.
 *
 * The AI SQL pipeline consults this dictionary to:
 *   1. Resolve ambiguous metric references ("performance" → revenue + profit)
 *   2. Validate aggregation choices (never SUM a rate column)
 *   3. Detect derived metrics (AOV = revenue / orders)
 *   4. Auto-match column names to known metrics
 *   5. Explain confusion pairs (revenue ≠ profit)
 *
 * Design: Local JSON knowledge base now, API-ready interface for future
 * extraction into a standalone dictionary service.
 */

import DICTIONARY_DATA from './metricDictionaryData.json';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type MetricAggregation = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'none';
export type MetricAdditivity = 'additive' | 'semi-additive' | 'non-additive';
export type MetricFormat = 'currency' | 'number' | 'percent' | 'integer' | 'ratio' | 'duration';

export interface MetricDictionaryEntry {
    /** Unique metric ID, e.g. "revenue" */
    id: string;
    /** Display name */
    displayName: string;
    /** Detailed description */
    description: string;
    /** Applicable domains */
    domains: string[];

    /** Aggregation rules */
    aggregation: {
        default: MetricAggregation;
        allowed: MetricAggregation[];
        forbidden: MetricAggregation[];
        forbiddenReason: string;
    };

    /** Additivity classification */
    additivity: MetricAdditivity;
    additivityNote: string;

    /** Related metrics */
    relatedMetrics: string[];

    /** Derivation formula (if this metric is computed from others) */
    derivedFrom?: {
        formula: string;
        components: string[];
        formulaDescription: string;
    };

    /** Metrics that can be derived FROM this one */
    canDeriveInto?: string[];

    /** Common confusions with other metrics */
    confusionPairs: {
        confusedWith: string;
        distinction: string;
    }[];

    /** Column name patterns for auto-matching */
    columnPatterns: string[];

    /** Display format */
    format: MetricFormat;

    /** Sanity check range */
    expectedRange?: { min: number; max: number; note: string };

    /** Typical aggregation granularity */
    typicalGrains: string[];

    /** Synonyms and aliases */
    synonyms: string[];

    /** Contextual hints for the AI */
    aiHint: string;
}

export interface ConceptDefinition {
    /** Concept ID, e.g. "performance" */
    id: string;
    /** Display name */
    displayName: string;
    /** Description */
    description: string;
    /** Which metrics this concept maps to */
    metricBundle: string[];
    /** Priority order (first = primary) */
    priorityOrder: string[];
    /** Domains where this concept applies */
    domains: string[];
    /** Trigger phrases */
    triggerPhrases: string[];
}

export interface DictionaryData {
    version: string;
    lastUpdated: string;
    metrics: MetricDictionaryEntry[];
    concepts: ConceptDefinition[];
}

function runtimeStrings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
}

// ═══════════════════════════════════════════════════════════════════
// DICTIONARY ENGINE
// ═══════════════════════════════════════════════════════════════════

export class MetricDictionary {
    private metrics: Map<string, MetricDictionaryEntry>;
    private concepts: Map<string, ConceptDefinition>;
    private patternIndex: Map<string, string>; // pattern → metric ID
    private synonymIndex: Map<string, string>; // synonym → metric ID
    private version: string;

    constructor(data?: DictionaryData) {
        this.metrics = new Map();
        this.concepts = new Map();
        this.patternIndex = new Map();
        this.synonymIndex = new Map();
        this.version = '';
        this.loadData(data || DICTIONARY_DATA as DictionaryData);
    }

    private loadData(data: DictionaryData): void {
        this.version = data.version;

        // Index metrics
        for (const metric of data.metrics) {
            // Treat imported/persisted dictionary content as untrusted runtime
            // data. Normalize a copy so the imported source object stays
            // immutable across tests, hot reloads, and singleton resets.
            const normalizedMetric: MetricDictionaryEntry = {
                ...metric,
                columnPatterns: runtimeStrings(metric.columnPatterns),
                synonyms: runtimeStrings(metric.synonyms),
            };
            this.metrics.set(normalizedMetric.id, normalizedMetric);

            // Build pattern index
            for (const pattern of normalizedMetric.columnPatterns) {
                this.patternIndex.set(pattern.toLowerCase(), normalizedMetric.id);
            }

            // Build synonym index
            for (const synonym of normalizedMetric.synonyms) {
                this.synonymIndex.set(synonym.toLowerCase(), normalizedMetric.id);
            }
        }

        // Index concepts
        for (const concept of data.concepts) {
            this.concepts.set(concept.id, concept);
        }

        console.log(`[MetricDictionary] Loaded v${this.version}: ${this.metrics.size} metrics, ${this.concepts.size} concepts, ${this.patternIndex.size} patterns`);
    }

    // ─── Metric Lookups ──────────────────────────────────────────

    /** Get a metric definition by ID */
    getMetric(id: string): MetricDictionaryEntry | undefined {
        return this.metrics.get(id);
    }

    /** Get all metrics for a domain */
    getMetricsForDomain(domain: string): MetricDictionaryEntry[] {
        const lower = domain.toLowerCase();
        return Array.from(this.metrics.values()).filter(m =>
            m.domains.some(d => d.toLowerCase().includes(lower))
        );
    }

    /** Match a column name against known patterns */
    matchColumn(columnName: string): MetricDictionaryEntry | null {
        const lower = columnName.toLowerCase().replace(/[_\-\s]+/g, '_');

        // Exact pattern match
        const exactMatch = this.patternIndex.get(lower);
        if (exactMatch) return this.metrics.get(exactMatch) || null;

        // Fuzzy pattern match (contains)
        for (const [pattern, metricId] of this.patternIndex) {
            if (lower.includes(pattern) || pattern.includes(lower)) {
                return this.metrics.get(metricId) || null;
            }
        }

        return null;
    }

    /** Match a natural language term to a metric */
    matchTerm(term: string): MetricDictionaryEntry | null {
        const lower = term.toLowerCase().trim();

        // Direct ID match
        const direct = this.metrics.get(lower);
        if (direct) return direct;

        // Synonym match
        const synMatch = this.synonymIndex.get(lower);
        if (synMatch) return this.metrics.get(synMatch) || null;

        // Partial synonym match
        for (const [synonym, metricId] of this.synonymIndex) {
            if (lower.includes(synonym) || synonym.includes(lower)) {
                return this.metrics.get(metricId) || null;
            }
        }

        return null;
    }

    /** Get all metrics that could match a vague question phrase */
    findCandidateMetrics(phrase: string, domain?: string): MetricDictionaryEntry[] {
        const lower = phrase.toLowerCase();
        const candidates: MetricDictionaryEntry[] = [];

        for (const metric of this.metrics.values()) {
            // Domain filter
            if (domain && !metric.domains.some(d => d.toLowerCase().includes(domain.toLowerCase()))) {
                continue;
            }

            // Check if any synonym, pattern, or the display name matches
            const matches =
                metric.displayName.toLowerCase().includes(lower) ||
                lower.includes(metric.id) ||
                runtimeStrings(metric.synonyms).some(s => lower.includes(s.toLowerCase())) ||
                runtimeStrings(metric.columnPatterns).some(p => lower.includes(p.toLowerCase()));

            if (matches) candidates.push(metric);
        }

        return candidates;
    }

    // ─── Concept Lookups ─────────────────────────────────────────

    /** Get a concept definition */
    getConcept(id: string): ConceptDefinition | undefined {
        return this.concepts.get(id);
    }

    /** Match a phrase to a concept */
    matchConcept(phrase: string): ConceptDefinition | null {
        const lower = phrase.toLowerCase();

        for (const concept of this.concepts.values()) {
            if (concept.triggerPhrases.some(tp => lower.includes(tp))) {
                return concept;
            }
        }

        return null;
    }

    /** Resolve a concept to its metric bundle */
    resolveConceptMetrics(conceptId: string): MetricDictionaryEntry[] {
        const concept = this.concepts.get(conceptId);
        if (!concept) return [];

        return concept.metricBundle
            .map(id => this.metrics.get(id))
            .filter((m): m is MetricDictionaryEntry => m !== undefined);
    }

    // ─── Validation ──────────────────────────────────────────────

    /** Check if an aggregation is valid for a metric */
    validateAggregation(metricId: string, agg: MetricAggregation): { valid: boolean; reason?: string } {
        const metric = this.metrics.get(metricId);
        if (!metric) return { valid: true }; // unknown metric, allow anything

        if (metric.aggregation.forbidden.includes(agg)) {
            return { valid: false, reason: metric.aggregation.forbiddenReason };
        }

        if (!metric.aggregation.allowed.includes(agg)) {
            return { valid: false, reason: `${agg} is not a typical aggregation for ${metric.displayName}. Allowed: ${metric.aggregation.allowed.join(', ')}` };
        }

        return { valid: true };
    }

    /** Get the default aggregation for a metric */
    getDefaultAggregation(metricId: string): MetricAggregation {
        return this.metrics.get(metricId)?.aggregation.default || 'sum';
    }

    /** Get confusion context for a metric */
    getConfusionContext(metricId: string): string[] {
        const metric = this.metrics.get(metricId);
        if (!metric) return [];
        return metric.confusionPairs.map(cp =>
            `${metric.displayName} vs ${cp.confusedWith}: ${cp.distinction}`
        );
    }

    // ─── Derived Metrics ─────────────────────────────────────────

    /** Find metrics that can be derived from available columns */
    findDerivableMetrics(availableColumns: string[]): MetricDictionaryEntry[] {
        const availableIds = new Set(
            availableColumns
                .map(col => this.matchColumn(col)?.id)
                .filter((id): id is string => id !== undefined)
        );

        return Array.from(this.metrics.values()).filter(m => {
            if (!m.derivedFrom) return false;
            return m.derivedFrom.components.every(comp => availableIds.has(comp));
        });
    }

    // ─── Info ────────────────────────────────────────────────────

    /** Get version info */
    getVersion(): string {
        return this.version;
    }

    /** Get total counts */
    getStats(): { metrics: number; concepts: number; patterns: number; synonyms: number } {
        return {
            metrics: this.metrics.size,
            concepts: this.concepts.size,
            patterns: this.patternIndex.size,
            synonyms: this.synonymIndex.size,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

let _instance: MetricDictionary | null = null;

export function getMetricDictionary(): MetricDictionary {
    if (!_instance) {
        _instance = new MetricDictionary();
    }
    return _instance;
}

export function resetMetricDictionary(): void {
    _instance = null;
}
