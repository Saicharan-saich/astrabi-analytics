/**
 * questionGenerator.ts — AI-Powered Smart Question Engine
 *
 * Generates contextual, executable questions by sending the FULL dataset
 * profile (all columns, domain, semantic model, sample data) to Gemini AI.
 *
 * Fallback: If AI is unavailable, generates basic deterministic questions.
 */

import { Dataset, ColumnDefinition, ColumnType } from '../types';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type QuestionCategory = 'trend' | 'comparison' | 'ranking' | 'distribution' | 'overview' | 'correlation';

export interface SmartQuestion {
    id: string;
    question: string;
    description: string;
    category: QuestionCategory;
    icon: string;
    priority: number;
}

export interface QuestionSet {
    primary: SmartQuestion[];
    categories: {
        trends: SmartQuestion[];
        comparisons: SmartQuestion[];
        rankings: SmartQuestion[];
        distributions: SmartQuestion[];
    };
    generatedAt: number;
    source: 'ai' | 'fallback';
}

// ═══════════════════════════════════════════════════════════════════
// AI QUESTION GENERATION
// ═══════════════════════════════════════════════════════════════════

const API_ENDPOINT = `${import.meta.env.VITE_API_URL || 'http://localhost:5002/api'}/ai/profile-dataset`;
const TIMEOUT_MS = 20000;

/**
 * Builds a comprehensive prompt using ONLY METADATA — column names, types,
 * roles, and descriptions. ZERO raw data values are sent to the AI.
 * This preserves user data privacy and security.
 */
