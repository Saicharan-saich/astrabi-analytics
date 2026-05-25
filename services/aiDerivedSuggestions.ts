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
}

/**
 * Generate AI-powered derived column suggestions from dataset metadata.
 * Sends ONLY column names, types, and sample values — never full data.
 */
export async function getAIDerivedSuggestions(dataset: Dataset): Promise<DerivedColumnSuggestion[]> {
    const columnMeta = dataset.columns.map(col => {
        // Get 3 sample values for context
        const samples = dataset.data
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

        // Validate each suggestion references real columns
        const colNames = new Set(dataset.columns.map(c => c.name));
        const valid = suggestions.filter(s =>
            s.id && s.label && s.formula && s.columnA && s.columnB &&
            colNames.has(s.columnA) && colNames.has(s.columnB) &&
            ['multiply', 'subtract', 'divide', 'add'].includes(s.formula) &&
            typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 100
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

/**
 * Compute a derived column value for a single row.
 */
export function computeDerivedColumn(
    row: Record<string, any>,
    suggestion: DerivedColumnSuggestion
): number | null {
    const a = Number(row[suggestion.columnA]);
    const b = Number(row[suggestion.columnB]);
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
