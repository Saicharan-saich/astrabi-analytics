/**
 * AI SQL Pipeline Orchestrator
 *
 * Wires together the entire enterprise AI SQL architecture into a single
 * `runAISQLPipeline()` function. This is the main entry point used by
 * AISQLView.tsx.
 *
 * Full pipeline:
 * 1. Build Semantic Model → from dataset
 * 2. Generate Analysis Plan → Step A (LLM intent extraction)
 * 3. Generate SQL → Step B (deterministic + LLM fallback)
 * 4. Validate SQL → pre-execution checks
 * 5. Execute SQL → DuckDB-WASM on local data
 * 6. Validate Result → post-execution sanity checks
 * 7. Profile Result → analyze shape for chart selection
 * 8. Recommend Chart → deterministic rules
 * 9. Reshape Data → pivot, Top-N, chronological sort
 * 10. Score Confidence → evaluate system trust
 * 11. Log Audit → observability
 */

import { Dataset } from '../../types';
import { AISQLPipelineResult, AuditEntry, PlanFilter, PipelineStepTrace, PipelineTrace } from './types';
import { buildSemanticModel } from './semanticLayer';
import { generatePlan, generateLocalPlan } from './intentPlanner';
import { generateSQLFromPlan, repairSQL } from './sqlGenerator';
import { correctSQL, normalizeFilterOp } from './sqlCorrectionEngine';
import { validateSQL, validateResult } from './sqlValidator';
import { executeSQLViaDuckDB } from '../duckdbEngine';
import { profileResult } from './resultProfiler';
import { recommendChart } from './chartRecommender';
import { reshapeData } from './dataReshaper';
import { scoreConfidence } from './confidenceScorer';
import { logAuditEntry } from './auditLogger';
import { resolveTimeContext, augmentQuestionWithTime } from './timeResolver';
import { processPlan } from './derivedMetricEngine';
import { formatSQL } from '../sqlFormatter';
import { generateTrustVerification } from './trustEngine';
import { mapPlanToQBConfig } from './qbMapper';
import { buildQueryPlan } from '../queryPlan/buildQueryPlan';
import { compileSQL } from '../queryPlan/sqlCompiler';
import { getDates } from '../dateHelpers';
import { applyTableCalculation } from '../../utils/tableCalculations';
import { buildValueCatalog, groundFilters, groundSqlLiterals } from './valueGrounding';
import { verifyPlan } from './planVerification';
import { detectAntiJoin, buildAntiJoinSQL } from './antiJoin';
import { generateDirectSQL } from './directSqlEngine';
import { serializeSemanticModelSchema, collectSafeDomains } from './schemaSerializer';
import { describeSchemaForLLM, discoverJoinContext } from './joinEngine';
import { getEffectivePrivacyMode } from './privacyMode';
import { getSelection, applySelection } from './privacySelection';

/**
 * Progress callback for tracking pipeline execution steps.
 * Fix #12: Enables loading state progress indicators in the UI.
 */
export interface PipelineProgress {
    step: string;
    stepNumber: number;
    totalSteps: number;
    percent: number;
}

/**
 * Run the complete AI SQL pipeline from question to chart-ready data.
 *
 * @param question - The user's natural language question
 * @param dataset - The loaded dataset
 * @param externalFilters - Optional filters from the UI (QuestionCustomizer)
 * @param onProgress - Optional callback for pipeline step progress (Fix #12)
 * @returns A complete pipeline result with plan, SQL, data, chart config, and confidence
 */
