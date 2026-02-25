/**
 * AI SQL Generator Service
 *
 * Takes a natural language question + dataset column metadata,
 * sends it to OpenRouter API, and returns a valid SQL query.
 *
 * SECURITY: Only column names, types, and a few sample values are sent.
 * NO raw data is ever transmitted to the AI.
 */

import { Dataset, ColumnType } from '../types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';
const MODEL = 'google/gemini-2.0-flash-001';
const TIMEOUT_MS = 25000;

export interface SQLGenerationResult {
    sql: string;
    explanation: string;
    columnsUsed: string[];
    error?: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    sql?: string;
    explanation?: string;
    columnsUsed?: string[];
    timestamp: number;
}

/**
 * Extract column metadata from the dataset.
 * Only names, types, and sample values are extracted. No actual data rows.
 */
export function extractMetadata(dataset: Dataset): string {
    const lines: string[] = [
        `Table: "${dataset.name || 'dataset'}"`,
        `Total rows: ${dataset.rows.length}`,
        '',
        'Columns:',
    ];

    dataset.columns.forEach(col => {
        const typeLabel = col.type === ColumnType.METRIC ? 'NUMERIC'
            : col.type === ColumnType.DATE ? 'DATE'
                : col.type === ColumnType.ID ? 'ID'
                    : 'TEXT';

        const samples = new Set<string>();
        const actualKey = dataset.rows.length > 0
            ? Object.keys(dataset.rows[0]).find(k => k.toLowerCase() === col.name.toLowerCase()) || col.name
            : col.name;
        for (let i = 0; i < Math.min(dataset.rows.length, 200) && samples.size < 5; i++) {
            const val = dataset.rows[i][actualKey];
            if (val !== null && val !== undefined && val !== '') {
                samples.add(String(val).substring(0, 50));
            }
        }

        lines.push(`  - ${col.name} (${typeLabel}) — samples: [${Array.from(samples).map(s => `"${s}"`).join(', ')}]`);
    });

    return lines.join('\n');
}

function buildSystemPrompt(metadata: string): string {
    return `You are an expert SQL query generator. You have access to a single table with the following schema:

${metadata}

RULES:
1. Generate ONLY standard SQL. Use the exact column names provided above.
2. Always use lowercase column names in double quotes if they contain spaces, otherwise use them as-is.
3. Use the table name "data" as the FROM clause.
4. For date operations, assume ISO format (YYYY-MM-DD).
5. Always include meaningful aliases for calculated columns.
6. If the question is ambiguous, make reasonable assumptions and explain them.
7. For "top N" questions, use ORDER BY ... LIMIT N.
8. For percentage calculations, cast to FLOAT to avoid integer division.
9. Do NOT use CTEs unless necessary for clarity.
10. If you cannot answer the question with the available columns, say so clearly.

RESPONSE FORMAT:
You MUST respond with a JSON object in this exact format (no markdown, no code fences):
{
  "sql": "SELECT ... FROM data ...",
  "explanation": "Brief explanation of what this query does and any assumptions made",
  "columns_used": ["col1", "col2"]
}

Respond ONLY with the JSON object, nothing else.`;
}

/**
 * Generate SQL from a natural language question.
 */
export async function generateSQL(
    question: string,
    dataset: Dataset,
    conversationHistory: ChatMessage[] = []
): Promise<SQLGenerationResult> {
    if (!API_KEY) {
        return {
            sql: '',
            explanation: '',
            columnsUsed: [],
            error: 'OpenRouter API key not configured. Add VITE_OPENROUTER_API_KEY to your .env file.'
        };
    }

    const metadata = extractMetadata(dataset);
    const systemPrompt = buildSystemPrompt(metadata);

    const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt }
    ];

    const recentHistory = conversationHistory.slice(-6);
    recentHistory.forEach(msg => {
        if (msg.role === 'user') {
            messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant' && msg.sql) {
            messages.push({
                role: 'assistant',
                content: JSON.stringify({
                    sql: msg.sql,
                    explanation: msg.explanation || '',
                    columns_used: msg.columnsUsed || []
                })
            });
        }
    });

    messages.push({ role: 'user', content: question });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Astrabi Analytics - SQL Generator'
            },
            body: JSON.stringify({
                model: MODEL,
                messages,
                max_tokens: 1000,
                temperature: 0.1
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error('[AI SQL] API error:', response.status, errorText);
            return {
                sql: '',
                explanation: '',
                columnsUsed: [],
                error: `API error (${response.status}). Please try again.`
            };
        }

        const data = await response.json();
        const rawContent = data?.choices?.[0]?.message?.content || '';

        try {
            const cleaned = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return {
                sql: parsed.sql || '',
                explanation: parsed.explanation || '',
                columnsUsed: parsed.columns_used || []
            };
        } catch {
            const sqlMatch = rawContent.match(/SELECT[\s\S]*?(?:;|$)/i);
            return {
                sql: sqlMatch ? sqlMatch[0].trim() : '',
                explanation: rawContent,
                columnsUsed: []
            };
        }
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            return { sql: '', explanation: '', columnsUsed: [], error: 'Request timed out. Please try again.' };
        }
        console.error('[AI SQL] Request failed:', err);
        return { sql: '', explanation: '', columnsUsed: [], error: 'Failed to connect. Check your internet.' };
    }
}