function buildQuestionPrompt(dataset: Dataset): string {
    const domain = dataset.domainProfile?.domain || 'General';
    const subDomain = dataset.domainProfile?.subDomain || '';
    const summary = dataset.domainProfile?.summary || '';
    const grain = dataset.domainProfile?.grain || dataset.semanticModel?.grain || '';

    // Build column profile from METADATA ONLY — no raw data
    const columnProfiles = dataset.columns.map(col => {
        const semantic = dataset.domainProfile?.columnSemantics?.[col.name];
        const smMeasure = dataset.semanticModel?.measures?.find(m => m.column === col.name);
        const smDimension = dataset.semanticModel?.dimensions?.find(d => d.column === col.name);

        const parts = [
            `  - ${col.name}`,
            `    Type: ${col.type}`,
        ];

        if (semantic) {
            parts.push(`    Role: ${semantic.role}`);
            parts.push(`    Label: ${semantic.humanLabel || col.name}`);
            if (semantic.description) parts.push(`    Description: ${semantic.description}`);
            if (semantic.aggregation && semantic.aggregation !== 'NONE') parts.push(`    Default Aggregation: ${semantic.aggregation}`);
            if (semantic.semanticRole) parts.push(`    Semantic Role: ${semantic.semanticRole}`);
        } else if (smMeasure) {
            parts.push(`    Role: METRIC`);
            parts.push(`    Aggregation: ${smMeasure.aggregation}`);
            parts.push(`    Label: ${smMeasure.label || col.name}`);
        } else if (smDimension) {
            parts.push(`    Role: DIMENSION`);
            parts.push(`    Label: ${smDimension.label || col.name}`);
        }

        // NO raw data values are sent — only metadata above

        return parts.join('\n');
    }).join('\n');

    // Measures and dimensions from semantic model
    const measures = dataset.semanticModel?.measures?.map(m => `${m.label || m.column} (${m.aggregation})`).join(', ') || 'None identified';
    const dimensions = dataset.semanticModel?.dimensions?.map(d => d.label || d.column).join(', ') || 'None identified';
    const dateColumns = dataset.semanticModel?.dateColumns?.join(', ') || 'None identified';

    return `You are an expert Business Analyst. A user uploaded a dataset and wants to explore it.

DATASET OVERVIEW:
- Name: ${dataset.name}
- Domain: ${domain}${subDomain ? ` (${subDomain})` : ''}
- Summary: ${summary || 'N/A'}
- Total Rows: ${dataset.totalRows.toLocaleString()}
- Total Columns: ${dataset.columns.length}
- Grain: 1 row = 1 ${grain || 'record'}

KEY FIELDS:
- Measures (metrics for aggregation): ${measures}
- Dimensions (for grouping/filtering): ${dimensions}
- Date Columns: ${dateColumns}

ALL COLUMNS WITH PROFILES:
${columnProfiles}

YOUR TASK:
Generate 15-20 insightful, actionable analytical questions that a business user would want to ask about this dataset. The questions must:

1. Consider the ENTIRE dataset — use multiple columns, not just one
2. Be natural-language questions that can be answered with SQL queries and charts
3. Cover different analytical categories:
   - "trend": Time-based analysis (only if date columns exist)
   - "comparison": Comparing metrics across different groups/categories
   - "ranking": Top/bottom N analysis
   - "distribution": How values are spread, count breakdowns
   - "overview": Summary statistics, overall KPIs
   - "correlation": Relationships between two or more columns
4. Be specific to this dataset's domain (${domain}) — use actual column names and context
5. Range from simple (1 column) to complex (multi-column analysis)
6. Use the human-readable labels, not raw column names, in the question text

RESPOND WITH ONLY VALID JSON (no markdown fences):
{
  "questions": [
    {
      "question": "What is the average billing amount by medical condition?",
      "description": "Compare average billing across different diagnoses to identify costly conditions",
      "category": "comparison",
      "icon": "📊",
      "priority": 95
    }
  ]
}

RULES:
- priority: 1-100 score, higher = more relevant/valuable to a business user
- Pick the TOP 6 questions as highest priority (90-100)
- icon: use relevant emoji (📈 trend, 📊 comparison, 🏆 ranking, 🔢 distribution, 📋 overview, 🔗 correlation)
- Questions must be self-contained and executable as natural language queries
- Do NOT generate generic questions — make them SPECIFIC to the columns and domain
- NEVER use ID columns (patient_id, order_id, room_number, etc.) as metrics — these are identifiers, not measurable values
- NEVER ask "how has [ID column] changed over time" — IDs don't trend, they identify records
- NEVER ask "compare [ID column] across [dimension]" — IDs are not meaningful to aggregate
- Only use ACTUAL business metrics (revenue, cost, billing_amount, quantity, age, duration, etc.) in trend/comparison/ranking questions
- Dimensions for grouping should be categorical (gender, region, department, category, status) — NOT IDs or dates
- If a column name contains 'id', 'key', 'code', 'number', 'no', 'num' and it looks like an identifier, EXCLUDE it from metrics`;
}

/**
 * Call the AI backend to generate questions
 */
async function callAIForQuestions(prompt: string): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`AI API returned ${response.status}`);
        }

        const data = await response.json();
        return data;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.info('[SmartQ] AI call timed out — using fallback.');
        } else {
            console.info('[SmartQ] AI unavailable — using fallback.', err.message);
        }
        return null;
    }
}

/**
 * Parse AI response into SmartQuestion[]
 */
