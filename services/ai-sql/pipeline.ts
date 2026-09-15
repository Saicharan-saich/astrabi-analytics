/**
 * AI SQL Pipeline Orchestrator
 *
 * Wires together the entire enterprise AI SQL architecture into a single
 * `runAISQLPipeline()` function. This is the main entry point used by
 * AISQLView.tsx.
 *
 * Full pipeline:
 * 1. Build Semantic Model → from dataset
 * 2. Generate Analysis Plan → local semantic classifier and typed plan
 * 3. Generate SQL → deterministic compiler, with governed LLM fallback
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
import { resolveAISQLSemanticModel } from './semanticLayer';
import { generateLocalPlan } from './intentPlanner';
import { generateSQLFromPlan, repairSQL } from './sqlGenerator';
import { correctSQL, normalizeFilterOp } from './sqlCorrectionEngine';
import { validateSQL, validateResult } from './sqlValidator';
import { AISQLPipelineError, type AISQLPipelineFailureKind } from './pipelineError';
import { buildTraceStory } from './traceStory';
import { buildResultNarrative } from './resultNarrative';
import { executeSQLViaDuckDB } from '../duckdbEngine';
import { profileResult } from './resultProfiler';
import { recommendChart } from './chartRecommender';
import { reshapeData } from './dataReshaper';
import { scoreConfidence } from './confidenceScorer';
import { logAuditEntry } from './auditLogger';
import { resolveTimeContext } from './timeResolver';
import { processPlan } from './derivedMetricEngine';
import { formatSQL } from '../sqlFormatter';
import { generateTrustVerification } from './trustEngine';
import { mapPlanToQBConfig } from './qbMapper';
import { buildQueryPlan } from '../queryPlan/buildQueryPlan';
import { compileSQL } from '../queryPlan/sqlCompiler';
import { getDates } from '../dateHelpers';
import { applyTableCalculation } from '../../utils/tableCalculations';
import { buildNoDataExplanation } from './noDataExplanation';
import {
    auditSqlLiterals,
    auditSqlPredicateProvenance,
    buildValueCatalog,
    groundFilters,
    groundQuestionLiterals,
    groundSqlLiterals,
    removeUnsupportedTopLevelPredicates,
} from './valueGrounding';
import { verifyPlan } from './planVerification';
// ─── Ambiguity Intelligence Layer ────────────────────────────────
import { detectAmbiguities } from './ambiguityDetector';
import { applyResolvedAmbiguitiesToPlan, resolveAmbiguities } from './ambiguityResolver';
import { resolveLocalStatistics } from './localStatisticsResolver';
import { generateCandidatePlans } from './candidatePlanGenerator';
import { rankPlans } from './planRanker';
import { buildAssumptions } from './assumptionRegistry';
import { validateAnswerContract } from './answerContractValidator';
import { detectAntiJoin, buildAntiJoinSQL } from './antiJoin';
import {
    applyQuerySpecToAnalysisPlan,
    generateDirectSQL,
    normalizeQuerySpecOutputFields,
    repairSemanticSQL,
    type DynamicQuerySpec,
} from './directSqlEngine';
import { serializeSemanticModelSchema, collectSafeDomains } from './schemaSerializer';
import { describeSchemaForLLM, discoverJoinContext } from './joinEngine';
import { getEffectivePrivacyMode, type PrivacyMode } from './privacyMode';
import { getSelection, applySelection } from './privacySelection';
import {
    buildQueryContract,
    normalizeResultToContract,
    validateResultAgainstContract,
    validateSQLAgainstContract,
    type QueryContract,
} from './queryContract';
import {
    buildCanonicalQueryIntent,
    reconcilePlanWithCanonicalIntent,
    type CanonicalQueryIntent,
} from './canonicalIntent';
import {
    buildAnalyticalIR,
    verifyAnalyticalIR,
    type AnalyticalIR,
    type IRVerificationIssue,
} from './analyticalIR';
import { validateAnalyticalResult } from './analyticalResultValidator';
import { compileAnalyticalIRToSQL } from './analyticalSqlAst';
import { canCompileTotalPeriodComparisonLocally } from './deterministicRouting';
import { getAISQLEngineConfig } from './engineConfig';
import { detectBroadScopeQuestion } from './scopeIntent';

/**
 * Benchmark runs preserve the model-owned route so published evaluations stay
 * comparable. Interactive questions use the proven typed/local compilers when
 * they support the requested shape and escalate only the unresolved work.
 */
function modelOwnsSQLForRun(requestPurpose?: 'benchmark'): boolean {
    return requestPurpose === 'benchmark';
}

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

