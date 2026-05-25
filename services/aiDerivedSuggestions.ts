/**
 * aiDerivedSuggestions.ts — AI-Powered Derived Column Suggestion Engine
 *
 * Sends dataset column metadata (names, types, semantic roles, sample values)
 * to AI and receives suggested derived columns with formulas.
 *
 * NO raw data is sent — only schema metadata.
 */

import { Dataset, ColumnType } from '../types';
import { fetchWithFallback } from './ai-sql/modelConfig';

export interface DerivedColumnSuggestion {
    id: string;
    label: string;
    description: string;
    formula: 'multiply' | 'subtract' | 'divide' | 'add';
    columnA: string;
    columnB: string;
    multiplier?: number;   // e.g. 100 for percentages
    category: 'financial' | 'unit_economics' | 'time_intelligence' | 'segmentation' | 'custom';
    confidence: number;    // 0-100
    format: 'currency' | 'percent' | 'number' | 'integer';
    preview?: string;      // e.g. "unit_price × quantity"
    /** Multi-term expression (optional — overrides columnA/B/formula when present) */
    expression?: ExpressionTerm[];
}

/** A single term in a multi-column expression chain */
export interface ExpressionTerm {
    column: string;
    operator?: 'multiply' | 'subtract' | 'divide' | 'add'; // operator AFTER this term
}

/**
 * Generate AI-powered derived column suggestions from dataset metadata.
 * Sends ONLY column names, types, and sample values — never full data.
 */
export async function getAIDerivedSuggestions(dataset: Dataset): Promise<DerivedColumnSuggestion[]> {
    const columnMeta = dataset.columns.map(col => {
        // Get 3 sample values for context
        const samples = (dataset.rows || [])
            .slice(0, 5)
            .map(row => row[col.name])
            .filter(v => v !== null && v !== undefined)
            .slice(0, 3);

        return {
            name: col.name,
            type: col.type,
            semanticRole: col.semanticRole || 'unknown',
            sampleValues: samples,
        };
    });

    const prompt = `You are a business analytics expert. Given this dataset schema, suggest derived columns that would be valuable for analysis.

DATASET COLUMNS:
${columnMeta.map(c => `- "${c.name}" (type: ${c.type}, role: ${c.semanticRole}, samples: ${JSON.stringify(c.sampleValues)})`).join('\n')}

RULES:
1. Only suggest columns that can be computed from EXISTING columns using simple math: add, subtract, multiply, divide
2. Each suggestion must reference exactly TWO existing columns (columnA and columnB)
3. Prioritize high-value business metrics (revenue, profit, margins, unit economics)
4. Include a confidence score (0-100) based on how certain you are the derivation is correct
5. Do NOT suggest columns that already exist in the dataset
6. Maximum 8 suggestions, ordered by confidence (highest first)

RESPOND WITH ONLY a valid JSON array. Each element must have exactly these fields:
{
  "id": "snake_case_id",
  "label": "Human Readable Label",
  "description": "One sentence explaining business value",
  "formula": "multiply" | "subtract" | "divide" | "add",
  "columnA": "exact_column_name_from_dataset",
  "columnB": "exact_column_name_from_dataset",
  "multiplier": null or number (e.g. 100 for percentages),
  "category": "financial" | "unit_economics" | "time_intelligence" | "segmentation",
  "confidence": 0-100,
  "format": "currency" | "percent" | "number" | "integer",
  "preview": "columnA × columnB"
}

Return ONLY the JSON array, no markdown, no explanation.`;

    try {
        const { data } = await fetchWithFallback(
            [
                { role: 'system', content: 'You are a business analytics expert. Respond with ONLY valid JSON arrays.' },
                { role: 'user', content: prompt }
            ],
            { temperature: 0.0, max_tokens: 2000, timeout: 20000 }
        );

        const text = (data.choices?.[0]?.message?.content || '').trim();

        // Parse JSON — strip markdown fences if present
        const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const suggestions: DerivedColumnSuggestion[] = JSON.parse(jsonStr);

        // Build lookup set for column names
        const colNames = new Set(dataset.columns.map(c => c.name));

        // Validate each suggestion — structural + semantic
        const valid = suggestions.filter(s =>
            s.id && s.label && s.formula && s.columnA && s.columnB &&
            colNames.has(s.columnA) && colNames.has(s.columnB) &&
            ['multiply', 'subtract', 'divide', 'add'].includes(s.formula) &&
            typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 100 &&
            validateDerivedColumn(s, dataset).valid
        );

        return valid.map(s => ({
            ...s,
            preview: s.preview || `${s.columnA} ${s.formula === 'multiply' ? '×' : s.formula === 'subtract' ? '−' : s.formula === 'divide' ? '÷' : '+'} ${s.columnB}`,
        }));
    } catch (err) {
        console.error('[DerivedSuggestions] AI call failed:', err);
        return [];
    }
}

