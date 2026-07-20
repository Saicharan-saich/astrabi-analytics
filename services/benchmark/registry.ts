/**
 * Benchmark registry — the suites shown in the Benchmark Lab.
 *
 * Built-in packs are self-contained REPRESENTATIVE cases (small, hand-authored)
 * for wiring, demos and the CI regression gate. For publishable numbers, load
 * the OFFICIAL split via the importer (research/benchmark/importSpider.ts) —
 * those cases arrive as `loaded` and slot into the same runner.
 */

import { BENCHMARK_CASES, BenchCase, Suite } from './spiderCases';
import { MORE_CASES } from './moreCases';

export type SuiteKind = 'builtin' | 'loadable' | 'user';

export interface SuiteMeta {
    id: Suite;
    name: string;
    reference: string;
    blurb: string;
    kind: SuiteKind;
    /** True when the official split can be imported to replace/extend built-ins. */
    officialImportable: boolean;
}

export const ALL_BUILTIN_CASES: BenchCase[] = [...BENCHMARK_CASES, ...MORE_CASES];

export const SUITES: SuiteMeta[] = [
    {
        id: 'spider', name: 'Spider 1.0', reference: 'Yu et al., 2018',
        blurb: 'Cross-domain text-to-SQL: aggregates, GROUP BY/HAVING, ORDER BY/LIMIT, and multi-table joins.',
        kind: 'builtin', officialImportable: true,
    },
    {
        id: 'spider2', name: 'Spider 2.0', reference: 'Lei et al., 2024',
        blurb: 'Harder, enterprise-flavoured: nested subqueries and window functions (running totals, LAG, RANK).',
        kind: 'builtin', officialImportable: true,
    },
    {
        id: 'bird', name: 'BIRD', reference: 'Li et al., 2023',
        blurb: 'Big, real-world databases with numeric reasoning and ratio/derived-metric questions.',
        kind: 'builtin', officialImportable: true,
    },
    {
        id: 'internal', name: 'Internal Sales Benchmark', reference: 'QuickInsight star schema',
        blurb: 'A sales star schema close to what the product ingests — measures the denormalize → single-table path.',
        kind: 'builtin', officialImportable: false,
    },
    {
        id: 'user', name: 'User Benchmark', reference: 'Your uploaded dataset',
        blurb: 'Add your own question + gold-SQL pairs against the active dataset and score the engine on your data.',
        kind: 'user', officialImportable: false,
    },
];

export function suiteMeta(id: Suite): SuiteMeta | undefined {
    return SUITES.find(s => s.id === id);
}

/**
 * Cases for a suite. `loaded` holds any imported official cases and any
 * user-authored cases, keyed by suite; those take precedence when present.
 */
export function casesForSuite(id: Suite, loaded?: Record<string, BenchCase[]>): BenchCase[] {
    const injected = loaded?.[id];
    if (injected && injected.length > 0) return injected;
    return ALL_BUILTIN_CASES.filter(c => c.suite === id);
}

export function builtinCount(id: Suite): number {
    return ALL_BUILTIN_CASES.filter(c => c.suite === id).length;
}