export async function runAISQLPipeline(
    question: string,
    dataset: Dataset,
    externalFilters?: PlanFilter[],
    onProgress?: (progress: PipelineProgress) => void,
    grainOverride?: 'day' | 'week' | 'month' | 'quarter' | 'year',
    forceRefresh?: boolean
): Promise<AISQLPipelineResult> {
    const startTime = performance.now();
    let repairAttempts = 0;
    const TOTAL_STEPS = 12;
    const reportProgress = (step: string, stepNumber: number) => {
        onProgress?.({ step, stepNumber, totalSteps: TOTAL_STEPS, percent: Math.round((stepNumber / TOTAL_STEPS) * 100) });
    };

    // ─── Pipeline Trace Collector ─────────────────────────────────
    const traceSteps: PipelineStepTrace[] = [];
    const traceStep = (step: Omit<PipelineStepTrace, 'startMs' | 'durationMs'>, stepStart: number) => {
        traceSteps.push({ ...step, startMs: Math.round(stepStart - startTime), durationMs: Math.round(performance.now() - stepStart) });
    };

    console.log('[AI SQL Pipeline] Starting for question:', question);

    if (externalFilters?.length) {
        console.log(`[Pipeline] ${externalFilters.length} external filter(s) provided from UI`);
    }

    // ─── Step 1: Build Semantic Model ────────────────────────────
    reportProgress('Building semantic model...', 1);
    console.log('[Pipeline] Step 1: Building semantic model...');
    let _s1 = performance.now();
    const semanticModel = buildSemanticModel(dataset);
    const _metrics = semanticModel.fields.filter(f => f.role === 'metric').length;
    const _dims = semanticModel.fields.filter(f => f.role === 'dimension').length;
    traceStep({
        stepNumber: 1, name: 'Semantic Model', engine: 'semanticLayer', icon: '🧠',
        status: 'pass',
        summary: `Classified ${semanticModel.fields.length} fields → ${_metrics} metrics, ${_dims} dimensions, ${semanticModel.compositeMetrics.length} composite`,
        details: {
            fields: semanticModel.fields.map(f => ({ name: f.name, role: f.role, type: f.semanticType, agg: f.defaultAgg })),
            compositeMetrics: semanticModel.compositeMetrics.map(c => c.label),
            derivedMetrics: (semanticModel.derivedMetrics || []).map(d => d.label),
            timeContext: semanticModel.timeContext || null,
        },
    }, _s1);
    console.log(`[Pipeline] Semantic model: ${semanticModel.fields.length} fields, ${semanticModel.compositeMetrics.length} composite, ${semanticModel.derivedMetrics?.length || 0} derived metrics`);

    // ─── Step 1b: Resolve Time Context (BEFORE LLM) ────────────
    reportProgress('Resolving time context...', 2);
    console.log('[Pipeline] Step 1b: Resolving time context...');
    _s1 = performance.now();
    const resolvedTime = resolveTimeContext(question, semanticModel);
    const augmentedQuestion = augmentQuestionWithTime(question, resolvedTime);
    traceStep({
        stepNumber: 2, name: 'Time Resolver', engine: 'timeResolver', icon: '⏰',
        status: resolvedTime.filter ? 'pass' : 'skip',
        summary: resolvedTime.filter
            ? `"${resolvedTime.matchedPhrase}" → ${resolvedTime.description}`
            : 'No time reference detected in question',
        details: {
            matchedPhrase: resolvedTime.matchedPhrase || null,
            filter: resolvedTime.filter || null,
            anchorDate: semanticModel.timeContext?.anchorDate || null,
        },
    }, _s1);
    if (resolvedTime.filter) {
        console.log(`[Pipeline] Time resolved: "${resolvedTime.matchedPhrase}" → ${resolvedTime.description}`);
    }

    // ─── Step 1c: Value Catalog + Direct-SQL Kickoff (PARALLEL) ──
    // The LLM writes SQL from the question + schema alone — it does NOT need the
    // analysis plan. So fire that call NOW, concurrently with the planner below,
    // instead of waiting for the plan first. Two sequential LLM round trips
    // become one wall-clock wait, roughly halving time-to-answer.
    let _valueCatalog: ReturnType<typeof buildValueCatalog> | null = null;
    try {
        _valueCatalog = buildValueCatalog(dataset.rows, semanticModel);
    } catch (cErr: any) {
        console.warn('[Pipeline] Value catalog build skipped:', cErr?.message);
    }

    const _directSqlStart = performance.now();
    // Always resolves (never rejects) so it can safely be awaited later.
    const directSqlPromise: Promise<{ sql: string | null; tokens: number; error: string | null }> = (async () => {
        try {
            // Privacy mode gates what the LLM may see. Strict = metadata only, no
            // data values leave the browser. Enhanced = also send bounded category
            // domains (non-sensitive, low-cardinality; PII, identifiers and
            // sensitive categoricals excluded). Rows are never sent in either.
            const privacyMode = getEffectivePrivacyMode();
            // The automatic filter decides what is eligible; the user's own
            // per-column and per-value choices then subtract from that.
            let domains = privacyMode === 'enhanced'
                ? collectSafeDomains(dataset.rows, semanticModel)
                : undefined;
            if (domains) {
                const before = domains.size;
                domains = applySelection(domains, getSelection(dataset.name || dataset.id));
                if (domains.size !== before) {
                    console.log(`[Pipeline] User switched off ${before - domains.size} column(s) from sharing`);
                }
                if (domains.size === 0) domains = undefined;
            }
            console.log(`[Pipeline] Direct-SQL privacy mode: ${privacyMode}${domains ? ` (${domains.size} category domain(s) shared)` : ' (metadata only)'}`);
            let richSchema = serializeSemanticModelSchema(semanticModel, 'data', domains);

            // When the source had several tables, describe those too. The
            // flattened "data" table can double-count after a one-to-many join,
            // so the model is told it may query the real tables and join them
            // itself, at the correct grain.
            const joinCtx = discoverJoinContext(dataset.relatedTables, dataset.sourceSchema);
            if (joinCtx) {
                richSchema += `\n\nThis dataset came from several tables. "data" is a pre-joined, flattened copy — convenient, but a one-to-many join means totals over it can be double-counted. The original tables are also available and are the safer choice when a question spans more than one of them:\n\n${joinCtx.description}`;
                console.log(`[Pipeline] Multi-table schema shared: ${joinCtx.tableNames.join(', ')}`);
            }
            const ds = await generateDirectSQL(question, richSchema);
            if (ds.sql && !ds.error) {
                let sql = ds.sql;
                // Safety net: correct any literal whose casing/plural drifted from
                // the real stored value (never fabricates).
                if (_valueCatalog) {
                    const g = groundSqlLiterals(sql, _valueCatalog);
                    if (g.changed.length) {
                        sql = g.sql;
                        console.log('[Pipeline] Grounded SQL literals:', g.changed.join(', '));
                    }
                }
                console.log('[Pipeline] Direct-SQL engine SQL:', sql);
                return { sql, tokens: ds.tokens || 0, error: null };
            }
            console.warn('[Pipeline] Direct-SQL not usable:', ds.error || 'empty SQL');
            return { sql: null, tokens: ds.tokens || 0, error: ds.error || 'empty SQL' };
        } catch (dErr: any) {
            const msg = dErr?.message || String(dErr);
            console.warn('[Pipeline] Direct-SQL engine failed — deterministic backup will answer:', msg);
            return { sql: null, tokens: 0, error: msg };
        }
    })();

    // ─── Step 2: Generate Analysis Plan ─────────────────────────────
    // The direct-SQL engine is settled FIRST, because its answer decides whether
    // the LLM planner is worth calling at all.
    //
    // When direct-SQL produced usable SQL, the planner's own SQL would be thrown
    // away — the plan is then only needed to pick the chart, shape the summary
    // and drive formatting. The deterministic classifier + field mapper cover
    // that, so we build the plan locally instead: no second request, no ~5k-token
    // prompt, and no waiting on it. The LLM planner is still called in full when
    // direct-SQL fails, which is exactly when its judgement is needed.
    reportProgress('Asking the AI...', 3);
    _s1 = performance.now();
    const _dsEarly = await directSqlPromise;
    const plan = _dsEarly.sql
        ? generateLocalPlan(augmentedQuestion, semanticModel, grainOverride)
        : await generatePlan(augmentedQuestion, semanticModel, grainOverride);
    console.log(`[Pipeline] Step 2: Plan built ${_dsEarly.sql ? 'LOCALLY (direct-SQL succeeded — planner call skipped)' : 'by the LLM planner (direct-SQL unusable)'}`);
    traceStep({
        stepNumber: 3, name: 'Intent Planner', engine: 'intentPlanner', icon: '🎯',
        status: plan.ambiguous ? 'warn' : 'pass',
        summary: `${_dsEarly.sql ? 'Local plan (0 tokens)' : 'LLM plan'} — intent: ${plan.intent} | ${plan.dimensions.length} dim(s), ${plan.metrics.length} metric(s), ${plan.filters.length} filter(s)${plan.limit ? `, limit ${plan.limit}` : ''}`,
        details: {
            intent: plan.intent,
            dimensions: plan.dimensions.map(d => ({ field: d.field, grain: d.timeGrain || null })),
            metrics: plan.metrics.map(m => ({ field: m.field, agg: m.agg })),
            filters: plan.filters.map(f => ({ field: f.field, op: f.op, value: f.value })),
            sort: plan.sort,
            limit: plan.limit,
            resultGrain: plan.resultGrain,
            ambiguous: plan.ambiguous,
            plannerCallSkipped: !!_dsEarly.sql,
        },
    }, _s1);

    // Inject the pre-resolved time filter if the LLM didn't include one
    if (resolvedTime.filter) {
        const dateField = resolvedTime.filter.field.toLowerCase();
        const hasDateFilter = plan.filters.some(f =>
            f.field.toLowerCase() === dateField && f.op === 'between'
        );
        if (!hasDateFilter) {
            // Remove any this_ filters the LLM may have added
            plan.filters = plan.filters.filter(f => !f.op.startsWith('this_'));
            plan.filters.push(resolvedTime.filter);
            console.log('[Pipeline] Injected pre-resolved time filter into plan');
        }
    }

    // ─── Step 2b: Inject External Filters (from UI) ──────────────
    // Fix #3: Filters set in the QuestionCustomizer now propagate to AI SQL
    if (externalFilters && externalFilters.length > 0) {
        for (const ef of externalFilters) {
            // Don't duplicate if the LLM already included the same filter
            const exists = plan.filters.some(f =>
                f.field.toLowerCase() === ef.field.toLowerCase() && f.op === ef.op
            );
            if (!exists) {
                plan.filters.push(ef);
                console.log(`[Pipeline] Injected external filter: ${ef.field} ${ef.op} ${JSON.stringify(ef.value)}`);
            }
        }
    }

    // ─── Step 2b′: Value Grounding ───────────────────────────────
    // Recover filters the plan dropped by matching question phrases against the
    // dataset's actual dimension values (deterministic, no LLM). Fixes the
    // "revenue from Delivery → filter vanished" class of bug, and works even
    // when the LLM planner is unavailable/rate-limited.
    try {
        if (!_valueCatalog) throw new Error('value catalog unavailable');
        const grounded = groundFilters(question, _valueCatalog, plan, semanticModel);
        if (grounded.added.length > 0) {
            plan.filters.push(...grounded.added);
            console.log(`[Pipeline] Value grounding recovered ${grounded.added.length} filter(s): ${grounded.added.map(f => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}`);
        }
        if (grounded.setLogicFields.length > 0) {
            console.log(`[Pipeline] Value grounding: set-logic detected on [${grounded.setLogicFields.join(', ')}] — left for the anti-join knob, not grounded as a filter.`);
        }
    } catch (gErr: any) {
        console.warn('[Pipeline] Value grounding skipped:', gErr?.message);
    }

    // ─── Step 2b″: Plan Verification (faithfulness gate) ─────────
    // Deterministic invariant checks: does the plan actually represent the
    // question? Surfaces dropped filters / wrong metric / missing ranking so a
    // mismatch becomes a flagged, low-confidence answer instead of a silent
    // wrong one.
    let _verification = verifyPlan(question, plan, semanticModel, _valueCatalog || undefined);
    if (_verification.issues.length > 0) {
        console.warn(`[Pipeline] Plan verification: ${_verification.issues.length} issue(s) — ${_verification.issues.map(i => `[${i.severity}] ${i.code}`).join(', ')}`);
    }
    traceStep({
        stepNumber: 4, name: 'Plan Verification', engine: 'planVerification', icon: '🔎',
        status: _verification.ok ? (_verification.issues.length ? 'warn' : 'pass') : 'fail',
        summary: _verification.issues.length === 0
            ? 'Plan faithfully represents the question'
            : `${_verification.issues.length} faithfulness issue(s): ${_verification.issues.map(i => i.code).join(', ')}`,
        details: { ok: _verification.ok, issues: _verification.issues },
    }, performance.now());

    // ─── Step 2c: APDME — Derived Metrics & Guardrails ─────────────
    reportProgress('Analyzing derived metrics...', 3);
    console.log('[Pipeline] Step 2c: Running APDME (Derived Metric Engine)...');
    _s1 = performance.now();
    const apdmeResult = processPlan(plan, semanticModel);
    traceStep({
        stepNumber: 4, name: 'APDME Guardrails', engine: 'derivedMetricEngine', icon: '🛡️',
        status: apdmeResult.violations.length > 0 ? 'warn' : 'pass',
        summary: apdmeResult.derivedMetricApplied
            ? `Derived metric applied: ${apdmeResult.derivedMetrics.map(d => d.aggregatedExpression).join(', ')}`
            : apdmeResult.violations.length > 0
                ? `${apdmeResult.violations.length} guardrail violation(s), penalty: -${apdmeResult.confidencePenalty}`
                : 'All metrics passed guardrail checks',
        details: {
            derivedMetricApplied: apdmeResult.derivedMetricApplied,
            derivedMetrics: apdmeResult.derivedMetrics.map(d => d.aggregatedExpression),
            violations: apdmeResult.violations.map(v => v.message),
            confidencePenalty: apdmeResult.confidencePenalty,
        },
    }, _s1);
    if (apdmeResult.derivedMetricApplied) {
        console.log(`[Pipeline] APDME: Derived metric applied — ${apdmeResult.derivedMetrics.map(d => d.aggregatedExpression).join(', ')}`);
    }
    if (apdmeResult.violations.length > 0) {
        console.warn(`[Pipeline] APDME: ${apdmeResult.violations.length} guardrail violation(s), penalty: -${apdmeResult.confidencePenalty}`);
    }

    // Only ask the user to rephrase if the planner was unsure AND the AI couldn't
    // write usable SQL either. When the AI did understand the question well enough
    // to write SQL, answer it — the planner's uncertainty must not dead-end a
    // question the AI handled fine. (The promise is already in flight, so this
    // await costs nothing extra.)
    if (plan.ambiguous && !_dsEarly.sql) {
        console.log('[Pipeline] Plan is ambiguous and no AI SQL — requesting clarification');
        const executionTime = performance.now() - startTime;
        return {
            plan,
            sql: '',
            validation: { valid: false, checks: [] },
            rawData: [],
            chartData: [],
            profile: {
                rowCount: 0, columnCount: 0, metricCount: 0, dimensionCount: 0,
                dimensionColumns: [], metricColumns: [], dimensionCardinality: {},
                hasTimeDimension: false, metricsScaleMismatch: 1, metricSemanticTypes: {},
                isPivoted: false, isSingleValue: false,
            },
            chart: { chartType: 'table', xKey: '', yKey: '', useDualAxis: false, reason: 'Ambiguous query — awaiting clarification' },
            confidence: { score: 0, level: 'low', factors: { semanticMatch: 0, filterClarity: 0, aggregationCertainty: 0, planComplexity: 0, repairAttempts: 0 }, reasons: ['Query is ambiguous'] },
            explanation: plan.clarificationQuestion || 'Could not determine the exact intent. Please rephrase.',
            columnsUsed: [],
            executionTimeMs: executionTime,
            repairAttempts: 0,
            tokenUsage: (plan as any).tokenUsage || { prompt: 0, completion: 0, total: 0 },
        };
    }

    // ─── Step 2d: Question Builder Mapping Gate (QB-first) ───────
    // Try to answer through the hardened Question Builder engine first. The
    // mapper lands the plan on the builder's finite, typed knob set; only when
    // the question needs a shape the builder has no knob for do we fall back to
    // the AI SQL correction engine below.
    reportProgress('Mapping to Question Builder...', 4);
    console.log('[Pipeline] Step 2d: Question Builder mapping gate...');
    _s1 = performance.now();
    // Anti-join knob first: "which X did A but never B" is a set-logic shape no
    // base builder knob covers. Detected from the value catalog (a field with
    // both a positive and a negated value) and answered with a NOT EXISTS template.
    const antiJoin = _valueCatalog ? detectAntiJoin(question, _valueCatalog, semanticModel) : null;

    let qbSQL: string | null = null;
    // For share-of-total the builder applies its "% of total" table calculation
    // to the base result (each group ÷ grand total); we capture the metric alias
    // to convert after execution.
    let qbShareValueKey: string | null = null;
    let qbNotes: string[] = [];
    let qbReason: string | null = null;
    let qbTraceDetails: Record<string, any>;

    if (antiJoin) {
        qbSQL = buildAntiJoinSQL(antiJoin, 'data');
        qbNotes = [`anti-join: ${antiJoin.entity} where ${antiJoin.filterField} in [${antiJoin.hasValues.join(', ')}] but never [${antiJoin.notValues.join(', ')}]`];
        qbTraceDetails = { antiJoin: true, spec: antiJoin, sql: qbSQL };
        console.log('[Pipeline] Anti-join SQL:', qbSQL);
        // The set-logic values are handled by the anti-join, not dropped — clear
        // the spurious dropped-filter verification issues.
        const cleaned = _verification.issues.filter(i => i.code !== 'dropped_filter');
        _verification = { ok: !cleaned.some(i => i.severity === 'error'), issues: cleaned };
    } else {
        const qbResult = mapPlanToQBConfig(plan, semanticModel);
        if (qbResult.fits) {
            try {
                const anchor = semanticModel.timeContext?.anchorDate
                    || semanticModel.timeContext?.maxDate
                    || new Date().toISOString().slice(0, 10);
                const dates = getDates(anchor);
                const qp = buildQueryPlan(qbResult.config, qbResult.dateColumnKey, dates, 'data');
                qbSQL = compileSQL(qp);
                if (qbResult.shareOfTotal && qp.metrics[0]) qbShareValueKey = qp.metrics[0].alias;
                console.log('[Pipeline] QB-mapped SQL:', qbSQL);
            } catch (qbErr: any) {
                console.warn('[Pipeline] QB compilation failed, falling back to AI SQL:', qbErr.message);
                qbSQL = null;
                qbShareValueKey = null;
            }
        }
        if (qbResult.fits === true) {
            qbNotes = qbResult.notes;
            qbTraceDetails = { fits: true, config: qbResult.config, notes: qbNotes, sql: qbSQL };
        } else {
            qbReason = 'reason' in qbResult ? qbResult.reason : null;
            qbTraceDetails = { fits: false, reason: qbReason };
        }
    }
    traceStep({
        stepNumber: 5, name: antiJoin ? 'Anti-Join Knob (backup)' : 'Question Builder (backup)', engine: 'qbMapper', icon: '🎛️',
        status: qbSQL ? 'pass' : 'skip',
        summary: qbSQL
            ? `Deterministic backup ready (used only if the LLM fails) — ${qbNotes.join('; ')}`
            : `No deterministic backup — ${qbReason || 'compilation failed'}`,
        details: qbTraceDetails,
    }, _s1);

    // ─── Step 2e: Direct-SQL Engine (the AI writes the SQL — always) ──
    // The LLM writes SQL directly from the rich, METADATA-ONLY schema (roles,
    // additivity, identifiers, date range — never raw rows). This ALWAYS runs
    // and is the answer for every AI SQL question. The deterministic engines
    // (the Question Builder knobs above and the correction engine below) are
    // now only a QUIET BACKUP: they step in solely when the LLM is unavailable,
    // rate-limited, or returns SQL that fails the read-only gate or won't run —
    // so a user still gets an answer instead of an error.
    // It was kicked off back in Step 1c, in parallel with the planner — so by the
    // time we get here it is usually already finished (zero extra wait).
    let directSQL: string | null = null;
    let directSqlTokens = 0;
    let directSqlError: string | null = null;
    {
        const _ds = _dsEarly; // settled before the plan step
        directSQL = _ds.sql;
        directSqlTokens = _ds.tokens;
        directSqlError = _ds.error;
        traceStep({
            stepNumber: 5, name: 'Direct-SQL Engine', engine: 'directSqlEngine', icon: '✍️',
            status: directSQL ? 'pass' : 'skip',
            summary: directSQL
                ? 'LLM wrote the SQL from the schema — the planner call was skipped, saving its prompt'
                : `Skipped — ${directSqlError || 'no SQL'} (using the deterministic backup)`,
            details: { sql: directSQL, error: directSqlError, tokens: directSqlTokens },
        }, _directSqlStart);
    }

    // ─── Step 3: Generate SQL (Step B — deterministic + LLM fallback) ─
    reportProgress('Generating SQL...', 4);
    console.log('[Pipeline] Step 3: Generating SQL...');
    _s1 = performance.now();
    let sqlResult: { sql: string; method: string; explanation?: string };
    if (directSQL) {
        // The LLM wrote the SQL from the schema — this is the answer.
        sqlResult = { sql: directSQL, method: 'llm-sql', explanation: '' };
        // The LLM's SQL already computes its own result shape, so drop the
        // Question Builder's share-of-total table calc (it only applies to
        // builder-compiled SQL).
        qbShareValueKey = null;
    } else if (qbSQL) {
        // Quiet backup: the LLM was unavailable/unusable — use the deterministic
        // Question Builder SQL so the user still gets an answer.
        sqlResult = { sql: qbSQL, method: 'question-builder', explanation: '' };
    } else {
        sqlResult = await generateSQLFromPlan(plan, semanticModel, apdmeResult.derivedMetrics);
    }
    const aiGeneratedSQL = sqlResult.sql; // Keep AI's SQL for reference
    const sqlMethod = sqlResult.method;
    traceStep({
        stepNumber: 6, name: 'SQL Generator', engine: 'sqlGenerator', icon: '⚡',
        status: 'pass',
        summary: directSQL
            ? 'SQL written directly by the LLM from the metadata-only schema'
            : qbSQL
                ? 'LLM unavailable — used the deterministic Question Builder backup'
                : `Generated via ${sqlMethod === 'deterministic' ? 'deterministic rules' : 'AI/LLM fallback'}`,
        details: { method: sqlMethod, sql: aiGeneratedSQL },
    }, _s1);

    // ─── Step 3b: SQL Correction Engine ──────────────────────────
    // Skipped when the Question Builder answered — its SQL is already the
    // hardened, deterministic output.
    reportProgress('Correcting SQL...', 5);
    _s1 = performance.now();
    let currentSQL: string;
    let _correctionStatus: 'pass' | 'warn' | 'skip' = 'pass';
    // Deterministic backup SQL, kept for the safety net so a failed LLM query can
    // fall back to something that always runs.
    let deterministicSQL: string | null = qbSQL;
    if (directSQL) {
        // The LLM answered — this is the SQL we run.
        currentSQL = directSQL;
        _correctionStatus = 'skip';
    } else if (qbSQL) {
        // Quiet backup — deterministic Question Builder SQL.
        currentSQL = qbSQL;
        _correctionStatus = 'skip';
    } else {
        console.log('[Pipeline] Step 3b: LLM unavailable — running deterministic SQL Correction Engine (backup)...');
        try {
            currentSQL = correctSQL(plan, semanticModel, apdmeResult.derivedMetrics);
            deterministicSQL = currentSQL;
            console.log('[Pipeline] Correction Engine SQL:', currentSQL);
        } catch (correctionErr: any) {
            console.warn('[Pipeline] Correction engine failed, using AI SQL:', correctionErr.message);
            currentSQL = aiGeneratedSQL; // Fallback to AI SQL if engine fails
            _correctionStatus = 'warn';
        }
    }
    traceStep({
        stepNumber: 7, name: 'SQL Correction Engine', engine: 'sqlCorrectionEngine', icon: '🔧',
        status: _correctionStatus,
        summary: _correctionStatus === 'skip'
            ? (directSQL ? 'Skipped — the LLM wrote the SQL' : 'Skipped — deterministic backup produced the SQL')
            : _correctionStatus === 'pass'
                ? 'Backup: SQL rebuilt deterministically — verified column names, GROUP BY, aggregations'
                : 'Correction engine failed — using AI-generated SQL as fallback',
        details: { correctedSQL: currentSQL, usedFallback: _correctionStatus === 'warn' },
    }, _s1);

    // Which engine actually produced `currentSQL` — surfaced in the SQL tab.
    // May be downgraded to a deterministic backup below if the LLM SQL won't run.
    let sqlEngine: 'question-builder' | 'llm-sql' | 'correction-engine' | 'llm' =
        directSQL ? 'llm-sql'
            : qbSQL ? 'question-builder'
                : _correctionStatus === 'pass' ? 'correction-engine'
                    : (sqlMethod === 'llm' ? 'llm' : 'correction-engine');

    // Surface fallback reason from the correction engine (e.g., hour grain without time data)
    if ((plan as any)._fallbackReason) {
        sqlResult.explanation = (plan as any)._fallbackReason;
        console.log('[Pipeline] Correction engine set fallback reason:', (plan as any)._fallbackReason);
    }

    // Surface smart default explanation (e.g., "Showing revenue growth by product")
    if ((plan as any)._smartDefaultApplied && (plan as any)._smartDefaultExplanation) {
        const smartNote = (plan as any)._smartDefaultExplanation;
        sqlResult.explanation = smartNote + (sqlResult.explanation ? ` — ${sqlResult.explanation}` : '');
        console.log('[Pipeline] Smart default applied:', smartNote);
    }

    // ─── Step 4: Validate SQL ────────────────────────────────────
    reportProgress('Validating SQL...', 6);
    console.log('[Pipeline] Step 4: Validating SQL...');
    _s1 = performance.now();
    const validation = validateSQL(currentSQL, plan, semanticModel);
    const _failedChecks = validation.checks.filter(c => c.status === 'fail');
    const _warnChecks = validation.checks.filter(c => c.status === 'warn');
    traceStep({
        stepNumber: 8, name: 'SQL Validator', engine: 'sqlValidator', icon: '✅',
        status: _failedChecks.length > 0 ? 'fail' : _warnChecks.length > 0 ? 'warn' : 'pass',
        summary: `${validation.checks.filter(c => c.status === 'pass').length}/${validation.checks.length} checks passed${_failedChecks.length > 0 ? `, ${_failedChecks.length} failed` : ''}`,
        details: { checks: validation.checks },
    }, _s1);

    if (!validation.valid) {
        console.warn('[Pipeline] SQL validation failed:', _failedChecks);
    }

    // ─── Step 5: Execute SQL ─────────────────────────────────────
    reportProgress('Executing SQL...', 7);
    console.log('[Pipeline] Step 5: Executing SQL...');
    _s1 = performance.now();
    let execResult = await executeSQLViaDuckDB(dataset.rows, currentSQL, semanticModel.timeContext, dataset.relatedTables);

    // ─── Step 5b: Repair Loop (max 2 attempts) ──────────────────
    while (execResult.error && repairAttempts < 2) {
        repairAttempts++;
        console.log(`[Pipeline] Step 5b: Repair attempt ${repairAttempts}...`);
        try {
            const repaired = await repairSQL(currentSQL, execResult.error, plan, semanticModel, repairAttempts);
            currentSQL = repaired.sql;
            sqlResult.explanation = repaired.explanation;
            execResult = await executeSQLViaDuckDB(dataset.rows, currentSQL, semanticModel.timeContext, dataset.relatedTables);
        } catch (repairErr: any) {
            console.warn(`[Pipeline] Repair attempt ${repairAttempts} failed:`, repairErr.message);
            break;
        }
    }

    // ─── Step 5b′: Deterministic Safety Net (quiet backup) ──────
    // If the LLM's SQL still won't execute after repair, fall back to the
    // deterministic engines — the Question Builder backup if one was built,
    // otherwise the correction engine — which always produce runnable SQL from
    // the plan. This keeps a failed LLM query from crashing into an error.
    if (execResult.error && directSQL) {
        console.warn('[Pipeline] LLM SQL failed to execute after repair — using the deterministic backup.');
        try {
            const usingQbBackup = !!deterministicSQL;
            const fallbackSQL = deterministicSQL ?? correctSQL(plan, semanticModel, apdmeResult.derivedMetrics);
            const fallbackExec = await executeSQLViaDuckDB(dataset.rows, fallbackSQL, semanticModel.timeContext, dataset.relatedTables);
            if (!fallbackExec.error) {
                currentSQL = fallbackSQL;
                execResult = fallbackExec;
                sqlEngine = usingQbBackup ? 'question-builder' : 'correction-engine';
                console.log(`[Pipeline] Deterministic backup succeeded — engine = ${sqlEngine}.`);
            }
        } catch (fbErr: any) {
            console.warn('[Pipeline] Deterministic fallback also failed:', fbErr?.message);
        }
    }

    if (execResult.error) {
        throw new Error(`SQL execution failed: ${execResult.error}`);
    }

    traceStep({
        stepNumber: 9, name: 'DuckDB Execution', engine: 'duckdbEngine', icon: '🦆',
        status: repairAttempts > 0 ? 'warn' : 'pass',
        summary: `${(execResult.data || []).length} rows returned${repairAttempts > 0 ? ` (after ${repairAttempts} repair attempt${repairAttempts > 1 ? 's' : ''})` : ''}`,
        details: {
            rowCount: (execResult.data || []).length,
            columnCount: (execResult.columns || []).length,
            columns: execResult.columns || [],
            repairAttempts,
            sql: currentSQL,
        },
    }, _s1);

    let rawData = execResult.data || [];
    const columns = execResult.columns || [];

    // Combined LLM token cost: the planner step + the direct-SQL step (0 when the
    // deterministic knobs/correction engine answered). Only LLM calls spend tokens.
    const _planTokens = (plan as any).tokenUsage || { prompt: 0, completion: 0, total: 0 };
    const totalTokenUsage = {
        prompt: _planTokens.prompt || 0,
        completion: _planTokens.completion || 0,
        total: (_planTokens.total || 0) + directSqlTokens,
    };

    // ─── Step 5b′: QB Share-of-Total Table Calculation ───────────
    // When the Question Builder gate mapped a share-of-total question, apply the
    // builder's "% of total" table calc (each group ÷ grand total) — the exact
    // mechanism the click-driven builder uses — producing a pct_of_total column.
    if (qbShareValueKey && rawData.length > 0) {
        const calc = applyTableCalculation(rawData, qbShareValueKey, 'percent_of_total', qbShareValueKey, 'raw', 'pct_of_total');
        rawData = calc.transformedData;
        console.log(`[Pipeline] QB share-of-total: added pct_of_total from "${qbShareValueKey}"`);
    }

    // ─── Step 5c: Time Intelligence Engine ─────────────────────────
    // Post-SQL time intelligence (LAG/running totals computed in JS for consistency).
    // This JS engine computes ALL time intelligence post-SQL:
    //   A) Total period comparison (this year vs last year → growth badge)
    //   B) Trend growth (MoM, QoQ, YoY → LAG emulation)
    //   C) Running totals (cumulative SUM)
    //   D) Moving averages (3-period rolling)

    if (rawData.length > 0) {
        const cols = Object.keys(rawData[0]);

        // ── (A) Total Period Comparison ─────────────────────────────
        // Detect UNION ALL "Current"/"Previous" pattern from comparison queries
        const periodCol = cols.find(c => c.toLowerCase() === 'period');
        if (periodCol && rawData.length === 2) {
            const currentRow = rawData.find(r => String(r[periodCol]).toLowerCase() === 'current');
            const previousRow = rawData.find(r => String(r[periodCol]).toLowerCase() === 'previous');

            if (currentRow && previousRow) {
                const metricCols = cols.filter(c => c !== periodCol && typeof currentRow[c] === 'number');

                if (metricCols.length > 0) {
                    const primaryMetric = metricCols[0];
                    const currentVal = Number(currentRow[primaryMetric]) || 0;
                    const previousVal = Number(previousRow[primaryMetric]) || 0;
                    const diff = currentVal - previousVal;
                    // Guard: division by zero → null (not 0, not Infinity)
                    const rawPct = previousVal !== 0 ? (diff / Math.abs(previousVal)) * 100 : null;
                    const pct = rawPct !== null && isFinite(rawPct) ? rawPct : null;

                    // Enrich both rows with growth data
                    currentRow.growth_pct = pct;
                    currentRow.growth_abs = diff;
                    currentRow.previous_value = previousVal;
                    previousRow.growth_pct = null;
                    previousRow.growth_abs = null;
                    previousRow.previous_value = null;

                    // Store growth on the plan for KPI card rendering
                    (plan as any)._computedGrowth = {
                        currentValue: currentVal,
                        previousValue: previousVal,
                        diff,
                        pct,
                        currentLabel: String(currentRow[periodCol]),
                        previousLabel: String(previousRow[periodCol]),
                        metric: primaryMetric,
                    };

                    console.log(`[Pipeline] Time Intel (A): Total comparison — ${primaryMetric}: ${currentVal.toFixed(2)} vs ${previousVal.toFixed(2)} = ${pct !== null ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%' : 'N/A (no previous data)'}`);
                }
            }
        }

        // ── (B) Trend Growth (LAG emulation) — PARTITIONED ─────────
        // For ANY multi-row result with a time dimension: comparison queries,
        // plain trends, or time-grouped breakdowns.
        // CRITICAL: Growth/running_total/moving_avg are computed WITHIN EACH
        // entity partition (e.g., per product), NOT globally across all rows.
        const hasTimeDim = plan.dimensions.some(d => d.timeGrain);
        if (!periodCol && (plan.comparison || hasTimeDim || ['trend', 'breakdown'].includes(plan.intent)) && rawData.length > 1) {
            const timeDim = plan.dimensions.find(d => d.timeGrain);
            const timeCol = timeDim
                ? (timeDim.timeGrain && timeDim.timeGrain !== 'day'
                    ? `${timeDim.field}_${timeDim.timeGrain}`
                    : timeDim.field)
                : null;

            // Identify NON-time dimension columns for partitioning
            // (e.g., product_name, region, category)
            const partitionCols = cols.filter(k => {
                if (timeCol && k === timeCol) return false;
                if (['previous_value', 'growth_pct', 'growth_abs', 'running_total', 'moving_avg', 'day_name'].includes(k.toLowerCase())) return false;
                if (typeof rawData[0][k] === 'number' || /_(sum|avg|count|min|max)$/.test(k)) return false;
                return true;
            });

            const metricCols = cols.filter(k => {
                if (timeCol && k === timeCol) return false;
                if (partitionCols.includes(k)) return false;
                if (['previous_value', 'growth_pct', 'growth_abs', 'running_total', 'moving_avg'].includes(k.toLowerCase())) return false;
                return typeof rawData[0][k] === 'number' || /_(sum|avg|count|min|max)$/.test(k);
            });

            if (timeCol && metricCols.length > 0) {
                const primaryMetric = metricCols[0];

                // Build partition key from non-time dimensions
                const buildPartitionKey = (row: Record<string, any>): string => {
                    if (partitionCols.length === 0) return '__ALL__';
                    return partitionCols.map(c => String(row[c] ?? '')).join('|||');
                };

                // Group rows by partition key
                const partitions = new Map<string, Record<string, any>[]>();
                for (const row of rawData) {
                    const key = buildPartitionKey(row);
                    if (!partitions.has(key)) partitions.set(key, []);
                    partitions.get(key)!.push(row);
                }

                // Apply time intelligence WITHIN each partition
                for (const [partKey, partRows] of partitions) {
                    // Sort chronologically within this entity
                    partRows.sort((a, b) => String(a[timeCol] || '').localeCompare(String(b[timeCol] || '')));

                    for (let i = 0; i < partRows.length; i++) {
                        const current = Number(partRows[i][primaryMetric]) || 0;

                        // (B) Growth — compared to PREVIOUS row of the SAME entity
                        if (i === 0) {
                            partRows[i].previous_value = null;
                            partRows[i].growth_pct = null;
                            partRows[i].growth_abs = null;
                        } else {
                            const previous = Number(partRows[i - 1][primaryMetric]) || 0;
                            partRows[i].previous_value = previous;
                            partRows[i].growth_abs = current - previous;
                            const rawGrowth = previous !== 0
                                ? ((current - previous) / Math.abs(previous)) * 100
                                : null;
                            partRows[i].growth_pct = rawGrowth !== null && isFinite(rawGrowth) ? rawGrowth : null;
                        }

                        // (C) Running Total — cumulative within this entity only
                        partRows[i].running_total = partRows
                            .slice(0, i + 1)
                            .reduce((sum, r) => sum + (Number(r[primaryMetric]) || 0), 0);

                        // (D) Moving Average (3-period) — within this entity only
                        if (i >= 2) {
                            const window = partRows.slice(i - 2, i + 1);
                            partRows[i].moving_avg = window.reduce((s, r) => s + (Number(r[primaryMetric]) || 0), 0) / 3;
                        } else {
                            partRows[i].moving_avg = null;
                        }
                    }
                }

                // Rebuild rawData from partitions (sorted: by partition, then time)
                rawData.length = 0;
                for (const partRows of partitions.values()) {
                    rawData.push(...partRows);
                }

                console.log(`[Pipeline] Time Intel (B/C/D): Partitioned growth — ${partitions.size} partition(s), ${rawData.length} rows, metric="${primaryMetric}", partitionBy=[${partitionCols.join(', ')}]`);

                // ── (E) Growth Ranking Collapse ─────────────────────
                // For growth-ranking queries (e.g., "which products are growing fastest?"),
                // ── (E) Growth Ranking Collapse — CONFIDENCE-AWARE ──────
                // For growth-ranking queries, collapse multi-row partitioned data
                // to 1 ROW PER ENTITY with its latest growth. Includes:
                // - Entity name normalization (merge duplicates)
                // - Growth quality filtering (exclude unreliable data)
                // - Growth capping (flag extreme % as unstable)
                // Trigger: _growthRanking flag from intent planner (single source of truth)
                const isGrowthRanking = !!(plan as any)._growthRanking;

                if (isGrowthRanking && partitionCols.length > 0 && partitions.size > 1) {

                    // ── STEP E1: Normalize entity names & merge duplicates ──
                    const normalize = (name: string): string =>
                        String(name).toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

                    // Re-group partitions by normalized name
                    const mergedPartitions = new Map<string, Record<string, any>[]>();
                    const normalizedDisplayNames = new Map<string, string>(); // normalized → best display name

                    for (const [, partRows] of partitions) {
                        if (partRows.length === 0) continue;
                        const rawName = String(partRows[0][partitionCols[0]] || '');
                        const normName = normalize(rawName);

                        if (!mergedPartitions.has(normName)) {
                            mergedPartitions.set(normName, []);
                            normalizedDisplayNames.set(normName, rawName); // Keep first seen as display name
                        } else {
                            // Keep the longer/more proper name as display
                            const existing = normalizedDisplayNames.get(normName)!;
                            if (rawName.length > existing.length || /[A-Z]/.test(rawName)) {
                                normalizedDisplayNames.set(normName, rawName);
                            }
                        }
                        mergedPartitions.get(normName)!.push(...partRows);
                    }

                    if (mergedPartitions.size < partitions.size) {
                        console.log(`[Pipeline] Entity normalization: ${partitions.size} → ${mergedPartitions.size} entities (merged duplicates)`);
                    }

                    // ── STEP E2: Compute growth per merged entity ──
                    const collapsed: Record<string, any>[] = [];
                    const MIN_PERIODS = 2;      // Need at least 2 data points for growth
                    const MIN_BASELINE = 100;    // Previous value must be >= $100 for reliable growth
                    const GROWTH_CAP = 300;      // Cap extreme growth at 300%

                    for (const [normName, partRows] of mergedPartitions) {
                        // Re-sort chronologically within merged entity
                        partRows.sort((a, b) => String(a[timeCol] || '').localeCompare(String(b[timeCol] || '')));

                        // Recompute growth within merged entity
                        for (let i = 0; i < partRows.length; i++) {
                            const current = Number(partRows[i][primaryMetric]) || 0;
                            if (i === 0) {
                                partRows[i].growth_pct = null;
                                partRows[i].previous_value = null;
                            } else {
                                const prev = Number(partRows[i - 1][primaryMetric]) || 0;
                                partRows[i].previous_value = prev;
                                partRows[i].growth_pct = prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : null;
                            }
                        }

                        const rowsWithGrowth = partRows.filter(r => r.growth_pct !== null && r.growth_pct !== undefined && isFinite(Number(r.growth_pct)));

                        // ── STEP E3: Quality filter — skip unreliable entities ──
                        if (partRows.length < MIN_PERIODS) {
                            console.log(`[Pipeline] Growth filter: Skipping "${normName}" — only ${partRows.length} period(s), need ${MIN_PERIODS}`);
                            continue;
                        }

                        const latestRow = rowsWithGrowth.length > 0
                            ? rowsWithGrowth[rowsWithGrowth.length - 1]
                            : partRows[partRows.length - 1];

                        const previousValue = Number(latestRow.previous_value) || 0;
                        if (previousValue > 0 && previousValue < MIN_BASELINE && rowsWithGrowth.length > 0) {
                            console.log(`[Pipeline] Growth filter: Skipping "${normName}" — baseline too small ($${previousValue.toFixed(0)}), produces misleading %`);
                            continue;
                        }

                        // ── STEP E4: Compute & cap growth ──
                        let latestGrowth = latestRow.growth_pct !== null ? Number(latestRow.growth_pct) : null;

                        if (latestGrowth !== null && Math.abs(latestGrowth) > GROWTH_CAP) {
                            console.log(`[Pipeline] Growth cap: "${normName}" growth ${latestGrowth.toFixed(0)}% capped to ${latestGrowth > 0 ? '+' : '-'}${GROWTH_CAP}%`);
                            latestGrowth = latestGrowth > 0 ? GROWTH_CAP : -GROWTH_CAP;
                        }

                        const displayName = normalizedDisplayNames.get(normName) || normName;

                        collapsed.push({
                            [partitionCols[0]]: displayName,
                            latest_growth_pct: latestGrowth !== null ? Number(latestGrowth.toFixed(1)) : 0,
                        });
                    }

                    // Sort by growth (descending for "fastest", ascending for "slowest")
                    const isDescending = !/\b(slowest|least|lowest|worst|declining|shrinking)\b/.test((plan.originalQuestion || '').toLowerCase());
                    collapsed.sort((a, b) => {
                        const aVal = a.latest_growth_pct ?? -Infinity;
                        const bVal = b.latest_growth_pct ?? -Infinity;
                        return isDescending ? bVal - aVal : aVal - bVal;
                    });

                    // Apply limit
                    const limit = plan.limit || 10;
                    const finalData = collapsed.slice(0, limit);

                    // Replace rawData with CLEAN collapsed rows (ONLY 2 columns)
                    rawData.length = 0;
                    rawData.push(...finalData);

                    // Generate summary insight
                    if (finalData.length > 0) {
                        const topEntity = finalData[0][partitionCols[0]];
                        const topGrowth = finalData[0].latest_growth_pct;
                        const sign = topGrowth >= 0 ? '+' : '';
                        const grainLabel = plan.comparison?.grain || 'month';
                        (plan as any)._growthInsight = `${topEntity} is growing ${isDescending ? 'fastest' : 'slowest'} at ${sign}${topGrowth}% compared to last ${grainLabel}.`;
                    }

                    // Flag for chart override
                    (plan as any)._growthCollapsed = true;

                    console.log(`[Pipeline] Time Intel (E): Growth ranking — ${mergedPartitions.size} entities → ${finalData.length} reliable rows, columns=[${Object.keys(finalData[0] || {}).join(', ')}]`);
                }
            }
        }
    }

    // ── Empty-aggregate detection ────────────────────────────────
    // A SUM/COUNT(CASE WHEN col = 'value' …) with no matching rows returns a
    // single row of all-NULLs — that's "no data", not a real answer, and it
    // otherwise renders as a confusing blank table. It usually means a value
    // literal in the query doesn't exist in the data (the AI guessed a word).
    // Collapse it to the no-data path and name the likely-wrong values.
    let unmatchedLiterals: string[] = [];
    if (rawData.length > 0 && rawData.every(r => Object.values(r).every(v => v === null || v === undefined))) {
        if (_valueCatalog) {
            const seen = new Set<string>();
            const re = /'((?:[^']|'')*)'/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(currentSQL)) !== null) {
                const raw = m[1].replace(/''/g, "'");
                if (!raw || /^\d{4}-\d{2}-\d{2}/.test(raw) || /^-?\d+(\.\d+)?$/.test(raw)) continue; // skip dates/numbers
                if (seen.has(raw)) continue;
                seen.add(raw);
                if (!_valueCatalog.index.has(raw.toLowerCase())) unmatchedLiterals.push(raw);
            }
        }
        console.warn('[Pipeline] Aggregate returned all-NULL (no matching rows) — treating as no data.', unmatchedLiterals.length ? `Unmatched values: ${unmatchedLiterals.join(', ')}` : '');
        rawData = [];
    }

    if (rawData.length === 0) {
        // Build a helpful no-data message instead of throwing
        const tc = semanticModel.timeContext;
        const periodDesc = resolvedTime?.description
            ? `for ${resolvedTime.description}`
            : plan.filters.length > 0 ? 'for the specified filters' : '';
        const rangeNote = tc
            ? ` The dataset contains data from ${tc.minDate} to ${tc.maxDate}.`
            : '';

        const valueNote = unmatchedLiterals.length > 0
            ? ` These value(s) weren't found in your data: ${unmatchedLiterals.map(v => `"${v}"`).join(', ')}. Check the spelling, or they may be stored in a different column${getEffectivePrivacyMode() === 'strict' ? ' — or switch to "Better answers" mode so the AI can see your real values' : ''}.`
            : '';

        const noDataExplanation = unmatchedLiterals.length > 0
            ? `No matching data found.${valueNote}`
            : `No data found ${periodDesc}.${rangeNote} ` +
              `Try broadening your date range, removing filters, or checking if your data covers this period.`;

        console.warn('[Pipeline] Query returned 0 rows —', noDataExplanation);

        const executionTimeEmpty = performance.now() - startTime;
        return {
            plan,
            sql: currentSQL,
            engine: sqlEngine,
            validation,
            rawData: [],
            chartData: [],
            profile: {
                rowCount: 0, columnCount: 0, metricCount: 0, dimensionCount: 0,
                dimensionColumns: [], metricColumns: [], dimensionCardinality: {},
                hasTimeDimension: false, metricsScaleMismatch: 1, metricSemanticTypes: {},
                isPivoted: false, isSingleValue: false,
            },
            chart: {
                chartType: 'table', xKey: '', yKey: '', useDualAxis: false,
                reason: 'No results — empty dataset for this query'
            },
            confidence: {
                score: 0, level: 'low',
                factors: { semanticMatch: 0, filterClarity: 0, aggregationCertainty: 0, planComplexity: 0, repairAttempts: 0 },
                reasons: ['Query returned 0 rows']
            },
            explanation: noDataExplanation,
            columnsUsed: [
                ...plan.dimensions.map(d => d.field),
                ...plan.metrics.map(m => m.field),
                ...plan.filters.map(f => f.field),
            ].filter((v, i, a) => a.indexOf(v) === i),
            executionTimeMs: Math.round(executionTimeEmpty),
            repairAttempts,
            tokenUsage: totalTokenUsage,
        };
    }

    // ─── Step 6: Validate Result ─────────────────────────────────
    reportProgress('Validating results...', 8);
    console.log('[Pipeline] Step 6: Validating result...');
    const resultChecks = validateResult(rawData, plan, semanticModel);
    validation.checks.push(...resultChecks);

    // ─── Step 6b: Total Consistency Check ──────────────────────────
    // For trend/breakdown: verify that SUM of parts ≈ grand total. Only runs for
    // a plain SUM of a real column — composite / derived / non-SUM metrics have no
    // meaningful grand total and would emit invalid SQL (e.g. NONE(expr)).
    const _pm6b = plan.metrics[0];
    if (['trend', 'breakdown'].includes(plan.intent) && plan.metrics.length > 0 && rawData.length > 1
        && _pm6b.agg === 'sum' && !_pm6b.compositeId && !_pm6b.derivedMetricId) {
        try {
            const primaryMetricField = _pm6b.field;
            const primaryAgg = _pm6b.agg;
            const metricAlias = `${primaryMetricField}_${primaryAgg}`;
            // Sum all values in the result set
            const resultTotal = rawData.reduce((sum, row) => {
                const key = Object.keys(row).find(k => k.toLowerCase() === metricAlias.toLowerCase())
                    || Object.keys(row).find(k => k.toLowerCase().includes(primaryMetricField.toLowerCase()) && typeof row[k] === 'number');
                return sum + (key ? (Number(row[key]) || 0) : 0);
            }, 0);

            // Run a grand total query with the same filters
            const filterClause = plan.filters.length > 0
                ? ' WHERE ' + plan.filters.map(f => {
                    const fop = normalizeFilterOp(f.op);
                    if (fop === 'between' && Array.isArray(f.value)) {
                        return `${f.field} BETWEEN '${f.value[0]}' AND '${f.value[1]}'`;
                    }
                    return `${f.field} ${fop} '${f.value}'`;
                }).join(' AND ')
                : '';
            const grandTotalSQL = `SELECT ${primaryAgg.toUpperCase()}(${primaryMetricField}) AS grand_total FROM data${filterClause}`;
            const grandResult = await executeSQLViaDuckDB(dataset.rows, grandTotalSQL, semanticModel.timeContext);

            if (grandResult.data && grandResult.data.length > 0) {
                const grandTotal = Number(grandResult.data[0].grand_total) || 0;
                if (grandTotal > 0 && primaryAgg === 'sum') {
                    const drift = Math.abs(resultTotal - grandTotal) / grandTotal;
                    if (drift > 0.01) {
                        validation.checks.push({
                            name: 'total_consistency',
                            status: 'warn',
                            message: `Sum of ${metricAlias} in result (${resultTotal.toFixed(2)}) differs from grand total (${grandTotal.toFixed(2)}) by ${(drift * 100).toFixed(1)}%. This may indicate data grouping issues.`,
                        });
                        console.warn(`[Pipeline] TOTAL CONSISTENCY WARNING: result=${resultTotal.toFixed(2)}, grand=${grandTotal.toFixed(2)}, drift=${(drift * 100).toFixed(1)}%`);
                    } else {
                        validation.checks.push({ name: 'total_consistency', status: 'pass', message: 'Sum of parts matches grand total.' });
                    }
                }
            }
        } catch (e) {
            console.warn('[Pipeline] Total consistency check failed:', e);
        }
    }

    // ── Growth Chart Override (BEFORE profiler) ─────────────────
    // Must happen before profiler so the profiler sees only 2 columns
    // (1 dim + 1 metric) instead of the 6+ collapsed columns.
    if ((plan as any)._growthCollapsed && rawData.length > 0) {
        console.log(`[Pipeline] Growth data already clean: ${rawData.length} rows, columns=[${Object.keys(rawData[0]).join(', ')}]`);
    }

    // ─── Step 7: Profile Result ──────────────────────────────────
    reportProgress('Profiling results...', 9);
    console.log('[Pipeline] Step 7: Profiling result...');
    _s1 = performance.now();
    const profile = profileResult(rawData, plan, semanticModel);
    traceStep({
        stepNumber: 10, name: 'Result Profiler', engine: 'resultProfiler', icon: '📊',
        status: 'pass',
        summary: `${profile.rowCount} rows, ${profile.metricCount} metric(s), ${profile.dimensionCount} dim(s), time=${profile.hasTimeDimension}`,
        details: {
            rowCount: profile.rowCount, metricCount: profile.metricCount,
            dimensionCount: profile.dimensionCount, hasTimeDimension: profile.hasTimeDimension,
            dimensionColumns: profile.dimensionColumns, metricColumns: profile.metricColumns,
            scaleMismatch: profile.metricsScaleMismatch,
        },
    }, _s1);
    console.log(`[Pipeline] Profile: ${profile.rowCount} rows, ${profile.metricCount} metrics, ${profile.dimensionCount} dims, time=${profile.hasTimeDimension}, scaleMismatch=${profile.metricsScaleMismatch.toFixed(1)}x`);

    // ─── Step 8: Recommend Chart ─────────────────────────────────
    reportProgress('Selecting chart type...', 10);
    console.log('[Pipeline] Step 8: Recommending chart...');
    _s1 = performance.now();
    const chartRec = recommendChart(profile, plan, semanticModel);
    traceStep({
        stepNumber: 11, name: 'Chart Recommender', engine: 'chartRecommender', icon: '📈',
        status: 'pass',
        summary: `${chartRec.chartType} — ${chartRec.reason}`,
        details: {
            chartType: chartRec.chartType, xKey: chartRec.xKey, yKey: chartRec.yKey,
            useDualAxis: chartRec.useDualAxis, reason: chartRec.reason,
        },
    }, _s1);
    console.log(`[Pipeline] Chart: ${chartRec.chartType} (${chartRec.reason})`);

    // ── Growth Ranking Chart Override ─────────────────────────
    // Force simple bar chart for growth-collapsed data.
    if ((plan as any)._growthCollapsed && rawData.length > 0) {
        const entityCol = Object.keys(rawData[0]).find(k => k !== 'latest_growth_pct');

        if (entityCol) {
            chartRec.chartType = 'bar';
            chartRec.xKey = entityCol;
            chartRec.yKey = 'latest_growth_pct';
            chartRec.useDualAxis = false;
            chartRec.reason = 'Growth ranking → simple bar (entity vs growth %)';
            console.log(`[Pipeline] Growth chart override: bar, x=${entityCol}, y=latest_growth_pct`);
        }

        // Surface growth insight in explanation
        if ((plan as any)._growthInsight) {
            const insight = (plan as any)._growthInsight;
            sqlResult.explanation = insight;
            console.log(`[Pipeline] Growth insight: ${insight}`);
        }
    }

    // ─── Step 9: Reshape Data ────────────────────────────────────
    reportProgress('Reshaping data for chart...', 11);
    console.log('[Pipeline] Step 9: Reshaping data...');
    const reshaped = reshapeData(rawData, profile, chartRec, plan);

    // For growth-collapsed data, force clean reshaped output
    if ((plan as any)._growthCollapsed && rawData.length > 0) {
        reshaped.data = rawData;
        reshaped.chart = chartRec;
    }

    // For share_of_total (donut/pie), strip non-percentage metric columns
    // to prevent the sum column from rendering as a secondary bar/line
    // Use reshaped.chart (post-reshaper) keys, not chartRec (pre-reshaper)
    if (plan.intent === 'share_of_total' && reshaped.chart.yKey) {
        const keepKeys = new Set([reshaped.chart.xKey, reshaped.chart.yKey]);
        reshaped.data = reshaped.data.map((row: any) => {
            const cleaned: any = {};
            for (const key of Object.keys(row)) {
                // Keep dimension, pct metric, and non-numeric fields
                if (keepKeys.has(key) || typeof row[key] !== 'number') {
                    cleaned[key] = row[key];
                }
            }
            return cleaned;
        });
        console.log(`[Pipeline] share_of_total cleanup: kept keys=[${[...keepKeys]}], stripped extra metrics`);
    }

    // ─── Step 10: Score Confidence ───────────────────────────────
    console.log('[Pipeline] Step 10: Scoring confidence...');
    _s1 = performance.now();
    // The Question Builder path is deterministic — score it as such.
    const confidenceMethod: 'deterministic' | 'llm' = (sqlMethod === 'llm' || sqlMethod === 'llm-sql') ? 'llm' : 'deterministic';
    const confidence = scoreConfidence(plan, semanticModel, validation, confidenceMethod, repairAttempts, currentSQL);
    // Apply APDME guardrail penalties (e.g., -50 for SUM on a date column)
    if (apdmeResult.confidencePenalty > 0) {
        confidence.score = Math.max(0, confidence.score - apdmeResult.confidencePenalty);
        confidence.level = confidence.score >= 70 ? 'high' : confidence.score >= 40 ? 'medium' : 'low';
        confidence.reasons.push(...apdmeResult.violations.map(v => v.message));
        console.log(`[Pipeline] APDME penalty applied: -${apdmeResult.confidencePenalty} → ${confidence.score}/100`);
    }
    // Faithfulness penalty: a plan that doesn't verify against the question must
    // not read as high-confidence, even if the SQL ran cleanly.
    {
        const errs = _verification.issues.filter(i => i.severity === 'error').length;
        const warns = _verification.issues.filter(i => i.severity === 'warn').length;
        if (errs || warns) {
            confidence.score = Math.max(0, confidence.score - errs * 30 - warns * 10);
            confidence.level = confidence.score >= 70 ? 'high' : confidence.score >= 40 ? 'medium' : 'low';
            confidence.reasons.push(..._verification.issues.map(i => i.message));
            console.log(`[Pipeline] Verification penalty applied: -${errs * 30 + warns * 10} → ${confidence.score}/100`);
        }
    }
    traceStep({
        stepNumber: 12, name: 'Confidence Scorer', engine: 'confidenceScorer', icon: '🏆',
        status: confidence.level === 'low' ? 'warn' : 'pass',
        summary: `Score: ${confidence.score}/100 (${confidence.level})`,
        details: { score: confidence.score, level: confidence.level, factors: confidence.factors, reasons: confidence.reasons },
    }, _s1);
    console.log(`[Pipeline] Confidence: ${confidence.score}/100 (${confidence.level})`);

    const executionTime = performance.now() - startTime;

    // ─── Step 11: Log Audit Entry ────────────────────────────────
    const auditEntry: AuditEntry = {
        id: `audit_${Date.now()}`,
        timestamp: Date.now(),
        question,
        plan,
        sql: currentSQL,
        executionTimeMs: Math.round(executionTime),
        rowCount: reshaped.data.length,
        confidence,
        chartType: reshaped.chart.chartType,
        repairAttempts,
        resultGrain: plan.resultGrain,
    };
    logAuditEntry(auditEntry);

    console.log(`[AI SQL Pipeline] Complete in ${Math.round(executionTime)}ms`);

    // ─── Build columnsUsed ───────────────────────────────────────
    const columnsUsed = [
        ...plan.dimensions.map(d => d.field),
        ...plan.metrics.map(m => m.field),
        ...plan.filters.map(f => f.field),
    ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

    // ─── Step 10b: Generate Data-Driven Answer ───────────────────
    // Build the explanation from ACTUAL RESULTS, not the plan
    const chartDataForAnswer = reshaped.data.length > 0 ? reshaped.data : rawData;
    const dataAnswer = generateDataDrivenAnswer(question, plan, chartDataForAnswer, semanticModel);
    // Surface ERROR-level faithfulness issues to the user rather than answering
    // silently — the "never a silent wrong answer" guarantee.
    const _vErrors = _verification.issues.filter(i => i.severity === 'error');
    const verificationCaveat = _vErrors.length > 0
        ? ` ⚠️ Heads up: ${_vErrors.map(i => i.message).join(' ')} Please double-check or rephrase.`
        : '';
    const finalExplanation = (dataAnswer || sqlResult.explanation || '') + verificationCaveat;

    // ─── Build Pipeline Trace ─────────────────────────────────────
    const pipelineTrace: PipelineTrace = {
        question,
        totalDurationMs: Math.round(executionTime),
        steps: traceSteps,
    };

    const pipelineResult: AISQLPipelineResult = {
        plan,
        sql: currentSQL,
        engine: sqlEngine,
        validation,
        rawData,
        chartData: reshaped.data,
        profile,
        chart: reshaped.chart,
        confidence,
        explanation: finalExplanation,
        columnsUsed,
        executionTimeMs: Math.round(executionTime),
        repairAttempts,
        trace: pipelineTrace,
        // Surface the exact LLM token cost — the planner step plus the direct-SQL
        // step (0 if the deterministic knobs/correction engine answered). Only LLM
        // calls spend tokens; the deterministic steps are free.
        tokenUsage: totalTokenUsage,
    };


    // ── Step 10c: Generate Trust Verification ─────────────────────
    const trust = generateTrustVerification(pipelineResult);
    pipelineResult.trust = trust;
    console.log(`[Pipeline] Trust: ${trust.status} (${trust.checks.filter(c => c.status === 'pass').length}/${trust.checks.length} checks passed)`);

    return pipelineResult;
}