export interface PipelineExecutionOptions {
    /** Enables the separately audited, admin-only Benchmark Lab LLM budget. */
    requestPurpose?: 'benchmark';
    /**
     * Run-scoped privacy choice for the embedded, synthetic benchmark fixtures.
     * Ignored outside Benchmark Lab so ordinary callers can never bypass the
     * user's consent-governed effective privacy mode.
     */
    privacyModeOverride?: PrivacyMode;
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
    forceRefresh?: boolean,
    executionOptions?: PipelineExecutionOptions,
): Promise<AISQLPipelineResult> {
    const startTime = performance.now();
    const effectivePrivacyMode: PrivacyMode = executionOptions?.requestPurpose === 'benchmark'
        && executionOptions.privacyModeOverride
        ? executionOptions.privacyModeOverride
        : getEffectivePrivacyMode();
    // Snapshot the global configuration once so an in-flight query cannot
    // change behaviour halfway through if an admin saves new settings.
    const engineConfig = getAISQLEngineConfig().engines;
    const modelOwnsSQL = modelOwnsSQLForRun(executionOptions?.requestPurpose);
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

    const broadScope = detectBroadScopeQuestion(question);
    if (broadScope.needsClarification) {
        throw new AISQLPipelineError(
            'clarification_required',
            broadScope.reason || 'Choose a dataset overview, all records, or a focused metric and grouping.',
        );
    }

    if (externalFilters?.length) {
        console.log(`[Pipeline] ${externalFilters.length} external filter(s) provided from UI`);
    }

    // ─── Step 1: Load the upload-time Semantic Model ─────────────
    // ETL and semantic profiling belong to the dataset lifecycle, not the
    // question lifecycle. A revision mismatch is the only reason to rebuild.
    reportProgress('Loading semantic model...', 1);
    let _s1 = performance.now();
    const semanticResolution = resolveAISQLSemanticModel(dataset);
    const semanticModel = semanticResolution.model;
    console.log(`[Pipeline] Step 1: ${semanticResolution.reused ? 'Reusing cached' : 'Rebuilt stale/missing'} semantic model (${semanticResolution.revision})`);
    const _metrics = semanticModel.fields.filter(f => f.role === 'metric').length;
    const _dims = semanticModel.fields.filter(f => f.role === 'dimension').length;
    traceStep({
        stepNumber: 1, name: 'Semantic Model', engine: 'semanticLayer', icon: '🧠',
        status: 'pass',
        summary: `${semanticResolution.reused ? 'Reused upload-time model' : 'Rebuilt stale/missing model'} · ${semanticModel.fields.length} fields → ${_metrics} metrics, ${_dims} dimensions, ${semanticModel.compositeMetrics.length} composite`,
        details: {
            revision: semanticResolution.revision,
            reused: semanticResolution.reused,
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
    const resolvedTime = engineConfig.timeResolver
        ? resolveTimeContext(question, semanticModel)
        : { filter: null, matchedPhrase: null, description: null };
    traceStep({
        stepNumber: 2, name: 'Time Resolver', engine: 'timeResolver', icon: '⏰',
        status: resolvedTime.filter ? 'pass' : 'skip',
        summary: !engineConfig.timeResolver
            ? 'Disabled by the global AI SQL engine configuration'
            : resolvedTime.filter
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

    // ─── Step 1c: Value Catalog + governed fallback preparation ───
    const joinCtx = engineConfig.relationshipGraph
        ? discoverJoinContext(dataset.relatedTables, dataset.sourceSchema)
        : null;
    let _valueCatalog: ReturnType<typeof buildValueCatalog> | null = null;
    if (engineConfig.valueGrounding) {
        try {
            _valueCatalog = buildValueCatalog(dataset.rows, semanticModel, 60, dataset.relatedTables);
        } catch (cErr: any) {
            console.warn('[Pipeline] Value catalog build skipped:', cErr?.message);
        }
    }

    const _directSqlStart = performance.now();
    let directSchemaText = '';
    let activeQueryContract: QueryContract | undefined;
    let activeCanonicalIntent: CanonicalQueryIntent | undefined;
    let activeAnalyticalIR: AnalyticalIR | undefined;
    let analyticalIRIssues: IRVerificationIssue[] = [];
    // The hybrid path deliberately starts with the local semantic engines, then
    // asks a selected GPT-5.6 model to write plan-constrained SQL. The LLM never
    // receives dataset rows; local DuckDB remains the only execution engine.
    const runHybridSql = async (
        plannerIssues: Array<{ code?: string; severity?: string; message?: string }> = [],
    ): Promise<{ sql: string | null; tokens: number; model?: string; error: string | null; blocked?: boolean; failureKind?: AISQLPipelineFailureKind; querySpec?: DynamicQuerySpec }> => {
        try {
            if (!engineConfig.privacyGateway) {
                return { sql: null, tokens: 0, error: 'AI SQL paused by admin: the privacy gateway is disabled.', blocked: true };
            }
            if (!engineConfig.llmSqlWriter) {
                return { sql: null, tokens: 0, error: 'AI SQL paused by admin: the LLM plan and SQL writer is disabled.', blocked: true };
            }
            // Privacy mode gates what the LLM may see. Strict = metadata only, no
            // data values leave the browser. Enhanced = also send bounded category
            // domains (non-sensitive, low-cardinality; PII, identifiers and
            // sensitive categoricals excluded). Rows are never sent in either.
            const privacyMode = effectivePrivacyMode;
            // The automatic filter decides what is eligible; the user's own
            // per-column and per-value choices then subtract from that.
            let domains = privacyMode === 'enhanced' && engineConfig.semanticLayer
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
            const baseSchemaText = engineConfig.semanticLayer
                ? serializeSemanticModelSchema(semanticModel, 'data', domains)
                : `Table "data" (physical schema only):\n${dataset.columns.map(column => `- "${column.name}" ${column.originalType || column.type}`).join('\n')}\nSemantic roles, business meanings, units and aggregation rules are intentionally disabled for this run.`;
            let richSchema = baseSchemaText;

            // When the source had several tables, describe those too. The
            // flattened "data" table can double-count after a one-to-many join,
            // so the model is told it may query the real tables and join them
            // itself, at the correct grain.
            if (joinCtx) {
                richSchema += `\n\nThis dataset came from several tables. "data" is a pre-joined, flattened copy — convenient, but a one-to-many join means totals over it can be double-counted. The original tables are also available and are the safer choice when a question spans more than one of them:\n\n${joinCtx.description}`;
                console.log(`[Pipeline] Multi-table schema shared: ${joinCtx.tableNames.join(', ')}`);
                const primaryTable = dataset.relatedTables?.[0]?.name || joinCtx.tableNames[0];
                // Rebuild from the base schema so the authoritative physical
                // table contract cannot coexist with an obsolete flattened-
                // table hint from older upload flows.
                richSchema = `${baseSchemaText}\n\nMULTI-TABLE CONTRACT:\n- The DuckDB table "data" contains ONLY the rows and columns of primary table "${primaryTable}"; it is not a pre-joined copy.\n- All physical tables are independently queryable. If a requested field, filter, entity, or existence test belongs to another table, use the physical table names and the listed relationship path.\n- Never use "data" as a substitute for a related table. Never infer that a missing related record can be found by grouping "data" alone.\n- For "no", "without", "never", or "not a single" related record, preserve the complete entity population and use NOT EXISTS, LEFT JOIN ... IS NULL, or EXCEPT.\n\n${joinCtx.description}`;
            }
            richSchema += `\n\nEXECUTION AND PRIVACY CONTRACT:\n- SQL dialect: DuckDB. Only one read-only SELECT/WITH query is allowed.\n- Execution occurs locally in browser DuckDB-WASM; the model never executes SQL and never receives result rows.\n- Privacy mode: ${privacyMode}.\n- Shared context: ${domains ? 'schema metadata plus only the explicitly approved, non-sensitive categorical domains shown above' : engineConfig.semanticLayer ? 'schema and semantic metadata only; no dataset values' : 'physical schema names and types only; no semantic enrichment and no dataset values'}.\n- User-typed literals may appear in the question/plan. Never invent an unseen literal; preserve grounded spelling and casing when supplied.\n- PII, identifiers, sensitive categorical values and transaction rows are not available to the model.`;
            directSchemaText = richSchema;
            // Build one shared, deterministic contract before any model writes
            // SQL. This unifies entity intent, query grain, relationship paths,
            // aggregation, ranking and negative-existence semantics instead of
            // allowing each model/engine to reinterpret them independently.
            if (!activeQueryContract) {
                activeQueryContract = buildQueryContract(
                    question,
                    plan,
                    plannerIssues,
                    semanticModel,
                    joinCtx ? { tables: joinCtx.tables, links: joinCtx.links } : undefined,
                );
                activeCanonicalIntent = buildCanonicalQueryIntent(activeQueryContract);
                activeAnalyticalIR = buildAnalyticalIR(question, plan, semanticModel, activeQueryContract, activeCanonicalIntent);
                analyticalIRIssues = verifyAnalyticalIR(activeAnalyticalIR);
            }
            // Preserve the dataset-relative reporting clock even on the
            // approved direct-SQL fallback. Relative terms must never resolve
            // against the browser/server wall clock for historical datasets.
            const anchorDate = semanticModel.timeContext?.anchorDate || semanticModel.timeContext?.maxDate;
            const anchoredQuestion = anchorDate
                ? `${question}\n\nDataset reporting anchor: ${anchorDate}. Interpret relative dates such as "this month" against this dataset anchor, and use date literals rather than CURRENT_DATE, NOW(), or CURRENT_TIMESTAMP.`
                : question;
            const explicitUIConstraints = externalFilters?.length
                ? `\n\nExplicit filters selected by the user in the interface (mandatory factual constraints):\n${JSON.stringify(externalFilters, null, 2)}`
                : '';
            // The selected GPT-5.6 planner receives the complete question and
            // verified data facts, but no local NLP interpretation and no rows.
            const ds = await generateDirectSQL(
                `${anchoredQuestion}${explicitUIConstraints}`,
                richSchema,
                // The LLM reads the complete question itself. Local NLP plans,
                // contracts and analytical IR are deliberately excluded from
                // this route because they are interpretations, not schema facts.
                undefined,
                undefined,
                engineConfig.semanticLayer ? semanticModel : undefined,
                executionOptions?.requestPurpose,
                undefined,
                undefined,
            );
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
                // Literal grounding may correct the spelling/casing of a value
                // already supplied by the user. No deterministic engine is
                // allowed to rewrite the SQL structure authored by the model.
                console.log('[Pipeline] Direct-SQL engine SQL:', sql);
                return { sql, tokens: ds.tokens || 0, model: ds.model, error: null, querySpec: ds.querySpec };
            }
            console.warn('[Pipeline] Direct-SQL not usable:', ds.error || 'empty SQL');
            return {
                sql: null,
                tokens: ds.tokens || 0,
                model: ds.model,
                error: ds.error || 'empty SQL',
                blocked: ds.blocked,
                failureKind: ds.failureKind,
                querySpec: ds.querySpec,
            };
        } catch (dErr: any) {
            const msg = dErr?.message || String(dErr);
            console.warn('[Pipeline] Direct-SQL fallback failed:', msg);
            return { sql: null, tokens: 0, error: msg };
        }
    };

    // ─── Step 2: Generate Analysis Plan ─────────────────────────────
    // A typed, local plan is the normal path. It preserves the dataset-relative
    // reporting anchor and is compiled locally; no row data or question text is
    // sent to an LLM for questions the governed compiler can represent.
    reportProgress('Asking the AI...', 3);
    _s1 = performance.now();
    // The governed path starts with the deterministic planner. It understands
    // the dataset-relative reporting anchor and lets the typed QueryPlan compiler
    // answer ordinary questions without sending any data or question to an LLM.
    const _dsEarly = { sql: null as string | null, tokens: 0, model: undefined as string | undefined, error: 'Deferred until deterministic compilation is unavailable' };
    // Preserve the complete wording for intent detection. Replacing only one
    // relative phrase in a two-period question (for example replacing "last
    // month" inside "this month vs last month") destroys the comparison cue
    // and can turn a SUM comparison into a raw-row projection. The concrete
    // resolved range is injected below after the comparison-aware plan exists.
    let plan = generateLocalPlan(question, semanticModel, grainOverride);
    console.log('[Pipeline] Step 2: Local compatibility plan built for diagnostics only');
    traceStep({
        stepNumber: 3, name: 'Intent Planner', engine: 'intentPlanner', icon: '🎯',
        status: plan.ambiguous ? 'warn' : 'pass',
        summary: `Non-authoritative local audit (0 tokens) — the LLM independently interprets the full question`,
        details: {
            intent: plan.intent,
            dimensions: plan.dimensions.map(d => ({ field: d.field, grain: d.timeGrain || null })),
            metrics: plan.metrics.map(m => ({ field: m.field, agg: m.agg })),
            filters: plan.filters.map(f => ({ field: f.field, op: f.op, value: f.value })),
            sort: plan.sort,
            limit: plan.limit,
            resultGrain: plan.resultGrain,
            ambiguous: plan.ambiguous,
            plannerCallSkipped: true,
            semanticAuthority: false,
        },
    }, _s1);

    // Inject the pre-resolved time filter if the local plan did not include one
    if (resolvedTime.filter) {
        const dateField = resolvedTime.filter.field.toLowerCase();
        const hasDateFilter = plan.filters.some(f =>
            f.field.toLowerCase() === dateField && f.op === 'between'
        );
        if (!hasDateFilter) {
            // Remove any unresolved relative-time filters before adding the concrete range
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
    if (engineConfig.valueGrounding) try {
        if (!_valueCatalog) throw new Error('value catalog unavailable');
        // Resolve only literals already typed by the user across every physical
        // table. This local lookup is not capped by domain cardinality and does
        // not expose a value catalogue or any unseen dataset value.
        const literalGrounding = groundQuestionLiterals(
            question,
            dataset.rows,
            dataset.relatedTables,
            plan,
        );
        if (literalGrounding.added.length > 0) {
            plan.filters.push(...literalGrounding.added);
            console.log(`[Pipeline] Exact literal grounding recovered ${literalGrounding.added.length} filter(s): ${literalGrounding.added.map(filter => `${filter.grounding?.table ? `${filter.grounding.table}.` : ''}${filter.field} ${filter.op} ${JSON.stringify(filter.value)}`).join(', ')}`);
        }
        if (literalGrounding.ambiguous.length > 0) {
            console.warn(`[Pipeline] Exact literal grounding left ${literalGrounding.ambiguous.length} ambiguous user-supplied literal(s) unresolved.`);
        }

        const entityNames = [
            ...(joinCtx?.tableNames || []),
            ...semanticModel.fields
                .filter(field => field.semanticType === 'identifier' || /(?:^|_)id$/i.test(field.name))
                .map(field => field.name.replace(/(?:^|_)(?:id|key|code)$/i, '')),
        ];
        const grounded = groundFilters(question, _valueCatalog, plan, semanticModel, { entityNames });
        if (grounded.added.length > 0) {
            plan.filters.push(...grounded.added);
            console.log(`[Pipeline] Value grounding recovered ${grounded.added.length} filter(s): ${grounded.added.map(f => `${f.field} ${f.op} ${JSON.stringify(f.value)}`).join(', ')}`);
        }
        if (grounded.setLogicFields.length > 0) {
            console.log(`[Pipeline] Value grounding: set-logic detected on [${grounded.setLogicFields.join(', ')}] — left for the anti-join knob, not grounded as a filter.`);
        }
    } catch (gErr: any) {
        console.warn('[Pipeline] Value grounding skipped:', gErr?.message);
    } else {
        console.log('[Pipeline] Value grounding disabled by the global AI SQL engine configuration');
    }

    // ─── Step 2b″: Plan Verification (faithfulness gate) ─────────
    // Deterministic invariant checks: does the plan actually represent the
    // question? Surfaces dropped filters / wrong metric / missing ranking so a
    // mismatch becomes a flagged, low-confidence answer instead of a silent
    // wrong one.
    let _verification = engineConfig.planVerification
        ? verifyPlan(question, plan, semanticModel, _valueCatalog || undefined)
        : { ok: true, issues: [] };
    if (_verification.issues.length > 0) {
        console.warn(`[Pipeline] Plan verification: ${_verification.issues.length} issue(s) — ${_verification.issues.map(i => `[${i.severity}] ${i.code}`).join(', ')}`);
    }
    traceStep({
        stepNumber: 4, name: 'Plan Verification', engine: 'planVerification', icon: '🔎',
        status: !engineConfig.planVerification ? 'skip' : _verification.ok ? (_verification.issues.length ? 'warn' : 'pass') : 'fail',
        summary: !engineConfig.planVerification
            ? 'Disabled by the global AI SQL engine configuration'
            : _verification.issues.length === 0
            ? 'Local compatibility audit found no conflicts (advisory only)'
            : `${_verification.issues.length} local compatibility issue(s), supplied only as audit evidence`,
        details: { ok: _verification.ok, issues: _verification.issues, semanticAuthority: false },
    }, performance.now());

    // ─── Step 2c: Pre-Execution Ambiguity Gate ───────────────────
    // Ambiguity evidence must influence the executable plan. The previous
    // post-execution pass could disclose assumptions, but it was too late to
    // prevent the wrong SQL from running.
    let preExecutionAmbiguity: {
        detection: ReturnType<typeof detectAmbiguities>;
        resolution: Awaited<ReturnType<typeof resolveAmbiguities>>;
        ranking: ReturnType<typeof rankPlans>;
        assumptions: ReturnType<typeof buildAssumptions>;
        localStats: Awaited<ReturnType<typeof resolveLocalStatistics>>;
    } | null = null;

    if (engineConfig.ambiguityResolver) try {
        const domainName = dataset.domainProfile?.domain || undefined;
        const detection = detectAmbiguities(question, semanticModel, domainName);

        if (detection.totalCount > 0) {
            const datasetIdentity = dataset.id || dataset.name || semanticModel.datasetName || 'data';
            const localStats = await resolveLocalStatistics(datasetIdentity, semanticModel);
            const resolution = await resolveAmbiguities(
                detection,
                semanticModel,
                localStats,
                domainName,
                question,
                plan
            );
            const candidates = generateCandidatePlans(
                question,
                semanticModel,
                resolution.resolved,
                localStats
            );
            const ranking = rankPlans(candidates, question, semanticModel, localStats, domainName);
            const selectedPlan = ranking.rankedPlans.find(candidate => candidate.isRecommended)
                || ranking.rankedPlans[0];
            const assumptions = buildAssumptions(question, resolution.resolved, selectedPlan);

            preExecutionAmbiguity = {
                detection,
                resolution,
                ranking,
                assumptions,
                localStats,
            };

            if (resolution.needsUserInput && ranking.recommendation === 'ask_user') {
                const material = resolution.unresolved[0]
                    || resolution.resolved.find(item => item.needsUserConfirmation);
                const options = material?.candidates
                    .slice(0, 3)
                    .map(candidate => candidate.label)
                    .join(', ');
                plan.ambiguous = true;
                plan.clarificationQuestion = material
                    ? `To answer accurately, what should "${material.phrase}" mean${options ? ` — ${options}?` : '?'}`
                    : plan.clarificationQuestion || 'Please clarify the intended interpretation.';
                console.log('[Pipeline] Material ambiguity requires user confirmation before SQL execution');
            } else {
                plan = applyResolvedAmbiguitiesToPlan(plan, resolution);
                // Validate the plan that will actually be compiled, not the
                // pre-resolution draft.
                if (engineConfig.planVerification) {
                    _verification = verifyPlan(question, plan, semanticModel, _valueCatalog || undefined);
                }
                console.log(`[Pipeline] Applied ${resolution.autoResolvedCount} evidence-backed ambiguity resolution(s) before SQL generation`);
            }

            traceStep({
                stepNumber: 4,
                name: 'Pre-Execution Ambiguity Gate',
                engine: 'ambiguityResolver',
                icon: '🔍',
                status: plan.ambiguous ? 'warn' : 'pass',
                summary: plan.ambiguous
                    ? 'A material interpretation needs confirmation before execution'
                    : `${resolution.autoResolvedCount} ambiguity assumption(s) applied to the executable plan`,
                details: {
                    ambiguities: detection.ambiguities.map(item => ({
                        type: item.type,
                        phrase: item.phrase,
                        materiality: item.materiality,
                    })),
                    recommendation: ranking.recommendation,
                    confidenceGap: ranking.confidenceGap,
                    appliedFilters: plan.filters,
                },
            }, performance.now());
        }
    } catch (ambiguityError: any) {
        // Preserve the existing governed planner as a compatibility fallback,
        // but never claim that ambiguity evidence was applied.
        console.warn('[Pipeline] Pre-execution ambiguity gate unavailable:', ambiguityError?.message);
    } else {
        traceStep({
            stepNumber: 4,
            name: 'Pre-Execution Ambiguity Gate',
            engine: 'ambiguityResolver',
            icon: '🔍',
            status: 'skip',
            summary: 'Disabled by the global AI SQL engine configuration',
            details: { disabledByAdmin: true },
        }, performance.now());
    }

    // ─── Step 2c: APDME — Derived Metrics & Guardrails ─────────────
    // Semantic enrichment must finish before the canonical meaning is frozen.
    // Previously APDME ran after the contract and IR had already been built,
    // allowing derived metrics and the downstream SQL plan to disagree with
    // the supposedly authoritative IR.
    reportProgress('Analyzing derived metrics...', 3);
    console.log('[Pipeline] Step 2c: Running APDME (Derived Metric Engine)...');
    _s1 = performance.now();
    const apdmeResult = engineConfig.derivedMetricGuardrails
        ? processPlan(plan, semanticModel)
        : {
            plan,
            derivedMetrics: [],
            violations: [],
            confidencePenalty: 0,
            derivedMetricApplied: false,
        };
    plan = apdmeResult.plan;
    traceStep({
        stepNumber: 4, name: 'APDME Guardrails', engine: 'derivedMetricEngine', icon: '🛡️',
        status: !engineConfig.derivedMetricGuardrails ? 'skip' : apdmeResult.violations.length > 0 ? 'warn' : 'pass',
        summary: !engineConfig.derivedMetricGuardrails
            ? 'Disabled by the global AI SQL engine configuration'
            : apdmeResult.derivedMetricApplied
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

    // Freeze the enriched local plan as evidence. Canonical reconciliation is
    // now diagnostic-only: it may expose a conflict for the model/reviewer, but
    // it must never mutate the question plan or pre-solve the SQL.
    activeQueryContract = buildQueryContract(
        question,
        plan,
        _verification.issues,
        semanticModel,
        joinCtx ? { tables: joinCtx.tables, links: joinCtx.links } : undefined,
    );
    activeCanonicalIntent = buildCanonicalQueryIntent(activeQueryContract);
    const canonicalReconciliation = engineConfig.canonicalAudit
        ? reconcilePlanWithCanonicalIntent(plan, activeCanonicalIntent)
        : { plan, changes: [] };
    if (engineConfig.planVerification) {
        _verification = verifyPlan(question, plan, semanticModel, _valueCatalog || undefined);
    }
    activeAnalyticalIR = buildAnalyticalIR(
        question,
        plan,
        semanticModel,
        activeQueryContract,
        activeCanonicalIntent,
        apdmeResult.derivedMetrics,
    );
    analyticalIRIssues = engineConfig.canonicalAudit ? verifyAnalyticalIR(activeAnalyticalIR) : [];
    const requiresAdvancedSql = activeCanonicalIntent.analyticOperations.length > 0;
    if (canonicalReconciliation.changes.length) {
        console.log(`[Pipeline] Canonical audit found ${canonicalReconciliation.changes.length} advisory structural conflict(s): ${canonicalReconciliation.changes.join('; ')}`);
    }
    traceStep({
        stepNumber: 4,
        name: 'Canonical Analytical IR',
        engine: 'analyticalIR',
        icon: '🧭',
        status: !engineConfig.canonicalAudit ? 'skip' : analyticalIRIssues.some(issue => issue.severity === 'error') ? 'warn' : 'pass',
        summary: !engineConfig.canonicalAudit
            ? 'Canonical IR created for model context; deterministic audit disabled'
            : `${activeAnalyticalIR.answer.kind} · ${activeAnalyticalIR.answer.cardinality} · ${activeAnalyticalIR.operators.map(operator => operator.kind).join(' → ')}`,
        details: {
            analyticalIR: activeAnalyticalIR,
            analyticalIRIssues,
            canonicalIntent: activeCanonicalIntent,
            advisoryReconciliationChanges: canonicalReconciliation.changes,
            planVerification: _verification.issues,
        },
    }, performance.now());

    // Local uncertainty is evidence for the model, not a deterministic veto.
    // The model sees the competing plan/verification signals and decides whether
    // it can produce SQL or whether a genuine clarification is still required.
    if (plan.ambiguous) {
        console.warn('[Pipeline] Local plan is ambiguous — escalating the uncertainty to the governed model route.');
        plan = {
            ...plan,
            ambiguous: false,
            clarificationQuestion: undefined,
        };
    }

    // ─── Step 2d: Deterministic Context Builder ────────────────────
    // AI SQL uses the local engines to describe schema facts, semantics,
    // relationships, grounded literals, GAFS operations and answer shape. The
    // legacy compilers remain behind a disabled compatibility switch; they do
    // not author or replace SQL on the model-owned route.
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
    const locallyOwnedTotalComparison = !modelOwnsSQL && canCompileTotalPeriodComparisonLocally(
        plan,
        semanticModel,
        apdmeResult.derivedMetricApplied,
    );
    const irCompilation = modelOwnsSQL
        ? { supported: false as const, sql: undefined, reasons: ['AI SQL model owns SQL synthesis'] }
        : compileAnalyticalIRToSQL(activeAnalyticalIR);
    const irContractIssues = irCompilation.supported && irCompilation.sql && activeQueryContract
        ? validateSQLAgainstContract(irCompilation.sql, activeQueryContract).filter(issue => issue.severity === 'error')
        : [];
    const locallyOwnedCanonicalIR = !modelOwnsSQL
        && executionOptions?.requestPurpose !== 'benchmark'
        && irCompilation.supported
        && !!irCompilation.sql
        && analyticalIRIssues.every(issue => issue.severity !== 'error')
        && irContractIssues.length === 0;

    if (modelOwnsSQL) {
        qbReason = 'AI SQL deterministic engines provide context and validation only; the governed LLM authors SQL.';
        qbTraceDetails = {
            fits: false,
            role: 'context-only',
            questionPlan: plan,
            queryContract: activeQueryContract,
        };
    } else if (locallyOwnedCanonicalIR) {
        // For the compiler's proven subset, execute the frozen IR directly.
        // This is the actual zero-token hybrid route: the LLM is reserved for
        // semantic shapes the typed compiler cannot yet express. Benchmarks
        // deliberately continue through the model-backed route so their AI-SQL
        // evidence remains comparable with previous runs.
        qbSQL = irCompilation.sql!;
        qbNotes = ['canonical IR compiled to typed SQL AST'];
        qbTraceDetails = {
            fits: true,
            compiler: 'canonical-ir-ast',
            resultGrain: plan.resultGrain,
            sql: qbSQL,
        };
        console.log('[Pipeline] Canonical IR-AST SQL:', qbSQL);
    } else if (locallyOwnedTotalComparison) {
        // This is an exact two-row shape. Keep it inside the typed compiler so
        // an LLM cannot reintroduce a row identifier or other detail grouping.
        qbSQL = correctSQL(plan, semanticModel, apdmeResult.derivedMetrics);
        qbNotes = ['two period totals; no detail grouping'];
        qbTraceDetails = {
            fits: true,
            compiler: 'deterministic-period-comparison',
            resultGrain: plan.resultGrain,
            sql: qbSQL,
        };
        console.log('[Pipeline] Deterministic period-comparison SQL:', qbSQL);
    } else if (antiJoin) {
        qbSQL = buildAntiJoinSQL(antiJoin, 'data');
        qbNotes = [`anti-join: ${antiJoin.entity} where ${antiJoin.filterField} in [${antiJoin.hasValues.join(', ')}] but never [${antiJoin.notValues.join(', ')}]`];
        qbTraceDetails = { antiJoin: true, spec: antiJoin, sql: qbSQL };
        console.log('[Pipeline] Anti-join SQL:', qbSQL);
        // The set-logic values are handled by the anti-join, not dropped — clear
        // the spurious dropped-filter verification issues.
        const cleaned = _verification.issues.filter(i => i.code !== 'dropped_filter');
        _verification = { ok: !cleaned.some(i => i.severity === 'error'), issues: cleaned };
    } else if ((activeCanonicalIntent?.relationship.tables.length || 0) > 1) {
        // The single-table Question Builder compiler cannot safely emulate a
        // schema-graph query. Fail over to the governed three-model route
        // instead of producing a plausible but wrong flattened-table answer.
        qbReason = `Canonical intent requires physical tables: ${activeCanonicalIntent!.relationship.tables.join(', ')}`;
        qbTraceDetails = {
            fits: false,
            reason: qbReason,
            canonicalIntent: activeCanonicalIntent,
        };
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
                console.warn('[Pipeline] QB compilation failed; governed fallback may be required:', qbErr.message);
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
        stepNumber: 5, name: modelOwnsSQL ? 'Deterministic Context Builder' : locallyOwnedCanonicalIR ? 'Canonical IR Compiler' : locallyOwnedTotalComparison ? 'Period Comparison Compiler' : antiJoin ? 'Anti-Join Compiler' : 'Question Builder Compiler', engine: 'qbMapper', icon: '🎛️',
        status: qbSQL ? 'pass' : 'skip',
        summary: qbSQL
            ? `Governed deterministic query compiled — ${qbNotes.join('; ')}`
            : modelOwnsSQL
                ? 'Schema, semantics, relationships, grounded literals, question plan and output contract prepared for the LLM'
                : `Request requires an approved AI fallback — ${qbReason || 'compilation failed'}`,
        details: qbTraceDetails,
    }, _s1);

    // ─── Step 2e: Governed Model SQL Synthesis ─────────────────────
    // The model receives the compact deterministic context plus explicitly
    // approved safe domains (Enhanced mode only). It never receives dataset
    // rows, and its complete route and token usage are returned as provenance.
    let directSQL: string | null = null;
    let directSqlTokens = 0;
    let directSqlModel: string | undefined;
    let directSqlError: string | null = null;
    let directSqlBlocked = false;
    let directSqlFailureKind: AISQLPipelineFailureKind | undefined;
    let directQuerySpec: DynamicQuerySpec | undefined;
    const locallyExecutableSQL = !modelOwnsSQL && !!qbSQL
        && (locallyOwnedCanonicalIR || locallyOwnedTotalComparison || !!antiJoin || !requiresAdvancedSql);
    if (locallyExecutableSQL) {
        directSqlError = locallyOwnedCanonicalIR
            ? 'Not required: the frozen Canonical Analytical IR compiled to contract-valid typed SQL.'
            : locallyOwnedTotalComparison
                ? 'Not required: the deterministic period compiler produced the exact two-row answer shape.'
                : antiJoin
                    ? 'Not required: the deterministic anti-join compiler produced the requested set result.'
                    : 'Not required: the Question Builder compiler supports this analytical shape locally.';
        traceStep({
            stepNumber: 5, name: 'Direct-SQL Engine', engine: 'directSqlEngine', icon: '✍️',
            status: 'skip',
            summary: locallyOwnedCanonicalIR
                ? 'Skipped — canonical IR compiled locally with zero model tokens'
                : locallyOwnedTotalComparison
                    ? 'Skipped — deterministic period SQL prevents unrequested detail grouping'
                    : antiJoin
                        ? 'Skipped — deterministic anti-join SQL compiled locally with zero model tokens'
                        : 'Skipped — supported Question Builder SQL compiled locally with zero model tokens',
            details: {
                reason: directSqlError,
                tokens: 0,
                model: null,
            },
        }, _directSqlStart);
    } else {
        // The local engines build grounded evidence first; the governed model
        // performs compositional reasoning and authors the executable SQL.
        const _ds = await runHybridSql([
            ..._verification.issues,
            ...analyticalIRIssues,
        ]);
        directSQL = _ds.sql;
        directSqlTokens = _ds.tokens;
        directSqlModel = _ds.model;
        directSqlError = _ds.error;
        directSqlBlocked = !!_ds.blocked;
        directSqlFailureKind = _ds.failureKind;
        directQuerySpec = _ds.querySpec;
        traceStep({
            stepNumber: 5, name: 'Direct-SQL Engine', engine: 'directSqlEngine', icon: '✍️',
            status: directSQL ? 'pass' : 'skip',
            summary: directSQL
                ? `LLM-owned SQL: ${directSqlModel || 'GPT-5.6'} interpreted the complete question using ${effectivePrivacyMode === 'enhanced' ? 'metadata plus approved safe values' : 'metadata only'}`
                : 'Model SQL unavailable or rejected — no deterministic query will be substituted',
            details: {
                sql: directSQL,
                error: directSqlError,
                tokens: directSqlTokens,
                model: directSqlModel || null,
                localCompatibilityAudit: activeQueryContract ? {
                    outputEntity: activeQueryContract.outputEntity,
                    expectedCardinality: activeQueryContract.expectedCardinality,
                    resultGrain: activeQueryContract.requiredDimension,
                    requiredTables: activeQueryContract.requiredTables,
                    existenceMode: activeQueryContract.existenceMode,
                    relationshipMode: activeQueryContract.relationshipMode,
                    aggregations: activeQueryContract.expectedAggregations,
                    aggregation: activeQueryContract.expectedAggregation,
                    ratio: activeQueryContract.ratio,
                    relativeComparison: activeQueryContract.relativeComparison,
                    rankingDirection: activeQueryContract.rankingDirection,
                    rankingLimit: activeQueryContract.rankingLimit,
                    rankedSetOperation: activeQueryContract.rankedSetOperation,
                } : null,
            },
        }, _directSqlStart);
    }

    // AI SQL never substitutes a locally authored query when model planning is
    // unavailable or uncertain. That would silently change the requested
    // reasoning while presenting the result as AI SQL.
    if (directSqlBlocked || (!directSQL && !locallyExecutableSQL)) {
        const message = directSqlError || 'AI SQL stopped before execution because it could not preserve the requested analytical shape.';
        if (directSqlFailureKind) throw new AISQLPipelineError(directSqlFailureKind, message);
        throw new Error(message);
    }
    if (directQuerySpec) {
        plan = applyQuerySpecToAnalysisPlan(plan, directQuerySpec, semanticModel);
        console.log('[Pipeline] Downstream presentation and validation now use the model-authored Query Specification.');
    }
    if (!engineConfig.readOnlySafety) {
        throw new Error('AI SQL paused by admin: read-only SQL safety is disabled. Execution remains blocked rather than running unverified SQL.');
    }


    // ─── Step 3: Generate SQL (Step B — deterministic + LLM fallback) ─
    reportProgress('Generating SQL...', 4);
    console.log('[Pipeline] Step 3: Generating SQL...');
    _s1 = performance.now();
    let sqlResult: { sql: string; method: string; explanation?: string };
    if (directSQL) {
        // The governed fallback wrote SQL from the approved schema context.
        sqlResult = { sql: directSQL, method: 'llm-sql', explanation: '' };
        // The LLM's SQL already computes its own result shape, so drop the
        // Question Builder's share-of-total table calc (it only applies to
        // builder-compiled SQL).
        qbShareValueKey = null;
    } else if (locallyExecutableSQL && qbSQL) {
        // Normal governed path: locally compiled SQL.
        sqlResult = { sql: qbSQL, method: 'question-builder', explanation: '' };
    } else {
        sqlResult = await generateSQLFromPlan(
            plan,
            semanticModel,
            apdmeResult.derivedMetrics,
            executionOptions?.requestPurpose,
        );
    }
    const aiGeneratedSQL = sqlResult.sql; // Keep AI's SQL for reference
    const sqlMethod = sqlResult.method;
    traceStep({
        stepNumber: 6, name: 'SQL Generator', engine: 'sqlGenerator', icon: '⚡',
        status: 'pass',
        summary: directSQL
            ? `LLM-owned SQL: ${directSqlModel || 'GPT-5.6'} generated SQL from its own Query Specification using ${effectivePrivacyMode === 'enhanced' ? 'metadata plus approved safe values' : 'metadata only'}`
            : qbSQL
                ? (locallyOwnedTotalComparison
                    ? 'Local deterministic period comparison: exactly two aggregated rows'
                    : 'Local continuity fallback: deterministic Question Builder SQL')
                : `Local continuity fallback: generated via ${sqlMethod === 'deterministic' ? 'deterministic rules' : 'AI/LLM fallback'}`,
        details: { method: sqlMethod, sql: aiGeneratedSQL },
    }, _s1);

    // ─── Step 3b: SQL Correction Engine ──────────────────────────
    // Skip correction when the typed compiler produced the query; its output is
    // already constrained to the supported local surface.
    reportProgress('Correcting SQL...', 5);
    _s1 = performance.now();
    let currentSQL: string;
    let _correctionStatus: 'pass' | 'warn' | 'skip' = 'pass';
    // Keep the local SQL available as a safety net if a fallback query cannot run.
    // A basic Question Builder query is not a semantically equivalent backup
    // for an explicit window/table calculation. The correction engine below
    // must first compile the required advanced operation.
    let deterministicSQL: string | null = locallyExecutableSQL ? qbSQL : null;
    if (directSQL) {
        // An approved fallback query is being executed.
        currentSQL = directSQL;
        _correctionStatus = 'skip';
    } else if (locallyExecutableSQL && qbSQL) {
        // Locally compiled deterministic SQL.
        currentSQL = qbSQL;
        _correctionStatus = 'skip';
    } else {
        console.log('[Pipeline] Step 3b: Running deterministic SQL correction engine...');
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
            ? (directSQL ? 'Skipped — model-authored SQL passed the read-only safety gate' : 'Skipped — local deterministic compiler produced the SQL')
            : _correctionStatus === 'pass'
                ? 'Local continuity fallback: SQL rebuilt deterministically — verified column names, GROUP BY, aggregations'
                : 'Correction engine failed — using AI-generated SQL as fallback',
        details: { correctedSQL: currentSQL, usedFallback: _correctionStatus === 'warn' },
    }, _s1);

    // Which engine actually produced `currentSQL` — surfaced in the SQL tab.
    // May be downgraded to a deterministic backup below if the LLM SQL won't run.
    let sqlEngine: 'question-builder' | 'llm-sql' | 'correction-engine' | 'llm' =
        directSQL ? 'llm-sql'
            : qbSQL ? (locallyOwnedTotalComparison ? 'correction-engine' : 'question-builder')
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
    // Validate the model-authored SQL as written. Structural corrections are
    // delegated back to the model with the validator evidence below.
    _s1 = performance.now();
    let validation = validateSQL(currentSQL, plan, semanticModel);
    let _failedChecks = validation.checks.filter(c => c.status === 'fail');
    let _warnChecks = validation.checks.filter(c => c.status === 'warn');
    traceStep({
        stepNumber: 8, name: 'SQL Validator', engine: 'sqlValidator', icon: '✅',
        status: _failedChecks.length > 0 ? 'fail' : _warnChecks.length > 0 ? 'warn' : 'pass',
        summary: `${validation.checks.filter(c => c.status === 'pass').length}/${validation.checks.length} checks passed${_failedChecks.length > 0 ? `, ${_failedChecks.length} failed` : ''}`,
        details: { checks: validation.checks },
    }, _s1);

    if (!validation.valid) {
        console.warn('[Pipeline] SQL validation failed:', _failedChecks);
    }

    // Physical-type violations are guaranteed execution failures, not merely
    // advisory plan disagreements. Repair them once using schema metadata only;
    // never send a query to DuckDB when the physical cast is known to be invalid.
    const physicalTypeFailures = _failedChecks.filter(check => check.name === 'Physical date compatibility');
    if (physicalTypeFailures.length > 0 && directSQL && directSchemaText && engineConfig.semanticResultRepair) {
        try {
            const semanticRepair = await repairSemanticSQL(
                question,
                directSchemaText,
                directQuerySpec,
                currentSQL,
                `Pre-execution physical type validation failed. ${physicalTypeFailures.map(check => check.message).join(' ')}`,
                executionOptions?.requestPurpose,
                undefined,
            );
            directSqlTokens += semanticRepair.tokens;
            if (!semanticRepair.error && semanticRepair.sql) {
                const repairedValidation = validateSQL(semanticRepair.sql, plan, semanticModel);
                const stillInvalid = repairedValidation.checks.some(check =>
                    check.name === 'Physical date compatibility' && check.status === 'fail'
                );
                if (!stillInvalid) {
                    currentSQL = semanticRepair.sql;
                    directSQL = semanticRepair.sql;
                    validation = repairedValidation;
                    _failedChecks = validation.checks.filter(check => check.status === 'fail');
                    _warnChecks = validation.checks.filter(check => check.status === 'warn');
                    repairAttempts++;
                    sqlResult.explanation = semanticRepair.explanation;
                }
            }
        } catch (physicalRepairError: any) {
            console.warn('[Pipeline] Physical-type SQL repair failed:', physicalRepairError?.message || physicalRepairError);
        }
    }
    if (validation.checks.some(check => check.name === 'Physical date compatibility' && check.status === 'fail')) {
        throw new AISQLPipelineError(
            'sql_validation_failed',
            `SQL validation stopped a guaranteed DuckDB type error before execution: ${physicalTypeFailures.map(check => check.message).join(' ')}`,
        );
    }

    // ─── Step 4b: Predicate Provenance Gate ─────────────────────
    // A read-only query can still be confidently wrong when the model turns a
    // dataset/domain name into an invented categorical filter. Validate every
    // equality/LIKE literal whose local field domain is complete before the
    // query reaches DuckDB. Only unsupported metadata is shared with repair;
    // local values and result rows remain in the browser.
    const predicateGateStart = performance.now();
    let predicateIssues = _valueCatalog
        ? auditSqlPredicateProvenance(currentSQL, _valueCatalog, {
            question,
            requiredPredicates: activeQueryContract?.requiredPredicates,
        })
        : [];
    const originalPredicateIssueCount = predicateIssues.length;
    let predicateGateResolution: 'pass' | 'model-repair' | 'local-safe-removal' = 'pass';
    if (predicateIssues.length > 0 && directSQL) {
        console.warn('[Pipeline] Predicate provenance rejected unsupported model filters:', predicateIssues);

        // First return the concrete metadata violation to the SQL author. This
        // keeps analytical reasoning model-owned while making local evidence a
        // real execution boundary rather than a post-hoc warning.
        if (engineConfig.semanticResultRepair && directSchemaText) {
            try {
                const semanticRepair = await repairSemanticSQL(
                    question,
                    directSchemaText,
                    directQuerySpec,
                    currentSQL,
                    `Pre-execution predicate provenance failed. These model-authored categorical predicates use values that do not exist in their referenced complete local domains and are not explicitly grounded by the user or query contract: ${predicateIssues.map(issue => `${issue.field} ${issue.operator} '${issue.literal.replace(/'/g, "''")}'`).join('; ')}. Remove the unsupported predicate(s); do not invent replacements and preserve every other requested output, join, and filter.`,
                    executionOptions?.requestPurpose,
                    activeQueryContract,
                );
                directSqlTokens += semanticRepair.tokens;
                if (!semanticRepair.error && semanticRepair.sql !== currentSQL) {
                    let repairedSQL = semanticRepair.sql;
                    if (_valueCatalog) repairedSQL = groundSqlLiterals(repairedSQL, _valueCatalog).sql;
                    const remainingIssues = _valueCatalog
                        ? auditSqlPredicateProvenance(repairedSQL, _valueCatalog, {
                            question,
                            requiredPredicates: activeQueryContract?.requiredPredicates,
                        })
                        : [];
                    if (remainingIssues.length === 0) {
                        currentSQL = repairedSQL;
                        directSQL = repairedSQL;
                        validation = validateSQL(currentSQL, plan, semanticModel);
                        predicateIssues = [];
                        predicateGateResolution = 'model-repair';
                        repairAttempts++;
                        sqlResult.explanation = 'Removed an unsupported categorical interpretation before local execution.';
                    } else {
                        predicateIssues = remainingIssues;
                    }
                }
            } catch (predicateRepairError: any) {
                console.warn('[Pipeline] Predicate provenance model repair skipped:', predicateRepairError?.message || predicateRepairError);
            }
        }

        // Bounded structural fallback: remove only a provably unsupported,
        // simple outer-WHERE leaf joined by AND. Complex OR/BETWEEN/subquery
        // logic is never rewritten; it remains blocked for clarification.
        if (predicateIssues.length > 0) {
            const localRepair = removeUnsupportedTopLevelPredicates(currentSQL, predicateIssues);
            if (localRepair.removed.length > 0) {
                currentSQL = localRepair.sql;
                directSQL = localRepair.sql;
                validation = validateSQL(currentSQL, plan, semanticModel);
                predicateIssues = _valueCatalog
                    ? auditSqlPredicateProvenance(currentSQL, _valueCatalog, {
                        question,
                        requiredPredicates: activeQueryContract?.requiredPredicates,
                    })
                    : [];
                if (predicateIssues.length === 0) {
                    predicateGateResolution = 'local-safe-removal';
                    repairAttempts++;
                    sqlResult.explanation = 'Removed a provably unsupported categorical predicate before local execution.';
                }
            }
        }

        if (predicateIssues.length > 0) {
            throw new Error(`AI SQL stopped before execution because ${predicateIssues.length} categorical predicate(s) had no user, contract, or local-domain provenance: ${predicateIssues.map(issue => `${issue.field} ${issue.operator} '${issue.literal}'`).join('; ')}.`);
        }
    }
    traceStep({
        stepNumber: 8,
        name: 'Predicate Provenance Gate',
        engine: 'valueGrounding',
        icon: '🔎',
        status: originalPredicateIssueCount > 0 ? 'warn' : 'pass',
        summary: originalPredicateIssueCount === 0
            ? 'All auditable categorical predicates have local or user provenance'
            : predicateGateResolution === 'model-repair'
                ? `Model repair removed ${originalPredicateIssueCount} unsupported categorical predicate(s)`
                : `Safely removed ${originalPredicateIssueCount} unsupported top-level categorical predicate(s)`,
        details: { issueCount: originalPredicateIssueCount, resolution: predicateGateResolution },
    }, predicateGateStart);

    // ─── Step 5: Execute SQL ─────────────────────────────────────
    reportProgress('Executing SQL...', 7);
    console.log('[Pipeline] Step 5: Executing SQL...');
    _s1 = performance.now();
    if (!engineConfig.duckdbExecution) {
        throw new Error('AI SQL paused by admin: local DuckDB-WASM execution is disabled. The generated SQL was not executed.');
    }
    let execResult = await executeSQLViaDuckDB(dataset.rows, currentSQL, semanticModel.timeContext, dataset.relatedTables);

    // ─── Step 5b: Repair Loop (max 2 attempts) ──────────────────
    while (engineConfig.sqlExecutionRepair && execResult.error && repairAttempts < 2) {
        repairAttempts++;
        console.log(`[Pipeline] Step 5b: Repair attempt ${repairAttempts}...`);
        try {
            const repaired = await repairSQL(
                currentSQL,
                execResult.error,
                plan,
                semanticModel,
                repairAttempts,
                executionOptions?.requestPurpose,
                {
                    schemaText: directSchemaText || undefined,
                    question,
                    querySpec: directQuerySpec,
                },
            );
            const repairContractIssues: ReturnType<typeof validateSQLAgainstContract> = [];
            if (repairContractIssues.length) {
                console.warn('[Pipeline] Executing read-only SQL repair with advisory contract issues:', repairContractIssues.map(issue => issue.message));
            }
            currentSQL = repaired.sql;
            sqlResult.explanation = repaired.explanation;
            execResult = await executeSQLViaDuckDB(dataset.rows, currentSQL, semanticModel.timeContext, dataset.relatedTables);
        } catch (repairErr: any) {
            console.warn(`[Pipeline] Repair attempt ${repairAttempts} failed:`, repairErr.message);
            break;
        }
    }

    // ─── Step 5b′: Deterministic Safety Net (quiet backup) ──────
    let usedDeterministicFallback = false;

    // If the LLM's SQL still won't execute after repair, fall back to the
    // deterministic engines — the Question Builder backup if one was built,
    // otherwise the correction engine — which always produce runnable SQL from
    // the plan. This keeps a failed LLM query from crashing into an error.
    if (!modelOwnsSQL && execResult.error && directSQL) {
        console.warn('[Pipeline] LLM SQL failed to execute after repair — using the deterministic backup.');
        try {
            const usingQbBackup = !!deterministicSQL;
            const fallbackSQL = deterministicSQL ?? correctSQL(plan, semanticModel, apdmeResult.derivedMetrics);
            const fallbackExec = await executeSQLViaDuckDB(dataset.rows, fallbackSQL, semanticModel.timeContext, dataset.relatedTables);
            if (!fallbackExec.error) {
                currentSQL = fallbackSQL;
                execResult = fallbackExec;
                sqlEngine = usingQbBackup ? 'question-builder' : 'correction-engine';
                usedDeterministicFallback = true;
                console.log(`[Pipeline] Deterministic backup succeeded — engine = ${sqlEngine}.`);
            }
        } catch (fbErr: any) {
            console.warn('[Pipeline] Deterministic fallback also failed:', fbErr?.message);
        }
    }

    if (execResult.error) {
        throw new Error(`SQL execution failed: ${execResult.error}`);
    }

    // A syntactically valid query can still be semantically wrong (wrong table,
    // join path, literal casing, or entity grain). Give the reviewer one
    // metadata-only retry when such a query unexpectedly returns no rows.
    const preRepairLiteralIssues = _valueCatalog ? auditSqlLiterals(currentSQL, _valueCatalog) : [];
    const resultRows = execResult.data || [];
    const isSuspiciousZeroAggregate = resultRows.length === 1
        && preRepairLiteralIssues.length > 0
        && Object.values(resultRows[0] || {}).some(value => value !== null && value !== undefined)
        && Object.values(resultRows[0] || {}).every(value => value === null || value === undefined || Number(value) === 0);
    const shouldRepairEmptyResult = engineConfig.semanticResultRepair
        && !!directSQL
        && !usedDeterministicFallback
        && (resultRows.length === 0 || isSuspiciousZeroAggregate)
        && (isSuspiciousZeroAggregate || !/\b(?:count|how many|are there|is there|zero rows|no results)\b/i.test(question));
    if (shouldRepairEmptyResult && directSchemaText) {
        try {
            console.log('[Pipeline] Step 5c: Result-aware semantic repair after empty output...');
            const literalDiagnostic = preRepairLiteralIssues.length
                ? ` Local categorical audit: the SQL-authored literal(s) ${preRepairLiteralIssues.map(issue => `"${issue.literal}" for ${issue.field}`).join(', ')} do not exist in their referenced local fields. Re-read the question and schema; do not invent a replacement value.`
                : '';
            const semanticRepair = await repairSemanticSQL(
                question,
                directSchemaText,
                directQuerySpec,
                currentSQL,
                `The query executed successfully but returned ${isSuspiciousZeroAggregate ? 'a suspicious all-zero aggregate' : '0 rows'} although the requested result shape expects a meaningful answer.${literalDiagnostic}`,
                executionOptions?.requestPurpose,
                undefined,
            );
            directSqlTokens += semanticRepair.tokens;
            if (!semanticRepair.error && semanticRepair.sql !== currentSQL) {
                let repairedSQL = semanticRepair.sql;
                if (_valueCatalog) repairedSQL = groundSqlLiterals(repairedSQL, _valueCatalog).sql;
                const repairedExecution = await executeSQLViaDuckDB(dataset.rows, repairedSQL, semanticModel.timeContext, dataset.relatedTables);
                const repairedRows = repairedExecution.data || [];
                const repairedMeaningfully = repairedRows.length > 0
                    && (!isSuspiciousZeroAggregate || Object.values(repairedRows[0] || {}).some(value => value !== null && value !== undefined && Number(value) !== 0));
                if (!repairedExecution.error && repairedMeaningfully) {
                    currentSQL = repairedSQL;
                    directSQL = repairedSQL;
                    execResult = repairedExecution;
                    validation = validateSQL(currentSQL, plan, semanticModel);
                    repairAttempts++;
                    sqlResult.explanation = semanticRepair.explanation;
                    console.log(`[Pipeline] Result-aware repair recovered ${(execResult.data || []).length} row(s).`);
                }
            }
        } catch (semanticRepairError: any) {
            console.warn('[Pipeline] Result-aware semantic repair skipped:', semanticRepairError?.message || semanticRepairError);
        }
    }

    // Step 5d: executable answer-shape gate. SQL can be syntactically valid and
    // still answer a different question (for example, LIMIT 1 for "each group"
    // or a scalar aggregate for "all rows"). Compare only locally computed row
    // counts against the pre-SQL contract; no result values leave the browser.
    if (!modelOwnsSQL && engineConfig.resultContractValidation && activeQueryContract) {
        const normalizedRows = normalizeResultToContract(execResult.data || [], activeQueryContract);
        if (normalizedRows.length !== (execResult.data || []).length) {
            console.log(`[Pipeline] Set-result normalization removed ${(execResult.data || []).length - normalizedRows.length} duplicate row(s).`);
            execResult = { ...execResult, data: normalizedRows };
        }
    }
    let resultContractIssues = !modelOwnsSQL && engineConfig.resultContractValidation && activeQueryContract
        ? validateResultAgainstContract(execResult.data || [], activeQueryContract)
            .filter(issue => issue.severity === 'error')
        : [];
    let analyticalResultIssues = !modelOwnsSQL && engineConfig.resultContractValidation && activeAnalyticalIR
        ? validateAnalyticalResult(execResult.data || [], activeAnalyticalIR)
            .filter(issue => issue.severity === 'error')
        : [];
    // Prefer a structural recovery compiled from the frozen IR before asking a
    // model to patch its own SQL. This fixes valid-but-wrong result shapes (for
    // example repeated qualifying groups) without regex surgery or row data
    // leaving DuckDB.
    if (!modelOwnsSQL && (resultContractIssues.length || analyticalResultIssues.length) && activeAnalyticalIR) {
        const structuralRecovery = compileAnalyticalIRToSQL(activeAnalyticalIR);
        if (structuralRecovery.supported && structuralRecovery.sql && structuralRecovery.sql !== currentSQL) {
            const sqlIssues = activeQueryContract
                ? validateSQLAgainstContract(structuralRecovery.sql, activeQueryContract).filter(issue => issue.severity === 'error')
                : [];
            if (sqlIssues.length === 0) {
                const structuralExecution = await executeSQLViaDuckDB(
                    dataset.rows,
                    structuralRecovery.sql,
                    semanticModel.timeContext,
                    dataset.relatedTables,
                );
                const normalizedStructural = !structuralExecution.error && activeQueryContract
                    ? { ...structuralExecution, data: normalizeResultToContract(structuralExecution.data || [], activeQueryContract) }
                    : structuralExecution;
                const structuralContractIssues = normalizedStructural.error || !activeQueryContract
                    ? resultContractIssues
                    : validateResultAgainstContract(normalizedStructural.data || [], activeQueryContract).filter(issue => issue.severity === 'error');
                const structuralAnalyticalIssues = normalizedStructural.error
                    ? analyticalResultIssues
                    : validateAnalyticalResult(normalizedStructural.data || [], activeAnalyticalIR).filter(issue => issue.severity === 'error');
                if (!normalizedStructural.error && structuralContractIssues.length === 0 && structuralAnalyticalIssues.length === 0) {
                    currentSQL = structuralRecovery.sql;
                    execResult = normalizedStructural;
                    validation = validateSQL(currentSQL, plan, semanticModel);
                    resultContractIssues = [];
                    analyticalResultIssues = [];
                    repairAttempts++;
                    directSQL = null;
                    usedDeterministicFallback = true;
                    sqlEngine = 'correction-engine';
                    console.warn('[Pipeline] Frozen IR AST recovered a contract-valid analytical result locally.');
                }
            }
        }
    }
    if (engineConfig.semanticResultRepair
        && (resultContractIssues.length || analyticalResultIssues.length)
        && directSQL
        && directSchemaText
        && !usedDeterministicFallback
        && !shouldRepairEmptyResult) {
        try {
            console.log('[Pipeline] Step 5d: Result-cardinality repair...');
            const semanticRepair = await repairSemanticSQL(
                question,
                directSchemaText,
                directQuerySpec,
                currentSQL,
                [...resultContractIssues, ...analyticalResultIssues].map(issue => issue.message).join(' '),
                executionOptions?.requestPurpose,
                undefined,
            );
            directSqlTokens += semanticRepair.tokens;
            if (!semanticRepair.error && semanticRepair.sql !== currentSQL) {
                let repairedSQL = semanticRepair.sql;
                if (_valueCatalog) repairedSQL = groundSqlLiterals(repairedSQL, _valueCatalog).sql;
                const repairedExecution = await executeSQLViaDuckDB(
                    dataset.rows,
                    repairedSQL,
                    semanticModel.timeContext,
                    dataset.relatedTables,
                );
                const normalizedRepairedExecution = !repairedExecution.error && activeQueryContract
                    ? { ...repairedExecution, data: normalizeResultToContract(repairedExecution.data || [], activeQueryContract) }
                    : repairedExecution;
                const repairedContractIssues = normalizedRepairedExecution.error || !activeQueryContract
                    ? resultContractIssues
                    : validateResultAgainstContract(normalizedRepairedExecution.data || [], activeQueryContract)
                        .filter(issue => issue.severity === 'error');
                const repairedAnalyticalIssues = normalizedRepairedExecution.error || !activeAnalyticalIR
                    ? analyticalResultIssues
                    : validateAnalyticalResult(normalizedRepairedExecution.data || [], activeAnalyticalIR)
                        .filter(issue => issue.severity === 'error');
                if (!normalizedRepairedExecution.error && repairedContractIssues.length === 0 && repairedAnalyticalIssues.length === 0) {
                    currentSQL = repairedSQL;
                    directSQL = repairedSQL;
                    execResult = normalizedRepairedExecution;
                    validation = validateSQL(currentSQL, plan, semanticModel);
                    resultContractIssues = [];
                    analyticalResultIssues = [];
                    repairAttempts++;
                    sqlResult.explanation = semanticRepair.explanation;
                    console.log(`[Pipeline] Result-cardinality repair recovered ${(execResult.data || []).length} row(s).`);
                }
            }
        } catch (shapeRepairError: any) {
            console.warn('[Pipeline] Result-cardinality repair skipped:', shapeRepairError?.message || shapeRepairError);
        }
    }

    if (resultContractIssues.length || analyticalResultIssues.length) {
        // The query already passed the read-only safety boundary and DuckDB
        // executed it successfully. Shape mismatches are semantic evidence,
        // not execution failures: retain them for confidence/audit while
        // allowing the actual result (or benchmark gold comparator) to judge
        // correctness.
        console.warn('[Pipeline] Presenting executed read-only result with advisory analytical issues:', [...resultContractIssues, ...analyticalResultIssues].map(issue => issue.message));
    }

    traceStep({
        stepNumber: 9, name: 'DuckDB Execution', engine: 'duckdbEngine', icon: '🦆',
        status: repairAttempts > 0 || resultContractIssues.length > 0 || analyticalResultIssues.length > 0 ? 'warn' : 'pass',
        summary: `${(execResult.data || []).length} rows returned${repairAttempts > 0 ? ` (after ${repairAttempts} repair attempt${repairAttempts > 1 ? 's' : ''})` : ''}${resultContractIssues.length + analyticalResultIssues.length > 0 ? ` · ${resultContractIssues.length + analyticalResultIssues.length} advisory analytical warning(s)` : ''}`,
        details: {
            rowCount: (execResult.data || []).length,
            columnCount: (execResult.columns || []).length,
            columns: execResult.columns || [],
            repairAttempts,
            contractWarnings: resultContractIssues.map(issue => issue.message),
            analyticalInvariantWarnings: analyticalResultIssues.map(issue => issue.message),
            analyticalIRVersion: activeAnalyticalIR?.version || null,
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
    // Compatibility time intelligence. Advanced requests are now calculated in
    // SQL; this layer only fills calculations absent from legacy/simple SQL and
    // derives presentation metadata such as the growth badge.

    if (rawData.length > 0) {
        const cols = Object.keys(rawData[0]);
        const sqlProvidedCalculations = new Set(cols.map(column => column.toLowerCase()));

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
                    const computedPct = rawPct !== null && isFinite(rawPct) ? rawPct : null;
                    const sqlPct = Number(currentRow.growth_pct);
                    const pct = sqlProvidedCalculations.has('growth_pct') && isFinite(sqlPct)
                        ? sqlPct
                        : computedPct;

                    // Enrich only fields the SQL did not already calculate.
                    if (!sqlProvidedCalculations.has('growth_pct')) {
                        currentRow.growth_pct = pct;
                        previousRow.growth_pct = null;
                    }
                    if (!sqlProvidedCalculations.has('growth_abs')) {
                        currentRow.growth_abs = diff;
                        previousRow.growth_abs = null;
                    }
                    if (!sqlProvidedCalculations.has('previous_value')) {
                        currentRow.previous_value = previousVal;
                        previousRow.previous_value = null;
                    }

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
                            if (!sqlProvidedCalculations.has('previous_value')) partRows[i].previous_value = null;
                            if (!sqlProvidedCalculations.has('growth_pct')) partRows[i].growth_pct = null;
                            if (!sqlProvidedCalculations.has('growth_abs')) partRows[i].growth_abs = null;
                        } else {
                            const previous = Number(partRows[i - 1][primaryMetric]) || 0;
                            if (!sqlProvidedCalculations.has('previous_value')) partRows[i].previous_value = previous;
                            if (!sqlProvidedCalculations.has('growth_abs')) partRows[i].growth_abs = current - previous;
                            const rawGrowth = previous !== 0
                                ? ((current - previous) / Math.abs(previous)) * 100
                                : null;
                            if (!sqlProvidedCalculations.has('growth_pct')) {
                                partRows[i].growth_pct = rawGrowth !== null && isFinite(rawGrowth) ? rawGrowth : null;
                            }
                        }

                        // (C) Running Total — cumulative within this entity only
                        if (!sqlProvidedCalculations.has('running_total')) {
                            partRows[i].running_total = partRows
                                .slice(0, i + 1)
                                .reduce((sum, r) => sum + (Number(r[primaryMetric]) || 0), 0);
                        }

                        // (D) Moving Average (3-period) — within this entity only
                        if (!sqlProvidedCalculations.has('moving_avg')) {
                            if (i >= 2) {
                                const window = partRows.slice(i - 2, i + 1);
                                partRows[i].moving_avg = window.reduce((s, r) => s + (Number(r[primaryMetric]) || 0), 0) / 3;
                            } else {
                                partRows[i].moving_avg = null;
                            }
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
        const noDataExplanation = buildNoDataExplanation({
            sql: currentSQL,
            plan,
            semanticModel,
            resolvedTime,
            unmatchedLiterals,
            privacyMode: effectivePrivacyMode,
        });

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

    // Keep every column returned by the executed SQL. ChartRecommendation is
    // the presentation contract: xKey/yKey/secondaryYKeys decide which columns
    // are plotted, while rank/helper/display columns remain available to the
    // result table and tooltips. A previous share-of-total cleanup deleted all
    // but one measure here, which destroyed valid compound answers such as
    // sales + share + rank + cumulative share after DuckDB had calculated them.

    // ─── Step 10: Score Confidence ───────────────────────────────
    console.log('[Pipeline] Step 10: Scoring confidence...');
    _s1 = performance.now();
    // The Question Builder path is deterministic — score it as such.
    const confidenceMethod: 'deterministic' | 'llm' = (sqlMethod === 'llm' || sqlMethod === 'llm-sql') ? 'llm' : 'deterministic';
    const confidence = scoreConfidence(plan, semanticModel, validation, confidenceMethod, repairAttempts, currentSQL, rawData);
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

            // A known question-faithfulness failure must never be shown as a
            // high-confidence answer. Warnings remain useful, but are explicitly
            // presented as "needs review"; errors are low confidence.
            const confidenceCap = errs > 0 ? 39 : 69;
            confidence.score = Math.min(confidence.score, confidenceCap);
            confidence.level = errs > 0 ? 'low' : 'medium';
            confidence.reasons.push(..._verification.issues.map(i => i.message));
            console.log(`[Pipeline] Verification penalty/cap applied: -${errs * 30 + warns * 10}, max ${confidenceCap} → ${confidence.score}/100`);
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
    const narrative = buildResultNarrative({
        question,
        data: rawData,
        profile,
        chart: reshaped.chart,
        plan,
        model: semanticModel,
        sourceRows: dataset.rows,
    });
    const dataAnswer = narrative?.summary || generateDataDrivenAnswer(question, plan, chartDataForAnswer, semanticModel);
    // Surface ERROR-level faithfulness issues to the user rather than answering
    // silently — the "never a silent wrong answer" guarantee.
    const _vErrors = _verification.issues.filter(i => i.severity === 'error');
    const _analyticalErrors = [...analyticalIRIssues, ...analyticalResultIssues].filter(issue => issue.severity === 'error');
    const verificationCaveat = _vErrors.length > 0 || _analyticalErrors.length > 0
        ? ` ⚠️ Heads up: ${[..._vErrors, ..._analyticalErrors].map(i => i.message).join(' ')} Please double-check or rephrase.`
        : '';
    const finalExplanation = (dataAnswer || sqlResult.explanation || '') + verificationCaveat;

    // ─── Build Pipeline Trace ─────────────────────────────────────
    const pipelineTrace: PipelineTrace = {
        question,
        totalDurationMs: Math.round(executionTime),
        steps: traceSteps,
    };
    const traceStory = buildTraceStory({
        sql: currentSQL,
        querySpec: directQuerySpec,
        sourceTables: [
            { name: 'data', rowCount: dataset.rows.length },
            ...(dataset.relatedTables || []).map(table => ({ name: table.name, rowCount: table.rows.length })),
        ],
        resultRows: rawData.length,
        resultColumns: Object.keys(rawData[0] || {}),
        chart: reshaped.chart,
    });

    const provenance = directSQL
        ? {
            strategy: 'hybrid-plan-llm-sql' as const,
            model: directSqlModel,
            summary: `${directSqlModel || 'GPT-5.6'} generated SQL from the governed local plan; the query ran only in local DuckDB.`,
            dataAccess: effectivePrivacyMode === 'enhanced' ? 'approved_safe_values' as const : 'metadata_only' as const,
            downgraded: usedDeterministicFallback,
        }
        : {
            strategy: 'deterministic' as const,
            summary: locallyOwnedTotalComparison
                ? 'The governed local period compiler produced two aggregate rows without an LLM SQL call.'
                : locallyOwnedCanonicalIR
                    ? 'The governed canonical compiler produced contract-valid SQL locally without an LLM call.'
                    : antiJoin
                        ? 'The governed set-logic compiler produced the anti-join locally without an LLM call.'
                        : 'The governed Question Builder compiler produced and validated this SQL locally without an LLM call.',
            dataAccess: 'metadata_only' as const,
            fallbackReason: undefined,
        };

    const pipelineResult: AISQLPipelineResult = {
        plan,
        querySpec: directQuerySpec,
        analyticalIR: activeAnalyticalIR,
        analyticalValidation: {
            passed: analyticalIRIssues.every(issue => issue.severity !== 'error')
                && analyticalResultIssues.every(issue => issue.severity !== 'error'),
            issues: [...analyticalIRIssues, ...analyticalResultIssues],
        },
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
        provenance,
        trace: pipelineTrace,
        traceStory,
        narrative: narrative || undefined,
        // Surface the exact LLM token cost — the planner step plus the direct-SQL
        // step (0 if the deterministic knobs/correction engine answered). Only LLM
        // calls spend tokens; the deterministic steps are free.
        tokenUsage: totalTokenUsage,
    };


    // ── Step 10c: Generate Trust Verification ─────────────────────
    const trust = generateTrustVerification(pipelineResult);
    pipelineResult.trust = trust;
    console.log(`[Pipeline] Trust: ${trust.status} (${trust.checks.filter(c => c.status === 'pass').length}/${trust.checks.length} checks passed)`);

    // ── Step 11: Ambiguity Disclosure ─────────────────────────────
    // Reuse the exact evidence and ranking that influenced the executable plan.
    // Recomputing here used to create a second, potentially contradictory
    // interpretation after the query had already run.
    if (preExecutionAmbiguity) {
        const { assumptions } = preExecutionAmbiguity;
        pipelineResult.assumptions = {
            questionId: assumptions.questionId,
            summary: assumptions.summary,
            items: assumptions.assumptions.map(assumption => ({
                id: assumption.id,
                type: assumption.type,
                phrase: assumption.phrase,
                interpretation: assumption.interpretation,
                alternatives: assumption.alternatives,
                confidence: assumption.confidence,
                autoResolved: assumption.autoResolved,
                computedValue: assumption.computedValue,
            })),
            overallConfidence: assumptions.overallConfidence,
        };
    }

    // ── Step 12: Answer Contract Validation ───────────────────────
    if (engineConfig.answerContractValidation) try {
        const contractStart = performance.now();
        let localStatsForContract;
        try { localStatsForContract = await resolveLocalStatistics('data', semanticModel); } catch { /* skip */ }

        // The LLM planner owns analytical meaning. The answer validator checks
        // the exact model-authored specification; a locally inferred category,
        // identifier, metric or grain is never substituted at this late stage.
        const finalAnswerContract = directQuerySpec;

        const contractResult = validateAnswerContract(
            plan,
            currentSQL,
            rawData,
            reshaped.chart?.chartType || 'bar',
            reshaped.chart?.xKey || '',
            reshaped.chart?.yKey || '',
            semanticModel,
            localStatsForContract,
            finalAnswerContract,
        );

        pipelineResult.contractValidation = {
            passed: contractResult.passed,
            enforced: true,
            summary: contractResult.summary,
            requestedOutputFields: normalizeQuerySpecOutputFields(directQuerySpec?.expectedResult?.columns),
            checks: contractResult.checks.map(c => ({
                name: c.name,
                status: c.status,
                message: c.message,
            })),
        };

        const blockingChecks = contractResult.checks.filter(check => check.status === 'fail');
        pipelineResult.displaySafety = {
            // Read-only SQL safety is enforced before execution. Answer
            // contract failures are advisory verification signals and must not
            // suppress an otherwise executable local result.
            allowed: true,
            reasons: blockingChecks.map(check => check.message),
            recoverySuggestions: contractResult.repairSuggestions,
        };

        if (!contractResult.passed) {
            // A result that violates its answer contract must never be presented
            // as verified merely because DuckDB executed the SQL successfully.
            pipelineResult.confidence.score = Math.min(pipelineResult.confidence.score, 39);
            pipelineResult.confidence.level = 'low';
            pipelineResult.confidence.reasons.push(
                ...blockingChecks.map(check => `Answer contract failed: ${check.message}`)
            );
            if (pipelineResult.trust) {
                pipelineResult.trust.status = 'validation_issue';
                pipelineResult.trust.confidence = 'low';
                pipelineResult.trust.summary = 'The calculation ran and is shown with semantic verification warnings.';
            }
            pipelineResult.explanation = 'This answer was produced by read-only SQL, but semantic verification found issues with its requested metrics, filters, grain, or visual fields. Review the warning before relying on it.';
        }

        traceStep({
            stepNumber: 13, name: 'Contract Validation', engine: 'answerContractValidator', icon: '✅',
            status: contractResult.passed ? 'pass' : 'warn',
            summary: contractResult.summary,
            details: {
                passCount: contractResult.passCount,
                failCount: contractResult.failCount,
                warnCount: contractResult.warnCount,
                repairSuggestions: contractResult.repairSuggestions,
            },
        }, contractStart);

        console.log(`[Pipeline] Contract: ${contractResult.summary} (${Math.round(performance.now() - contractStart)}ms)`);
    } catch (cvErr: any) {
        console.warn('[Pipeline] Contract validation unavailable; preserving the read-only local result with a warning:', cvErr?.message);
        pipelineResult.displaySafety = {
            allowed: true,
            reasons: ['The answer contract validator was unavailable.'],
            recoverySuggestions: ['Retry the question or review the generated SQL before using the result.'],
        };
        pipelineResult.confidence.score = Math.min(pipelineResult.confidence.score, 39);
        pipelineResult.confidence.level = 'low';
        pipelineResult.explanation = 'The read-only SQL result is shown, but its semantic verification step did not complete. Review the SQL before relying on it.';
        if (pipelineResult.trust) {
            pipelineResult.trust.status = 'validation_issue';
            pipelineResult.trust.confidence = 'low';
            pipelineResult.trust.summary = 'Verification did not complete, so the result has been withheld.';
        }
    } else {
        pipelineResult.contractValidation = {
            passed: true,
            enforced: false,
            summary: 'Answer contract validation disabled by the global AI SQL engine configuration.',
            requestedOutputFields: [],
            checks: [{
                name: 'Answer contract validator',
                status: 'skip',
                message: 'Disabled by an administrator for this run.',
            }],
        };
    }

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
