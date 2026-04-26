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
import { processPlan } from './derivedMetricEngine';

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
    const plan = await generatePlan(augmentedQuestion, semanticModel, grainOverride);

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

    // ─── Step 2c: APDME — Derived Metrics & Guardrails ─────────────
    reportProgress('Analyzing derived metrics...', 3);
    console.log('[Pipeline] Step 2c: Running APDME (Derived Metric Engine)...');
    const apdmeResult = processPlan(plan, semanticModel);
    if (apdmeResult.derivedMetricApplied) {
        console.log(`[Pipeline] APDME: Derived metric applied — ${apdmeResult.derivedMetrics.map(d => d.aggregatedExpression).join(', ')}`);
    }
    if (apdmeResult.violations.length > 0) {
        console.warn(`[Pipeline] APDME: ${apdmeResult.violations.length} guardrail violation(s), penalty: -${apdmeResult.confidencePenalty}`);
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
    let sqlResult = await generateSQLFromPlan(plan, semanticModel, apdmeResult.derivedMetrics);
    const aiGeneratedSQL = sqlResult.sql; // Keep AI's SQL for reference
    const sqlMethod = sqlResult.method;

    // ─── Step 3b: SQL Correction Engine ──────────────────────────
    reportProgress('Correcting SQL...', 5);
    console.log('[Pipeline] Step 3b: Running SQL Correction Engine...');
    let currentSQL: string;
    try {
        currentSQL = correctSQL(plan, semanticModel, apdmeResult.derivedMetrics);
        console.log('[Pipeline] Correction Engine SQL:', currentSQL);
    } catch (correctionErr: any) {
        console.warn('[Pipeline] Correction engine failed, using AI SQL:', correctionErr.message);
        currentSQL = aiGeneratedSQL; // Fallback to AI SQL if engine fails
    }

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
    const validation = validateSQL(currentSQL, plan, semanticModel);

    if (!validation.valid) {
        console.warn('[Pipeline] SQL validation failed:', validation.checks.filter(c => c.status === 'fail'));
    }

    // ─── Step 5: Execute SQL ─────────────────────────────────────
    reportProgress('Executing SQL...', 7);
    console.log('[Pipeline] Step 5: Executing SQL...');
    let execResult = executeSQL(dataset.rows, currentSQL, semanticModel.timeContext);

    // ─── Step 5b: Repair Loop (max 2 attempts) ──────────────────
    while (execResult.error && repairAttempts < 2) {
        repairAttempts++;
        console.log(`[Pipeline] Step 5b: Repair attempt ${repairAttempts}...`);
        try {
            const repaired = await repairSQL(currentSQL, execResult.error, plan, semanticModel, repairAttempts);
            currentSQL = repaired.sql;
            sqlResult.explanation = repaired.explanation;
            execResult = executeSQL(dataset.rows, currentSQL, semanticModel.timeContext);
        } catch (repairErr: any) {
            console.warn(`[Pipeline] Repair attempt ${repairAttempts} failed:`, repairErr.message);
            break;
        }
    }

    if (execResult.error) {
        throw new Error(`SQL execution failed: ${execResult.error}`);
    }

    let rawData = execResult.data || [];
    const columns = execResult.columns || [];

    // ─── Step 5c: Time Intelligence Engine ─────────────────────────
    // AlaSQL doesn't support LAG/LEAD/ROW_NUMBER/SUM OVER window functions.
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

    if (rawData.length === 0) {
        // Build a helpful no-data message instead of throwing
        const tc = semanticModel.timeContext;
        const periodDesc = resolvedTime?.description
            ? `for ${resolvedTime.description}`
            : plan.filters.length > 0 ? 'for the specified filters' : '';
        const rangeNote = tc
            ? ` The dataset contains data from ${tc.minDate} to ${tc.maxDate}.`
            : '';

        const noDataExplanation =
            `No data found ${periodDesc}.${rangeNote} ` +
            `Try broadening your date range, removing filters, or checking if your data covers this period.`;

        console.warn('[Pipeline] Query returned 0 rows —', noDataExplanation);

        const executionTimeEmpty = performance.now() - startTime;
        return {
            plan,
            sql: currentSQL,
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
        };
    }

    // ─── Step 6: Validate Result ─────────────────────────────────
    reportProgress('Validating results...', 8);
    console.log('[Pipeline] Step 6: Validating result...');
    const resultChecks = validateResult(rawData, plan, semanticModel);
    validation.checks.push(...resultChecks);

    // ─── Step 6b: Total Consistency Check ──────────────────────────
    // For trend/breakdown: verify that SUM of parts ≈ grand total
    if (['trend', 'breakdown'].includes(plan.intent) && plan.metrics.length > 0 && rawData.length > 1) {
        try {
            const primaryMetricField = plan.metrics[0].field;
            const primaryAgg = plan.metrics[0].agg;
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
                    if (f.op === 'between' && Array.isArray(f.value)) {
                        return `${f.field} BETWEEN '${f.value[0]}' AND '${f.value[1]}'`;
                    }
                    return `${f.field} ${f.op} '${f.value}'`;
                }).join(' AND ')
                : '';
            const grandTotalSQL = `SELECT ${primaryAgg.toUpperCase()}(${primaryMetricField}) AS grand_total FROM data${filterClause}`;
            const grandResult = executeSQL(dataset.rows, grandTotalSQL, semanticModel.timeContext);

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
    const profile = profileResult(rawData, plan, semanticModel);
    console.log(`[Pipeline] Profile: ${profile.rowCount} rows, ${profile.metricCount} metrics, ${profile.dimensionCount} dims, time=${profile.hasTimeDimension}, scaleMismatch=${profile.metricsScaleMismatch.toFixed(1)}x`);

    // ─── Step 8: Recommend Chart ─────────────────────────────────
    reportProgress('Selecting chart type...', 10);
    console.log('[Pipeline] Step 8: Recommending chart...');
    const chartRec = recommendChart(profile, plan, semanticModel);
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

    // ─── Step 10: Score Confidence ───────────────────────────────
    console.log('[Pipeline] Step 10: Scoring confidence...');
    const confidence = scoreConfidence(plan, semanticModel, validation, sqlMethod, repairAttempts);
    // Apply APDME guardrail penalties (e.g., -50 for SUM on a date column)
    if (apdmeResult.confidencePenalty > 0) {
        confidence.score = Math.max(0, confidence.score - apdmeResult.confidencePenalty);
        confidence.level = confidence.score >= 70 ? 'high' : confidence.score >= 40 ? 'medium' : 'low';
        confidence.reasons.push(...apdmeResult.violations.map(v => v.message));
        console.log(`[Pipeline] APDME penalty applied: -${apdmeResult.confidencePenalty} → ${confidence.score}/100`);
    }
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
    const finalExplanation = dataAnswer || sqlResult.explanation;

    const pipelineResult: AISQLPipelineResult = {
        plan,
        sql: currentSQL,
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
    };


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