/**
 * Generate a data-driven natural-language answer from actual query results.
 * This reads the real data and answers the user's question directly.
 */
function generateDataDrivenAnswer(
    question: string,
    plan: import('./types').AnalysisPlan,
    data: Record<string, any>[],
    model: import('./types').SemanticModel
): string | null {
    if (!data || data.length === 0) return null;

    const cols = Object.keys(data[0]);
    const questionLower = question.toLowerCase();

    // Helper: format numbers nicely
    const fmt = (v: any): string => {
        const n = Number(v);
        if (isNaN(n)) return String(v);
        if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        if (Number.isInteger(n)) return n.toLocaleString();
        return n.toFixed(2);
    };

    // Helper: get the display label for a field
    const getLabel = (fieldName: string): string => {
        const f = model.fields.find(fld => fld.name === fieldName);
        return f?.displayLabel || fieldName.replace(/_/g, ' ');
    };

    // Find metric and dimension columns from the data
    const metricCols = cols.filter(c => {
        const val = data[0][c];
        return typeof val === 'number' && !['growth_pct', 'growth_abs', 'previous_value', 'running_total', 'moving_avg'].includes(c);
    });
    const dimCols = cols.filter(c => !metricCols.includes(c) && !['growth_pct', 'growth_abs', 'previous_value', 'running_total', 'moving_avg', 'period'].includes(c));

    // ── Case 1: Single KPI (1 row, 1 metric) ───────────────────
    if (data.length === 1 && metricCols.length >= 1 && dimCols.length === 0) {
        const metric = metricCols[0];
        const value = data[0][metric];
        const label = getLabel(metric.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));
        return `The ${label} is ${fmt(value)}.`;
    }

    // ── Case 2: Ranking / Top-N / "Which is the best/highest/top" ──
    if ((plan.intent === 'ranking' || /\b(top|best|highest|most|largest|biggest|greatest|leading|#1)\b/.test(questionLower))
        && data.length >= 1 && dimCols.length >= 1 && metricCols.length >= 1) {
        const topRow = data[0];
        const entityCol = dimCols[0];
        const metricCol = metricCols[0];
        const entity = topRow[entityCol];
        const value = topRow[metricCol];
        const metricLabel = getLabel(metricCol.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));
        const entityLabel = getLabel(entityCol);

        if (data.length === 1) {
            return `${entity} is the top ${entityLabel} with ${fmt(value)} ${metricLabel}.`;
        }

        // Show top result and runner-up
        const runnerUp = data[1];
        const runnerEntity = runnerUp[entityCol];
        const runnerValue = runnerUp[metricCol];
        return `${entity} leads with ${fmt(value)} ${metricLabel}, followed by ${runnerEntity} at ${fmt(runnerValue)}.`;
    }

    // ── Case 3: "Lowest / worst / least / bottom" ──────────────
    if (/\b(bottom|worst|lowest|least|smallest|fewest|minimum)\b/.test(questionLower)
        && data.length >= 1 && dimCols.length >= 1 && metricCols.length >= 1) {
        const lastRow = data[data.length - 1];
        const entityCol = dimCols[0];
        const metricCol = metricCols[0];
        const entity = lastRow[entityCol];
        const value = lastRow[metricCol];
        const metricLabel = getLabel(metricCol.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));
        return `${entity} has the lowest ${metricLabel} at ${fmt(value)}.`;
    }

    // ── Case 4: Trend — summarize latest data point ────────────
    if (plan.intent === 'trend' && data.length > 1 && metricCols.length >= 1) {
        const latestRow = data[data.length - 1];
        const metricCol = metricCols[0];
        const timeDim = dimCols.find(c => plan.dimensions.some(d => c.includes(d.field))) || dimCols[0];
        const latestValue = latestRow[metricCol];
        const latestPeriod = timeDim ? latestRow[timeDim] : null;
        const metricLabel = getLabel(metricCol.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));

        const growth = latestRow.growth_pct;
        let trendNote = '';
        if (growth !== null && growth !== undefined && isFinite(Number(growth))) {
            const g = Number(growth);
            trendNote = g >= 0
                ? `, up ${g.toFixed(1)}% from the previous period`
                : `, down ${Math.abs(g).toFixed(1)}% from the previous period`;
        }

        return `The latest ${metricLabel}${latestPeriod ? ' for ' + latestPeriod : ''} is ${fmt(latestValue)}${trendNote}.`;
    }

    // ── Case 5: Comparison (Current vs Previous) ──────────────
    if (plan.intent === 'total_comparison' && data.length === 2) {
        const periodCol = cols.find(c => c.toLowerCase() === 'period');
        if (periodCol && metricCols.length >= 1) {
            const currentRow = data.find(r => String(r[periodCol]).toLowerCase() === 'current');
            const previousRow = data.find(r => String(r[periodCol]).toLowerCase() === 'previous');
            if (currentRow && previousRow) {
                const metric = metricCols[0];
                const curr = Number(currentRow[metric]);
                const prev = Number(previousRow[metric]);
                const metricLabel = getLabel(metric.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));
                const diff = curr - prev;
                const pct = prev !== 0 ? ((diff / Math.abs(prev)) * 100).toFixed(1) : 'N/A';
                const direction = diff >= 0 ? 'increased' : 'decreased';
                return `${metricLabel} ${direction} from ${fmt(prev)} to ${fmt(curr)} (${diff >= 0 ? '+' : ''}${pct}%).`;
            }
        }
    }

    // ── Case 6: General breakdown with data ────────────
    if (dimCols.length >= 1 && metricCols.length >= 1 && data.length > 1) {
        const topRow = data[0];
        const entityCol = dimCols[0];
        const metricCol = metricCols[0];
        const entity = topRow[entityCol];
        const value = topRow[metricCol];
        const metricLabel = getLabel(metricCol.replace(/_(sum|avg|count|count_distinct|min|max)$/i, ''));
        const entityLabel = getLabel(entityCol);
        return `Across ${data.length} ${entityLabel} categories, ${entity} has the highest ${metricLabel} at ${fmt(value)}.`;
    }

    // Fallback: return null to use the plan-based explanation
    return null;
}
