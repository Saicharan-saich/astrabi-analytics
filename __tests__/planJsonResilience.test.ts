/**
 * Regression for the reported crash: the user asked "Youngest patient" and the
 * query failed with `Expected property name or '}' in JSON at position 1`.
 * The LLM returned malformed JSON and JSON.parse threw, crashing the whole query.
 *
 * extractPlanJson must tolerate the ways real LLMs deviate from strict JSON
 * (markdown fences, comments, trailing commas, prose around the object) so the
 * pipeline degrades to a usable plan instead of failing.
 */
import { describe, it, expect } from 'vitest';
import { extractPlanJson } from '../services/ai-sql/intentPlanner';

describe('extractPlanJson — LLM JSON resilience', () => {
    it('parses clean JSON', () => {
        const v = extractPlanJson('{"intent":"single_metric","metrics":[{"field":"age","agg":"min"}]}');
        expect(v.intent).toBe('single_metric');
        expect(v.metrics[0].agg).toBe('min');
    });

    it('strips ```json markdown fences', () => {
        const v = extractPlanJson('```json\n{"intent":"ranking","limit":5}\n```');
        expect(v.intent).toBe('ranking');
        expect(v.limit).toBe(5);
    });

    it('ignores prose before and after the object', () => {
        const v = extractPlanJson('Here is the plan you asked for:\n{"intent":"breakdown"}\nHope this helps!');
        expect(v.intent).toBe('breakdown');
    });

    it('repairs trailing commas', () => {
        const v = extractPlanJson('{"intent":"trend","dimensions":[{"field":"d"},],"metrics":[],}');
        expect(v.intent).toBe('trend');
        expect(v.dimensions).toHaveLength(1);
    });

    it('strips line and block comments', () => {
        const v = extractPlanJson('{\n"intent":"single_metric", // scalar\n/* note */ "limit": null\n}');
        expect(v.intent).toBe('single_metric');
        expect(v.limit).toBeNull();
    });

    it('brace-matches nested objects, ignoring trailing junk', () => {
        const v = extractPlanJson('{"a":{"b":{"c":1}}} garbage after');
        expect(v.a.b.c).toBe(1);
    });

    it('recovers a TRUNCATED response by closing open braces/brackets', () => {
        // The "LLM returned unparseable JSON" case — cut at max_tokens mid-array.
        const v = extractPlanJson('{"intent":"single_metric","metrics":[{"field":"total_price","agg":"sum"');
        expect(v.intent).toBe('single_metric');
        expect(v.metrics[0].field).toBe('total_price');
    });

    it('does not close on a "}" inside a string value', () => {
        const v = extractPlanJson('{"intent":"breakdown","note":"group by {region}","limit":3}');
        expect(v.intent).toBe('breakdown');
        expect(v.note).toBe('group by {region}');
    });

    it('returns null (never throws) on truly unusable content', () => {
        // These must degrade to the deterministic fallback path, not crash the query.
        expect(extractPlanJson('')).toBeNull();
        expect(extractPlanJson('I could not answer that question.')).toBeNull();
        expect(extractPlanJson('{ this is not : json at all ]')).toBeNull();
        // The exact shape from the live "Youngest patient" crash — a bare "{" with no body.
        expect(extractPlanJson('{')).toBeNull();
    });
});
