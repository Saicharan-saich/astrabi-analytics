/**
 * Persisted benchmark runs. Every run of the Benchmark Lab is stored as a record
 * so the Results Dashboard can show history, track accuracy over time (regression),
 * and export a report for a paper. Kept in localStorage via zustand/persist.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CaseResult, BenchmarkSummary } from '../services/benchmark/benchmarkRunner';
import type { Suite } from '../services/benchmark/spiderCases';

export interface BenchmarkRun {
    id: string;
    timestamp: number;
    /** Which engine produced the predictions (e.g. 'QuickInsight (Gemini)'). */
    engine: string;
    /** Suites included in this run. */
    suites: Suite[];
    /** Whether any suite used imported official cases (affects how to cite it). */
    usedOfficial: boolean;
    results: CaseResult[];
    summary: BenchmarkSummary;
    /** Optional free-text note (e.g. git SHA, model version). */
    note?: string;
}

interface BenchmarkStore {
    runs: BenchmarkRun[];
    addRun: (run: BenchmarkRun) => void;
    deleteRun: (id: string) => void;
    clearRuns: () => void;
}

const MAX_RUNS = 50;

export const useBenchmarkStore = create<BenchmarkStore>()(
    persist(
        (set) => ({
            runs: [],
            addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_RUNS) })),
            deleteRun: (id) => set((s) => ({ runs: s.runs.filter(r => r.id !== id) })),
            clearRuns: () => set({ runs: [] }),
        }),
        { name: 'qi_benchmark_runs' },
    ),
);