function parseAIResponse(raw: any): SmartQuestion[] | null {
    try {
        let parsed = raw;

        // Handle string responses (may be wrapped in markdown fences)
        if (typeof parsed === 'string') {
            parsed = parsed.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            parsed = JSON.parse(parsed);
        }

        // Handle { result: "..." } wrapper from backend
        if (parsed?.result && typeof parsed.result === 'string') {
            let clean = parsed.result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            parsed = JSON.parse(clean);
        }

        const questions = parsed?.questions;
        if (!Array.isArray(questions) || questions.length === 0) return null;

        return questions.map((q: any, i: number) => ({
            id: `ai_q_${i}_${Date.now()}`,
            question: String(q.question || ''),
            description: String(q.description || ''),
            category: (['trend', 'comparison', 'ranking', 'distribution', 'overview', 'correlation'].includes(q.category) ? q.category : 'overview') as QuestionCategory,
            icon: String(q.icon || '📊'),
            priority: typeof q.priority === 'number' ? q.priority : (100 - i * 5),
        })).filter(q => q.question.length > 5);
    } catch (err) {
        console.error('[SmartQ] Failed to parse AI response:', err);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════
// DETERMINISTIC FALLBACK (used when AI is unavailable)
// ═══════════════════════════════════════════════════════════════════

function humanize(col: string): string {
    return col.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
}

function generateFallbackQuestions(dataset: Dataset): SmartQuestion[] {
    const questions: SmartQuestion[] = [];
    const cols = dataset.columns || [];
    const semantics = dataset.domainProfile?.columnSemantics || {};
    const model = dataset.semanticModel;

    // ── Identifier detection: columns that should NEVER be treated as metrics ──
    const ID_PATTERNS = /^(id|_id|patient_id|user_id|order_id|record_id|row_id|transaction_id|case_id|room_number|room_no|room_num|bed_number|serial|serial_no|index|row_num)/i;
    const ID_SUFFIX_PATTERNS = /_id$|_key$|_code$|_no$|_num$/i;

    function isIdentifierColumn(col: ColumnDefinition): boolean {
        // Explicitly typed as ID
        if (col.type === ColumnType.ID) return true;
        // Semantic role is identifier
        const sem = semantics[col.name];
        if (sem?.role === 'ID' || sem?.semanticRole === 'identifier' || sem?.semanticRole === 'primary_key' || sem?.semanticRole === 'foreign_key') return true;
        // Semantic model marks it
        const smMeasure = model?.measures?.find(m => m.column === col.name);
        if (smMeasure?.semanticRole === 'identifier') return true;
        // Name-based heuristic
        const name = col.name.toLowerCase();
        if (ID_PATTERNS.test(name)) return true;
        if (ID_SUFFIX_PATTERNS.test(name)) return true;
        // "Number" in name but only has integer-like unique values → likely an ID
        if (/number|num|no\b/i.test(name) && col.type === ColumnType.METRIC) {
            // Heuristic: if a "number" column has high cardinality relative to rows, it's an ID
            const uniqueValues = new Set(dataset.rows?.slice(0, 200).map(r => r[col.name])).size;
            if (uniqueValues > (dataset.rows?.slice(0, 200).length || 200) * 0.8) return true;
        }
        return false;
    }

    // Gather REAL metrics and dimensions (excluding identifiers)
    const metrics: { name: string; label: string; agg: string }[] = [];
    const dimensions: { name: string; label: string }[] = [];
    const dates: string[] = model?.dateColumns || [];

    for (const col of cols) {
        // Skip identifiers entirely
        if (isIdentifierColumn(col)) continue;

        const sem = semantics[col.name];
        const smMeasure = model?.measures?.find(m => m.column === col.name);
        const smDim = model?.dimensions?.find(d => d.column === col.name);

        if (col.type === ColumnType.METRIC || sem?.role === 'METRIC' || smMeasure) {
            metrics.push({
                name: col.name,
                label: sem?.humanLabel || smMeasure?.label || humanize(col.name),
                agg: sem?.aggregation || smMeasure?.aggregation || 'SUM',
            });
        } else if (col.type === ColumnType.DIMENSION || col.type === ColumnType.BOOLEAN || sem?.role === 'DIMENSION' || smDim) {
            dimensions.push({
                name: col.name,
                label: sem?.humanLabel || smDim?.label || humanize(col.name),
            });
        } else if (col.type === ColumnType.DATE || sem?.role === 'DATE') {
            if (!dates.includes(col.name)) dates.push(col.name);
        }
    }

    let priority = 95;
    const domain = (dataset.domainProfile?.domain || '').toLowerCase();

    // ── Overview ──
    if (metrics.length > 0) {
        questions.push({
            id: 'fb_overview',
            question: `Give me an overall summary of key metrics`,
            description: `Summary statistics for ${metrics.slice(0, 4).map(m => m.label).join(', ')}`,
            category: 'overview',
            icon: '📋',
            priority: priority--,
        });
    }

    // ── Trends (each metric × first date) ──
    if (dates.length > 0) {
        const dateLabel = humanize(dates[0]);
        for (const m of metrics.slice(0, 3)) {
            questions.push({
                id: `fb_trend_${m.name}`,
                question: `How has ${m.label} changed over time?`,
                description: `${m.agg === 'AVG' ? 'Average' : 'Total'} ${m.label} trend by ${dateLabel}`,
                category: 'trend',
                icon: '📈',
                priority: priority--,
            });
        }
    }

    // ── Comparisons (metric × dimension — meaningful pairs) ──
    for (const m of metrics.slice(0, 3)) {
        for (const d of dimensions.slice(0, 3)) {
            questions.push({
                id: `fb_comp_${m.name}_${d.name}`,
                question: `What is the ${m.agg === 'AVG' ? 'average' : 'total'} ${m.label} by ${d.label}?`,
                description: `${m.label} broken down by ${d.label}`,
                category: 'comparison',
                icon: '📊',
                priority: priority--,
            });
        }
    }

    // ── Rankings ──
    for (const m of metrics.slice(0, 2)) {
        for (const d of dimensions.slice(0, 2)) {
            questions.push({
                id: `fb_rank_${m.name}_${d.name}`,
                question: `Top 10 ${d.label} by ${m.label}`,
                description: `Which ${d.label} values have the highest ${m.label}`,
                category: 'ranking',
                icon: '🏆',
                priority: priority--,
            });
        }
    }

    // ── Distributions ──
    for (const d of dimensions.slice(0, 4)) {
        questions.push({
            id: `fb_dist_${d.name}`,
            question: `How are records distributed across ${d.label}?`,
            description: `Count of records per ${d.label} category`,
            category: 'distribution',
            icon: '🔢',
            priority: priority--,
        });
    }

    // ── Metric distribution (histogram-style) ──
    for (const m of metrics.slice(0, 2)) {
        questions.push({
            id: `fb_metric_dist_${m.name}`,
            question: `What is the distribution of ${m.label}?`,
            description: `Histogram showing how ${m.label} values are spread`,
            category: 'distribution',
            icon: '📊',
            priority: priority--,
        });
    }

    return questions;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

const questionCache = new Map<string, QuestionSet>();

/**
 * Generate smart questions for a dataset using AI.
 * Returns cached results if available for the same dataset version.
 */
export async function generateQuestions(dataset: Dataset): Promise<QuestionSet> {
    const cacheKey = `${dataset.id}_${dataset.version || 0}`;
    const cached = questionCache.get(cacheKey);
    if (cached) return cached;

    // Try AI-powered generation first
    console.log('[SmartQ] Generating AI-powered questions for', dataset.name);
    const prompt = buildQuestionPrompt(dataset);
    const aiResponse = await callAIForQuestions(prompt);
    const aiQuestions = aiResponse ? parseAIResponse(aiResponse) : null;

    let allQuestions: SmartQuestion[];
    let source: 'ai' | 'fallback';

    if (aiQuestions && aiQuestions.length >= 5) {
        console.log(`[SmartQ] AI generated ${aiQuestions.length} questions`);
        allQuestions = aiQuestions;
        source = 'ai';
    } else {
        console.log('[SmartQ] Using fallback question generation');
        allQuestions = generateFallbackQuestions(dataset);
        source = 'fallback';
    }

    // Sort by priority
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
            distributions: rest.filter(q => q.category === 'distribution' || q.category === 'overview' || q.category === 'correlation'),
        },
        generatedAt: Date.now(),
        source,
    };

    questionCache.set(cacheKey, result);
    return result;
}

export function clearQuestionCache(): void {
    questionCache.clear();
}
