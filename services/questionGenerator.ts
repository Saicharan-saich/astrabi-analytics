/**
 * questionGenerator.ts — Deterministic Smart Question Engine
 *
 * Generates contextual, executable questions from the SemanticModel + DomainProfile.
 * Rules:
 *   1. Deterministic first — no LLM calls, only pattern matching
 *   2. Every question maps to an executable query
 *   3. Ranked by relevance, coverage, diversity
 *   4. Max 6 primary, rest categorized
 */

import { Dataset, ColumnType } from '../types';
import type { SemanticModel, SemanticMeasure, SemanticDimension } from './semanticModel';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type QuestionCategory = 'trend' | 'comparison' | 'ranking' | 'distribution' | 'overview';

export interface SmartQuestion {
    id: string;
    question: string;
    description: string;
    category: QuestionCategory;
    icon: string;
    priority: number;          // 1-100, higher = more relevant
}

export interface QuestionSet {
    primary: SmartQuestion[];           // Top 6 curated
    categories: {
        trends: SmartQuestion[];
        comparisons: SmartQuestion[];
        rankings: SmartQuestion[];
        distributions: SmartQuestion[];
    };
    generatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function humanize(col: string): string {
    return col
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function qid(cat: string, metric: string, dim: string): string {
    return `${cat}__${metric}__${dim}`.toLowerCase().replace(/\s+/g, '_');
}

// ═══════════════════════════════════════════════════════════════════
// QUESTION GENERATION RULES
// ═══════════════════════════════════════════════════════════════════

function generateTrendQuestions(
    measures: SemanticMeasure[],
    dateColumns: string[],
    domain: string,
): SmartQuestion[] {
    if (dateColumns.length === 0) return [];
    const dateName = humanize(dateColumns[0]);
    const questions: SmartQuestion[] = [];

    for (const m of measures.slice(0, 5)) {
        const metricName = m.label || humanize(m.column);
        const agg = m.aggregation === 'AVG' ? 'average' : 'total';

        questions.push({
            id: qid('trend', m.column, dateColumns[0]),
            question: `How has ${metricName} changed over time?`,
            description: `${agg === 'average' ? 'Average' : 'Total'} ${metricName} trend by ${dateName}`,
            category: 'trend',
            icon: '📈',
            priority: m.column === measures[0]?.column ? 95 : 70,
        });
    }

    return questions;
}

function generateComparisonQuestions(
    measures: SemanticMeasure[],
    dimensions: SemanticDimension[],
    domain: string,
): SmartQuestion[] {
    const questions: SmartQuestion[] = [];
    const usableDims = dimensions.filter(d => d.dataType === 'string').slice(0, 5);

    for (const m of measures.slice(0, 4)) {
        for (const d of usableDims.slice(0, 3)) {
            const metricName = m.label || humanize(m.column);
            const dimName = d.label || humanize(d.column);
            const agg = m.aggregation === 'AVG' ? 'average' : 'total';

            questions.push({
                id: qid('comparison', m.column, d.column),
                question: `Compare ${metricName} across different ${dimName}`,
                description: `${agg === 'average' ? 'Avg' : 'Total'} ${metricName} broken down by ${dimName}`,
                category: 'comparison',
                icon: '📊',
                priority: m.column === measures[0]?.column ? 85 : 60,
            });
        }
    }

    return questions;
}

function generateRankingQuestions(
    measures: SemanticMeasure[],
    dimensions: SemanticDimension[],
    domain: string,
): SmartQuestion[] {
    const questions: SmartQuestion[] = [];
    const usableDims = dimensions.filter(d => d.dataType === 'string').slice(0, 5);

    for (const m of measures.slice(0, 3)) {
        for (const d of usableDims.slice(0, 3)) {
            const metricName = m.label || humanize(m.column);
            const dimName = d.label || humanize(d.column);

            questions.push({
                id: qid('ranking_top', m.column, d.column),
                question: `Top 10 ${dimName} by ${metricName}`,
                description: `Which ${dimName} have the highest ${metricName}`,
                category: 'ranking',
                icon: '🏆',
                priority: m.column === measures[0]?.column ? 80 : 55,
            });

            questions.push({
                id: qid('ranking_bottom', m.column, d.column),
                question: `Bottom 10 ${dimName} by ${metricName}`,
                description: `Which ${dimName} have the lowest ${metricName}`,
                category: 'ranking',
                icon: '📉',
                priority: m.column === measures[0]?.column ? 60 : 40,
            });
        }
    }

    return questions;
}

function generateDistributionQuestions(
    measures: SemanticMeasure[],
    dimensions: SemanticDimension[],
    domain: string,
): SmartQuestion[] {
    const questions: SmartQuestion[] = [];
    const usableDims = dimensions.filter(d => d.dataType === 'string').slice(0, 5);

    // Count-based grouped by dimension
    for (const d of usableDims.slice(0, 4)) {
        const dimName = d.label || humanize(d.column);
        questions.push({
            id: qid('dist_count', 'count', d.column),
            question: `How many records per ${dimName}?`,
            description: `Distribution of records across ${dimName} categories`,
            category: 'distribution',
            icon: '🔢',
            priority: 65,
        });
    }

    // Metric distribution
    for (const m of measures.slice(0, 3)) {
        const metricName = m.label || humanize(m.column);
        questions.push({
            id: qid('dist_metric', m.column, 'all'),
            question: `What is the distribution of ${metricName}?`,
            description: `Statistical spread and range of ${metricName}`,
            category: 'distribution',
            icon: '📐',
            priority: 50,
        });
    }

    return questions;
}

function generateOverviewQuestions(
    measures: SemanticMeasure[],
    dimensions: SemanticDimension[],
    dateColumns: string[],
    domain: string,
    grain: string | null,
    totalRows: number,
): SmartQuestion[] {
    const questions: SmartQuestion[] = [];

    if (measures.length > 0) {
        const primaryMetric = measures[0].label || humanize(measures[0].column);
        questions.push({
            id: qid('overview', 'summary', 'all'),
            question: `Give me an overall summary of ${primaryMetric}`,
            description: `Key statistics: total, average, min, max`,
            category: 'overview',
            icon: '📋',
            priority: 90,
        });
    }

    if (measures.length >= 2 && dimensions.length > 0) {
        const dim = dimensions[0].label || humanize(dimensions[0].column);
        questions.push({
            id: qid('overview', 'multi', dimensions[0].column),
            question: `Compare all key metrics by ${dim}`,
            description: `Side-by-side view of ${measures.slice(0, 3).map(m => m.label || humanize(m.column)).join(', ')}`,
            category: 'overview',
            icon: '🔍',
            priority: 75,
        });
    }

    return questions;
}

// ═══════════════════════════════════════════════════════════════════
// DEDUPLICATION + SCORING
// ═══════════════════════════════════════════════════════════════════

function deduplicate(questions: SmartQuestion[]): SmartQuestion[] {
    const seen = new Set<string>();
    return questions.filter(q => {
        if (seen.has(q.id)) return false;
        seen.add(q.id);
        return true;
    });
}

function diversityBoost(questions: SmartQuestion[]): SmartQuestion[] {
    // Increase scores for questions that cover unique categories
    const catCounts: Record<string, number> = {};
    for (const q of questions) {
        catCounts[q.category] = (catCounts[q.category] || 0) + 1;
    }
    return questions.map(q => ({
        ...q,
        priority: q.priority + (catCounts[q.category] === 1 ? 10 : 0),
    }));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

const questionCache = new Map<string, QuestionSet>();

export function generateQuestions(dataset: Dataset): QuestionSet {
    const cacheKey = `${dataset.id}_${dataset.version || 0}`;
    const cached = questionCache.get(cacheKey);
    if (cached) return cached;

    const model = dataset.semanticModel;
    const profile = dataset.domainProfile;
    const domain = profile?.domain || 'General';
    const grain = model?.grain || profile?.grain || null;

    // Get measures and dimensions from semantic model, or fallback to column defs
    let measures: SemanticMeasure[] = model?.measures || [];
    let dimensions: SemanticDimension[] = model?.dimensions || [];
    let dateColumns: string[] = model?.dateColumns || [];

    // Fallback if no semantic model: use column types
    if (measures.length === 0 && dimensions.length === 0) {
        const cols = dataset.columns || [];
        measures = cols
            .filter(c => c.type === ColumnType.METRIC)
            .map(c => ({
                name: c.name,
                column: c.name,
                aggregation: 'SUM' as any,
                behavior: 'ADDITIVE' as any,
                format: 'raw' as any,
                requiresWeighting: false,
                isHidden: false,
            }));
        dimensions = cols
            .filter(c => c.type === ColumnType.DIMENSION)
            .map(c => ({
                name: c.name,
                column: c.name,
                dataType: 'string' as any,
                isHidden: false,
            }));
        dateColumns = cols
            .filter(c => c.type === ColumnType.DATE)
            .map(c => c.name);
    }

    // Edge case: 50+ columns — only use top items
    if (measures.length > 8) measures = measures.slice(0, 8);
    if (dimensions.length > 8) dimensions = dimensions.slice(0, 8);

    // Generate all question types
    let allQuestions: SmartQuestion[] = [
        ...generateOverviewQuestions(measures, dimensions, dateColumns, domain, grain, dataset.totalRows),
        ...generateTrendQuestions(measures, dateColumns, domain),
        ...generateComparisonQuestions(measures, dimensions, domain),
        ...generateRankingQuestions(measures, dimensions, domain),
        ...generateDistributionQuestions(measures, dimensions, domain),
    ];

    // Edge case: no metrics at all — generate count-based questions
    if (measures.length === 0 && dimensions.length > 0) {
        for (const d of dimensions.slice(0, 4)) {
            const dimName = d.label || humanize(d.column);
            allQuestions.push({
                id: qid('count', 'count', d.column),
                question: `Count of records by ${dimName}`,
                description: `How many records exist in each ${dimName} category`,
                category: 'distribution',
                icon: '🔢',
                priority: 80,
            });
        }
    }

    // Edge case: only 1 column
    if (dataset.columns.length === 1) {
        const col = dataset.columns[0];
        allQuestions = [{
            id: 'single_col_dist',
            question: `Distribution of ${humanize(col.name)}`,
            description: `Value breakdown for the only column in this dataset`,
            category: 'distribution',
            icon: '📐',
            priority: 100,
        }];
    }

    // Dedup + diversity + sort
    allQuestions = deduplicate(allQuestions);
    allQuestions = diversityBoost(allQuestions);
    allQuestions.sort((a, b) => b.priority - a.priority);

    // Split: top 6 → primary, rest → categorized
    const primary = allQuestions.slice(0, 6);
    const rest = allQuestions.slice(6);

    const result: QuestionSet = {
        primary,
        categories: {
            trends: rest.filter(q => q.category === 'trend'),
            comparisons: rest.filter(q => q.category === 'comparison'),
            rankings: rest.filter(q => q.category === 'ranking'),
            distributions: rest.filter(q => q.category === 'distribution'),
        },
        generatedAt: Date.now(),
    };

    questionCache.set(cacheKey, result);
    return result;
}

export function clearQuestionCache(): void {
    questionCache.clear();
}
