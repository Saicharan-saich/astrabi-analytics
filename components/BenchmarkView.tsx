import React, { useMemo, useState } from 'react';
import {
    Play, Loader2, CheckCircle2, XCircle, Download, ChevronDown, ChevronRight,
    Gauge, Timer, Coins, Database, AlertTriangle, Info,
} from 'lucide-react';
import { BENCHMARK_CASES, BenchCase, Suite } from '../services/benchmark/spiderCases';
import {
    runBenchmark, summarize, resultsToCSV, CaseResult, BenchmarkSummary, BenchmarkProgress,
} from '../services/benchmark/benchmarkRunner';

type SuiteFilter = 'all' | Suite;

const SUITE_LABEL: Record<Suite, string> = { spider: 'Spider-style', spider2: 'Spider 2.0-style' };
const DIFF_COLOR: Record<string, string> = {
    easy: 'text-emerald-600 dark:text-emerald-400',
    medium: 'text-sky-600 dark:text-sky-400',
    hard: 'text-amber-600 dark:text-amber-400',
    extra: 'text-rose-600 dark:text-rose-400',
};

function pct(n: number): string {
    return `${Math.round(n * 100)}%`;
}

function download(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
}

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string }> = ({ icon, label, value, sub }) => (
    <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs font-semibold uppercase tracking-wide">
            {icon}{label}
        </div>
        <div className="mt-1.5 text-2xl font-extrabold text-gray-900 dark:text-white">{value}</div>
        {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
    </div>
);

const Bar: React.FC<{ label: string; passed: number; total: number }> = ({ label, passed, total }) => {
    const ratio = total ? passed / total : 0;
    return (
        <div className="flex items-center gap-3 text-sm">
            <div className="w-32 shrink-0 text-gray-600 dark:text-gray-300">{label}</div>
            <div className="flex-1 h-2.5 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden">
                <div
                    className={`h-full rounded-full ${ratio >= 0.7 ? 'bg-emerald-500' : ratio >= 0.4 ? 'bg-amber-500' : 'bg-rose-500'}`}
                    style={{ width: `${Math.round(ratio * 100)}%` }}
                />
            </div>
            <div className="w-20 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-200">
                {total ? `${passed}/${total}` : '—'}
            </div>
        </div>
    );
};

const CaseRow: React.FC<{ r: CaseResult }> = ({ r }) => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <tr
                className="border-t border-gray-100 dark:border-white/[0.06] hover:bg-gray-50 dark:hover:bg-white/[0.03] cursor-pointer"
                onClick={() => setOpen(o => !o)}
            >
                <td className="py-2 pl-2 pr-1 w-6 text-gray-400">
                    {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </td>
                <td className="py-2 pr-3">
                    {r.match
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        : <XCircle className="w-4 h-4 text-rose-500" />}
                </td>
                <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">{r.question}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">{SUITE_LABEL[r.suite]}</td>
                <td className={`py-2 pr-3 font-semibold ${DIFF_COLOR[r.difficulty]}`}>{r.difficulty}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">
                    {r.tableCount === 1 ? '1 table' : `${r.tableCount} tables`}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500 dark:text-gray-400">{r.latencyMs}ms</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500 dark:text-gray-400">{r.tokens.toLocaleString()}</td>
            </tr>
            {open && (
                <tr className="bg-gray-50/60 dark:bg-white/[0.02]">
                    <td />
                    <td colSpan={7} className="px-3 py-3">
                        <div className="grid gap-3 md:grid-cols-2">
                            <div>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Gold SQL</div>
                                <pre className="text-xs whitespace-pre-wrap rounded-lg bg-gray-900 text-gray-100 p-2.5 overflow-x-auto">{r.goldSQL}</pre>
                            </div>
                            <div>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Predicted SQL (AI SQL engine)</div>
                                <pre className="text-xs whitespace-pre-wrap rounded-lg bg-gray-900 text-gray-100 p-2.5 overflow-x-auto">{r.predictedSQL || '— (no SQL produced)'}</pre>
                            </div>
                            <div>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Expected ({r.expectedRows} rows)</div>
                                <pre className="text-xs whitespace-pre-wrap rounded-lg bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] p-2.5 overflow-x-auto text-gray-700 dark:text-gray-200">{JSON.stringify(r.expectedSample, null, 0)}</pre>
                            </div>
                            <div>
                                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Actual ({r.actualRows} rows)</div>
                                <pre className="text-xs whitespace-pre-wrap rounded-lg bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] p-2.5 overflow-x-auto text-gray-700 dark:text-gray-200">{JSON.stringify(r.actualSample, null, 0)}</pre>
                            </div>
                        </div>
                        <div className={`mt-2 text-xs flex items-center gap-1.5 ${r.error ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500 dark:text-gray-400'}`}>
                            {r.error && <AlertTriangle className="w-3.5 h-3.5" />}
                            <span className="font-semibold">{r.error ? 'Error:' : 'Verdict:'}</span> {r.error || r.reason}
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
};

export const BenchmarkView: React.FC = () => {
    const [suiteFilter, setSuiteFilter] = useState<SuiteFilter>('all');
    const [singleOnly, setSingleOnly] = useState(false);
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
    const [results, setResults] = useState<CaseResult[] | null>(null);

    const selectedCases = useMemo<BenchCase[]>(() => BENCHMARK_CASES.filter(c => {
        if (suiteFilter !== 'all' && c.suite !== suiteFilter) return false;
        if (singleOnly && c.tableCount !== 1) return false;
        return true;
    }), [suiteFilter, singleOnly]);

    const summary: BenchmarkSummary | null = useMemo(() => results ? summarize(results) : null, [results]);

    const run = async () => {
        setRunning(true);
        setResults(null);
        setProgress({ done: 0, total: selectedCases.length, current: 'Starting…' });
        try {
            const res = await runBenchmark(selectedCases, p => setProgress(p));
            setResults(res);
        } catch (e: any) {
            setResults([]);
            console.error('[Benchmark] run failed:', e);
        } finally {
            setRunning(false);
            setProgress(null);
        }
    };

    const counts = useMemo(() => {
        const single = selectedCases.filter(c => c.tableCount === 1).length;
        return { total: selectedCases.length, single, multi: selectedCases.length - single };
    }, [selectedCases]);

    return (
        <div className="h-full overflow-y-auto px-6 py-6 max-w-6xl mx-auto">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white flex items-center gap-2">
                        <Gauge className="w-6 h-6 text-indigo-500" />
                        AI SQL Benchmark
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-3xl">
                        Runs Spider &amp; Spider 2.0-style text-to-SQL cases through the real AI SQL pipeline,
                        executes each gold query for ground truth, and reports <strong>execution accuracy</strong>,
                        latency and token cost per case.
                    </p>
                </div>
            </div>

            {/* Honest scope note */}
            <div className="mt-4 rounded-xl border border-indigo-200 dark:border-indigo-500/20 bg-indigo-50/60 dark:bg-indigo-500/[0.06] p-3.5 text-sm text-indigo-900 dark:text-indigo-200 flex gap-2.5">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                    <strong>How to read this.</strong> QuickInsight handles multiple tables by <em>denormalizing
                    them into one master table</em> up front (the same fact-first join the connector runs), then the
                    AI-SQL pipeline queries that single wide table. So the runner mirrors the real path: multi-table
                    cases are joined into a master table first, exactly like production. The single- vs multi-table
                    split below is reported because the join step is where aggregation grain can change (join
                    fan-out) — worth watching on its own. These are self-contained cases in the spirit of the official
                    benchmarks (which ship ~200 databases / cloud-warehouse workloads that can't run in a browser),
                    so results measure this engine, not the full public leaderboard.
                </div>
            </div>

            {/* Controls */}
            <div className="mt-5 flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-lg border border-gray-200 dark:border-white/[0.1] overflow-hidden">
                    {(['all', 'spider', 'spider2'] as SuiteFilter[]).map(s => (
                        <button
                            key={s}
                            onClick={() => setSuiteFilter(s)}
                            disabled={running}
                            className={`px-3 py-1.5 text-sm font-semibold transition-colors ${suiteFilter === s
                                ? 'bg-indigo-500 text-white'
                                : 'bg-white dark:bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.05]'}`}
                        >
                            {s === 'all' ? 'All' : SUITE_LABEL[s]}
                        </button>
                    ))}
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 select-none">
                    <input
                        type="checkbox"
                        checked={singleOnly}
                        onChange={e => setSingleOnly(e.target.checked)}
                        disabled={running}
                        className="rounded border-gray-300 text-indigo-500 focus:ring-indigo-500"
                    />
                    Single-table only
                </label>

                <span className="text-xs text-gray-400">
                    {counts.total} case{counts.total === 1 ? '' : 's'} · {counts.single} single-table · {counts.multi} multi-table
                </span>

                <div className="flex-1" />

                <button
                    onClick={run}
                    disabled={running || counts.total === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-b from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 shadow-lg shadow-indigo-500/25 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                    {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    {running ? 'Running…' : `Run ${counts.total} cases`}
                </button>

                {results && results.length > 0 && (
                    <>
                        <button
                            onClick={() => download('benchmark-results.csv', resultsToCSV(results), 'text/csv')}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05]"
                        >
                            <Download className="w-4 h-4" /> CSV
                        </button>
                        <button
                            onClick={() => download('benchmark-results.json', JSON.stringify(results, null, 2), 'application/json')}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05]"
                        >
                            <Download className="w-4 h-4" /> JSON
                        </button>
                    </>
                )}
            </div>

            {/* Progress */}
            {running && progress && (
                <div className="mt-5">
                    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1.5">
                        <span className="truncate pr-3">{progress.current}</span>
                        <span className="tabular-nums">{progress.done}/{progress.total}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden">
                        <div
                            className="h-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                        />
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                        Each case runs the live LLM planner + DuckDB — this makes real AI calls and can take a minute.
                    </p>
                </div>
            )}

            {/* Results */}
            {summary && !running && (
                <>
                    <div className="mt-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
                        <StatCard
                            icon={<Gauge className="w-3.5 h-3.5" />} label="Execution accuracy"
                            value={pct(summary.accuracy)} sub={`${summary.passed}/${summary.total} cases passed`}
                        />
                        <StatCard
                            icon={<Timer className="w-3.5 h-3.5" />} label="Avg latency"
                            value={`${summary.avgLatencyMs}ms`} sub="per case (LLM + DuckDB)"
                        />
                        <StatCard
                            icon={<Coins className="w-3.5 h-3.5" />} label="Avg tokens"
                            value={summary.avgTokens.toLocaleString()} sub={`${summary.totalTokens.toLocaleString()} total`}
                        />
                        <StatCard
                            icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Errors"
                            value={String(summary.errors)} sub="cases that threw"
                        />
                    </div>

                    <div className="mt-5 grid gap-5 md:grid-cols-3">
                        <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">
                                <Database className="w-3.5 h-3.5" /> By table class
                            </div>
                            <div className="space-y-2.5">
                                {summary.byTableClass.map(b => <Bar key={b.label} {...b} />)}
                            </div>
                        </div>
                        <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                            <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">By suite</div>
                            <div className="space-y-2.5">
                                {summary.bySuite.map(b => <Bar key={b.label} {...b} />)}
                            </div>
                        </div>
                        <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                            <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">By difficulty</div>
                            <div className="space-y-2.5">
                                {summary.byDifficulty.map(b => <Bar key={b.label} {...b} />)}
                            </div>
                        </div>
                    </div>

                    {/* Per-case table */}
                    <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/[0.08] overflow-hidden">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 dark:bg-white/[0.03] text-[11px] uppercase tracking-wide text-gray-400">
                                <tr>
                                    <th />
                                    <th className="py-2 pr-3 text-left font-bold">OK</th>
                                    <th className="py-2 pr-3 text-left font-bold">Question</th>
                                    <th className="py-2 pr-3 text-left font-bold">Suite</th>
                                    <th className="py-2 pr-3 text-left font-bold">Difficulty</th>
                                    <th className="py-2 pr-3 text-left font-bold">Tables</th>
                                    <th className="py-2 pr-3 text-right font-bold">Latency</th>
                                    <th className="py-2 pr-3 text-right font-bold">Tokens</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results!.map(r => <CaseRow key={r.id} r={r} />)}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {/* Empty state */}
            {!summary && !running && (
                <div className="mt-10 text-center text-gray-400">
                    <Gauge className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p className="text-sm">Pick a suite and press <strong>Run</strong> to benchmark the AI SQL engine.</p>
                </div>
            )}
        </div>
    );
};

export default BenchmarkView;