// ── Semantic Validation ──────────────────────────────────────────

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Validate a derived column suggestion against semantic rules.
 *
 * Rejects:
 *   - ID columns in formulas (unit_price × customer_id = nonsense)
 *   - Non-numeric columns in math operations
 *   - Division where denominator is likely zero
 *   - Same column on both sides (a - a = always 0)
 */
export function validateDerivedColumn(
    suggestion: DerivedColumnSuggestion,
    dataset: Dataset
): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const colA = dataset.columns.find(c => c.name === suggestion.columnA);
    const colB = dataset.columns.find(c => c.name === suggestion.columnB);

    if (!colA || !colB) {
        errors.push(`Column not found: ${!colA ? suggestion.columnA : suggestion.columnB}`);
        return { valid: false, errors, warnings };
    }

    // ── Rule 1: Reject ID columns in math operations ──
    const idTypes = [ColumnType.ID];
    const idRoles = ['identifier', 'id', 'primary_key', 'foreign_key'];

    if (idTypes.includes(colA.type as any) || idRoles.includes(String(colA.semanticRole || '').toLowerCase())) {
        errors.push(`"${colA.name}" is an identifier — math on IDs is semantically invalid`);
    }
    if (idTypes.includes(colB.type as any) || idRoles.includes(String(colB.semanticRole || '').toLowerCase())) {
        errors.push(`"${colB.name}" is an identifier — math on IDs is semantically invalid`);
    }

    // ── Rule 2: Reject non-numeric columns ──
    const nonNumericTypes = [ColumnType.DIMENSION, ColumnType.DATE, ColumnType.TEXT];
    const isNumericCol = (col: any) => {
        if ([ColumnType.MEASURE, ColumnType.METRIC].includes(col.type)) return true;
        // Check sample data for numeric content
        const samples = (dataset.rows || []).slice(0, 10).map(r => r[col.name]).filter(v => v != null);
        return samples.length > 0 && samples.every(v => !isNaN(Number(String(v).replace(/[$,]/g, ''))));
    };

    if (!isNumericCol(colA)) {
        errors.push(`"${colA.name}" does not contain numeric values — cannot use in formula`);
    }
    if (!isNumericCol(colB)) {
        errors.push(`"${colB.name}" does not contain numeric values — cannot use in formula`);
    }

    // ── Rule 3: Same column on both sides ──
    if (suggestion.columnA === suggestion.columnB && suggestion.formula === 'subtract') {
        errors.push(`"${colA.name}" − "${colB.name}" will always equal zero`);
    }
    if (suggestion.columnA === suggestion.columnB && suggestion.formula === 'divide') {
        warnings.push(`"${colA.name}" ÷ "${colB.name}" will always equal 1`);
    }

    // ── Rule 4: Division by column that contains zeros ──
    if (suggestion.formula === 'divide') {
        const zeros = (dataset.rows || []).slice(0, 100).filter(r => {
            const v = Number(r[suggestion.columnB]);
            return v === 0;
        }).length;
        if (zeros > 10) {
            warnings.push(`"${colB.name}" has many zero values — division will produce nulls`);
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Robust number parser — handles formatted values like "$1,234.56", "45%", "  123 "
 */
function parseNumber(raw: any): number {
    if (raw === null || raw === undefined) return NaN;
    if (typeof raw === 'number') return raw;
    const cleaned = String(raw).replace(/[$€£¥,\s%]/g, '').trim();
    if (cleaned === '') return NaN;
    return Number(cleaned);
}

/**
 * Compute a derived column value for a single row.
 * Supports both simple 2-column formulas and multi-term expressions.
 * Multi-term expressions use standard math precedence (× ÷ before + −).
 */
export function computeDerivedColumn(
    row: Record<string, any>,
    suggestion: DerivedColumnSuggestion
): number | null {
    // Multi-term expression path
    if (suggestion.expression && suggestion.expression.length >= 2) {
        return computeExpression(row, suggestion.expression);
    }

    // Simple 2-column path
    const a = parseNumber(row[suggestion.columnA]);
    const b = parseNumber(row[suggestion.columnB]);
    if (isNaN(a) || isNaN(b)) return null;

    let result: number;
    switch (suggestion.formula) {
        case 'multiply': result = a * b; break;
        case 'subtract': result = a - b; break;
        case 'divide': if (b === 0) return null; result = a / b; break;
        case 'add': result = a + b; break;
        default: return null;
    }

    if (suggestion.multiplier) result *= suggestion.multiplier;
    return result;
}

/**
 * Evaluate a multi-term expression with standard math precedence.
 * Example: [price, ×, qty, −, cost, ×, qty]
 * First pass: resolve × and ÷ → [price*qty, −, cost*qty]
 * Second pass: resolve + and − → price*qty - cost*qty
 */
export function computeExpression(
    row: Record<string, any>,
    terms: ExpressionTerm[]
): number | null {
    if (terms.length === 0) return null;

    // Build values and operators arrays
    const values: number[] = [];
    const operators: string[] = [];

    for (const term of terms) {
        const val = parseNumber(row[term.column]);
        if (isNaN(val)) return null;
        values.push(val);
        if (term.operator) operators.push(term.operator);
    }

    // Pass 1: resolve multiply and divide (higher precedence)
    const addValues: number[] = [values[0]];
    const addOps: string[] = [];

    for (let i = 0; i < operators.length; i++) {
        const op = operators[i];
        if (op === 'multiply' || op === 'divide') {
            const left = addValues.pop()!;
            const right = values[i + 1];
            if (op === 'divide' && right === 0) return null;
            addValues.push(op === 'multiply' ? left * right : left / right);
        } else {
            addValues.push(values[i + 1]);
            addOps.push(op);
        }
    }

    // Pass 2: resolve add and subtract (lower precedence)
    let result = addValues[0];
    for (let i = 0; i < addOps.length; i++) {
        result = addOps[i] === 'add' ? result + addValues[i + 1] : result - addValues[i + 1];
    }

    return result;
}

/**
 * Materialize accepted derived columns into the dataset rows.
 * Returns new array of rows with derived columns added.
 */
export function materializeDerivedColumns(
    rows: Record<string, any>[],
    accepted: DerivedColumnSuggestion[]
): Record<string, any>[] {
    if (accepted.length === 0) return rows;

    return rows.map(row => {
        const enriched = { ...row };
        for (const col of accepted) {
            enriched[col.id] = computeDerivedColumn(row, col);
        }
        return enriched;
    });
}

// ── Semantic Registry Integration ────────────────────────────────

import type { SemanticModel, SemanticMeasure, MetricBehavior } from './semanticModel';

/**
 * Register derived columns as first-class SemanticMeasures in the model.
 * After this call, AI SQL, QueryPlan, Question Builder, and Alerts
 * all understand the derived column's type, aggregation, and format.
 *
 * Infers:
 *   - behavior: multiply/add → additive; divide → non_additive
 *   - aggregation: additive → SUM; non_additive → AVG
 *   - format: from suggestion.format → currency_usd | percent | raw
 */
export function registerDerivedInSemanticModel(
    model: SemanticModel,
    accepted: DerivedColumnSuggestion[]
): SemanticModel {
    if (accepted.length === 0) return model;

    const existingCols = new Set(model.measures.map(m => m.column));
    const newMeasures: SemanticMeasure[] = [];

    for (const col of accepted) {
        if (existingCols.has(col.id)) continue; // already registered

        // Infer behavior from formula type
        const behavior: MetricBehavior =
            col.formula === 'divide' ? 'non_additive' :
            col.formula === 'multiply' && col.multiplier ? 'non_additive' : // percentage-like
            'additive';

        // Infer aggregation from behavior
        const aggregation = behavior === 'additive' ? 'SUM' as any : 'AVG' as any;

        // Map format
        const format =
            col.format === 'currency' ? 'currency_usd' as const :
            col.format === 'percent' ? 'percent' as const :
            'raw' as const;

        newMeasures.push({
            name: col.label,
            column: col.id,
            aggregation,
            behavior,
            format,
            requiresWeighting: behavior === 'non_additive',
            weightColumn: behavior === 'non_additive' ? col.columnB : undefined,
            label: col.label,
            isHidden: false,
        });
    }

    return {
        ...model,
        measures: [...model.measures, ...newMeasures],
        version: model.version + 1,
        builtAt: Date.now(),
    };
}

