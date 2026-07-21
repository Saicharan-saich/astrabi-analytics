/**
 * Research-report generator. Turns a benchmark run into a Markdown report
 * (execution accuracy, latency, tokens, error taxonomy, per-case appendix) that
 * can be pasted into a paper draft, plus a machine-readable JSON export.
 */
import type { BenchmarkRun } from '../../store/useBenchmarkStore';
import type { BenchmarkSummary, CaseResult } from './benchmarkRunner';

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

function summaryTable(s: BenchmarkSummary): string {
    return [
        '| Metric | Value |',
        '| --- | --- |',
        `| Execution accuracy | ${pct(s.accuracy)} (${s.passed}/${s.total}) |`,
        s.testSuiteInstances > 1 ? `| Test-suite accuracy (${s.testSuiteInstances} instances) | ${pct(s.testSuiteAccuracy)} |` : '',
        `| Valid Efficiency Score (VES) | ${pct(s.ves)} |`,
        `| Execution success (SQL ran) | ${pct(s.executionSuccess)} |`,
        `| Self-repair rate | ${pct(s.repairRate)} |`,
        `| Avg latency | ${s.avgLatencyMs} ms |`,
        `| Avg tokens / question | ${s.avgTokens.toLocaleString()} |`,
        `| Total tokens | ${s.totalTokens.toLocaleString()} |`,
        `| Avg confidence (semantic proxy) | ${s.avgConfidence}/100 |`,
        `| Execution errors | ${s.errors} |`,
    ].filter(Boolean).join('\n');
}

function bucketTable(title: string, rows: { label: string; passed: number; total: number }[]): string {
    if (rows.length === 0) return '';
    const body = rows.map(b => `| ${b.label} | ${b.total ? pct(b.passed / b.total) : '—'} | ${b.passed}/${b.total} |`).join('\n');
    return `\n**${title}**\n\n| Group | Accuracy | Passed |\n| --- | --- | --- |\n${body}\n`;
}

function taxonomyTable(s: BenchmarkSummary): string {
    if (s.failureBreakdown.length === 0) return '\n_No failures._\n';
    const body = s.failureBreakdown.map(f => `| ${f.label} | ${f.count} |`).join('\n');
    return `\n| Failure category | Count |\n| --- | --- |\n${body}\n`;
}

function appendix(results: CaseResult[]): string {
    const head = '| # | Suite | Question | Correct | Category | Latency | Tokens |\n| --- | --- | --- | --- | --- | --- | --- |';
    const rows = results.map((r, i) =>
        `| ${i + 1} | ${r.suite} | ${r.question.replace(/\|/g, '\\|')} | ${r.match ? '✅' : '❌'} | ${r.match ? '—' : r.failCategory} | ${r.latencyMs}ms | ${r.tokens} |`,
    );
    return [head, ...rows].join('\n');
}

export function runToMarkdown(run: BenchmarkRun): string {
    const s = run.summary;
    const date = new Date(run.timestamp).toISOString();
    return [
        `# QuickInsight Benchmark Report`,
        '',
        `- **Engine:** ${run.engine}`,
        `- **Suites:** ${run.suites.join(', ')}`,
        `- **Case provenance:** ${run.usedOfficial ? 'includes imported OFFICIAL cases' : 'built-in representative cases only'}`,
        `- **Run at:** ${date}`,
        run.note ? `- **Note:** ${run.note}` : '',
        '',
        '## Headline metrics',
        '',
        summaryTable(s),
        '',
        '## Breakdowns',
        bucketTable('By benchmark suite', s.bySuite),
        bucketTable('By table class (single vs multi-table)', s.byTableClass),
        bucketTable('By difficulty', s.byDifficulty),
        '',
        '## Error taxonomy',
        taxonomyTable(s),
        '',
        '## Methodology',
        '',
        'Evaluation is **execution-based**: the gold SQL and the engine-generated SQL are each executed, and their **result sets** are compared (order-sensitive only when the gold query has an ORDER BY). SQL strings are never compared. Multi-table cases are denormalized into one master table via the same join engine the product uses, then answered by the single-table pipeline — this mirrors the shipping data path.',
        run.usedOfficial ? '' : '\n> ⚠️ These are small, self-contained **representative** cases for wiring and regression, **not** the official benchmark splits. Cite numbers from an OFFICIAL import for publication.',
        '',
        '## Appendix — per-case results',
        '',
        appendix(run.results),
        '',
    ].filter(l => l !== '').join('\n');
}

export function runToJSON(run: BenchmarkRun): string {
    return JSON.stringify(run, null, 2);
}
