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
 * 5. Execute SQL → alasql on local data
 * 6. Validate Result → post-execution sanity checks
 * 7. Profile Result → analyze shape for chart selection
 * 8. Recommend Chart → deterministic rules
 * 9. Reshape Data → pivot, Top-N, chronological sort
 * 10. Score Confidence → evaluate system trust
 * 11. Log Audit → observability
 */

import { Dataset } from '../../types';
import { AISQLPipelineResult, AuditEntry, PlanFilter } from './types';
import { buildSemanticModel } from './semanticLayer';
import { generatePlan } from './intentPlanner';
import { generateSQLFromPlan, repairSQL } from './sqlGenerator';
import { correctSQL } from './sqlCorrectionEngine';
import { validateSQL, validateResult } from './sqlValidator';
import { executeSQL } from '../sqlExecutor';
import { profileResult } from './resultProfiler';
import { recommendChart } from './chartRecommender';
import { reshapeData } from './dataReshaper';
import { scoreConfidence } from './confidenceScorer';
import { logAuditEntry } from './auditLogger';
import { resolveTimeContext, augmentQuestionWithTime } from './timeResolver';

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
    onProgress?: (progress: PipelineProgress) => void
): Promise<AISQLPipelineResult> {
    const startTime = performance.now();
    let repairAttempts = 0;
    const TOTAL_STEPS = 11;
    const reportProgress = (step: string, stepNumber: number) => {
        onProgress?.({ step, stepNumber, totalSteps: TOTAL_STEPS, percent: Math.round((stepNumber / TOTAL_STEPS) * 100) });
    };

    console.log('[AI SQL Pipeline] Starting for question:', question);
    if (externalFilters?.length) {
        console.log(`[Pipeline] ${externalFilters.length} external filter(s) provided from UI`);
    }

    // ─── Step 1: Build Semantic Model ────────────────────────────
    reportProgress('Building semantic model...', 1);
    console.log('[Pipeline] Step 1: Building semantic model...');
    const semanticModel = buildSemanticModel(dataset);
    console.log(`[Pipeline] Semantic model: ${semanticModel.fields.length} fields, ${semanticModel.compositeMetrics.length} composite, ${semanticModel.derivedMetrics?.length || 0} derived metrics`);

    // ─── Step 1b: Resolve Time Context (BEFORE LLM) ────────────
    reportProgress('Resolving time context...', 2);
    console.log('[Pipeline] Step 1b: Resolving time context...');
    const resolvedTime = resolveTimeContext(question, semanticModel);
    const augmentedQuestion = augmentQuestionWithTime(question, resolvedTime);
    if (resolvedTime.filter) {
        console.log(`[Pipeline] Time resolved: "${resolvedTime.matchedPhrase}" → ${resolvedTime.description}`);
    }

    // ─── Step 2: Generate Analysis Plan (Step A — LLM) ───────────
    reportProgress('Generating analysis plan (AI)...', 3);
    console.log('[Pipeline] Step 2: Generating analysis plan...');
    const plan = await generatePlan(augmentedQuestion, semanticModel);

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

    // If the plan is ambiguous, return early with clarification request
    if (plan.ambiguous) {
        console.log('[Pipeline] Plan is ambiguous, requesting clarification');
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
        };
    }

    // ─── Step 3: Generate SQL (Step B — deterministic + LLM fallback) ─
    reportProgress('Generating SQL...', 4);
    console.log('[Pipeline] Step 3: Generating SQL...');
    let sqlResult = await generateSQLFromPlan(plan, semanticModel);
    const aiGeneratedSQL = sqlResult.sql; // Keep AI's SQL for reference
    const sqlMethod = sqlResult.method;

    // ─── Step 3b: SQL Correction Engine ──────────────────────────
    reportProgress('Correcting SQL...', 5);
    console.log('[Pipeline] Step 3b: Running SQL Correction Engine...');
    let currentSQL: string;
    try {
        currentSQL = correctSQL(plan, semanticModel);
        console.log('[Pipeline] Correction Engine SQL:', currentSQL);
    } catch (correctionErr: any) {
        console.warn('[Pipeline] Correction engine failed, using AI SQL:', correctionErr.message);
        currentSQL = aiGeneratedSQL; // Fallback to AI SQL if engine fails
    }

    // ─── Step 4: Validate SQL ────────────────────────────────────
    reportProgress('Validating SQL...', 6);
    console.log('[Pipeline] Step 4: Validating SQL...');
    const validation = validateSQL(currentSQL, plan, semanticModel);

    if (!validation.valid) {
        console.warn('[Pipeline] SQL validation failed:', validation.checks.filter(c => c.status === 'fail'));
    }

    // ─── Step 5: Execute SQL ─────────────────────────────────────
    reportProgress('Executing SQL...', 7);
    console.log('[Pipeline] Step 5: Executing SQL...');
    let execResult = executeSQL(dataset.rows, currentSQL);

    // ─── Step 5b: Repair Loop (max 2 attempts) ──────────────────
    while (execResult.error && repairAttempts < 2) {
        repairAttempts++;
        console.log(`[Pipeline] Step 5b: Repair attempt ${repairAttempts}...`);
        try {
            const repaired = await repairSQL(currentSQL, execResult.error, plan, semanticModel, repairAttempts);
            currentSQL = repaired.sql;
            sqlResult.explanation = repaired.explanation;
            execResult = executeSQL(dataset.rows, currentSQL);
        } catch (repairErr: any) {
            console.warn(`[Pipeline] Repair attempt ${repairAttempts} failed:`, repairErr.message);
            break;
        }
    }

    if (execResult.error) {
        throw new Error(`SQL execution failed: ${execResult.error}`);
    }

    const rawData = execResult.data || [];
    const columns = execResult.columns || [];

    if (rawData.length === 0) {
        throw new Error('Query returned no results. Try a different question.');
    }

    // ─── Step 6: Validate Result ─────────────────────────────────
    reportProgress('Validating results...', 8);
    console.log('[Pipeline] Step 6: Validating result...');
    const resultChecks = validateResult(rawData, plan, semanticModel);
    validation.checks.push(...resultChecks);

    // ─── Step 7: Profile Result ──────────────────────────────────
    reportProgress('Profiling results...', 9);
    console.log('[Pipeline] Step 7: Profiling result...');
    const profile = profileResult(rawData, plan, semanticModel);
    console.log(`[Pipeline] Profile: ${profile.rowCount} rows, ${profile.metricCount} metrics, ${profile.dimensionCount} dims, time=${profile.hasTimeDimension}, scaleMismatch=${profile.metricsScaleMismatch.toFixed(1)}x`);

    // ─── Step 8: Recommend Chart ─────────────────────────────────
    reportProgress('Selecting chart type...', 10);
    console.log('[Pipeline] Step 8: Recommending chart...');
    const chartRec = recommendChart(profile, plan, semanticModel);
    console.log(`[Pipeline] Chart: ${chartRec.chartType} (${chartRec.reason})`);

    // ─── Step 9: Reshape Data ────────────────────────────────────
    reportProgress('Reshaping data for chart...', 11);
    console.log('[Pipeline] Step 9: Reshaping data...');
    const reshaped = reshapeData(rawData, profile, chartRec, plan);

    // ─── Step 10: Score Confidence ───────────────────────────────
    console.log('[Pipeline] Step 10: Scoring confidence...');
    const confidence = scoreConfidence(plan, semanticModel, validation, sqlMethod, repairAttempts);
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

    return {
        plan,
        sql: currentSQL,
        validation,
        rawData,
        chartData: reshaped.data,
        profile,
        chart: reshaped.chart,
        confidence,
        explanation: sqlResult.explanation,
        columnsUsed,
        executionTimeMs: Math.round(executionTime),
        repairAttempts,
    };
}
