/**
 * Token cost is independent of dataset size, and no raw rows reach the LLM.
 *
 * The only LLM step in answering a question is the intent planner, whose prompt
 * is the serialized SEMANTIC MODEL (column metadata) — never the rows. So the
 * token cost of a question scales with the number of COLUMNS + the question,
 * not with the number of ROWS. This test proves both: (a) the planner prompt is
 * near-constant length as rows grow 100×, and (b) a unique cell value never
 * appears in the prompt.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { serializeSemanticModel } from '../services/ai-sql/semanticLayer';

const SENTINEL = 'Zzsentinelvalue Uniqueperson';

function patients(n: number) {
    const dept = ['Cardiology', 'Oncology', 'Neurology'];
    return Array.from({ length: n }, (_, i) => ({
        patient_id: 1000 + i,
        // Row 5 carries a unique sentinel; every other row is ordinary.
        name: i === 5 ? SENTINEL : `Person ${i % 50}`,
        gender: i % 2 ? 'Male' : 'Female',
        department: dept[i % 3],
        admission_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-05`,
        billing_amount: 500 + (i * 37) % 40000,
    }));
}

function serializedPromptFor(n: number): string {
    const etl = runETLPipeline(patients(n), 'p.csv');
    const model = buildSemanticModel({
        id: 't', name: 'patients', rows: etl.rows, columns: etl.columns,
        totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext,
    } as any);
    return serializeSemanticModel(model);
}

describe('LLM token cost — independent of dataset size', () => {
    it('planner prompt length is near-constant as rows grow 100×', () => {
        const small = serializedPromptFor(300);
        const large = serializedPromptFor(30000);
        // 100× the rows must NOT mean ~100× the prompt. It should be within a few
        // percent (only distinct-count/range/rowCount digits differ).
        const ratio = large.length / small.length;
        expect(ratio).toBeGreaterThan(0.85);
        expect(ratio).toBeLessThan(1.15);
        // And the absolute growth is a handful of characters, not thousands.
        expect(Math.abs(large.length - small.length)).toBeLessThan(300);
    });

    it('no raw row value leaks into the prompt (privacy + why cost stays flat)', () => {
        const prompt = serializedPromptFor(30000);
        expect(prompt).not.toContain('Zzsentinelvalue');   // the unique cell value
        expect(prompt).not.toContain('Uniqueperson');
    });

    it('prompt DOES scale with columns (metadata), confirming it is schema-driven', () => {
        const fewCols = serializedPromptFor(1000);
        // Same rows, but add many extra columns → prompt grows (it is per-field).
        const wideRows = patients(1000).map((r, i) => ({
            ...r, extra_a: i, extra_b: `x${i}`, extra_c: i * 2, extra_d: `y${i % 7}`, extra_e: i % 3,
        }));
        const etl = runETLPipeline(wideRows, 'w.csv');
        const model = buildSemanticModel({ id: 't', name: 'w', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
        const wide = serializeSemanticModel(model);
        expect(wide.length).toBeGreaterThan(fewCols.length);
    });
});
