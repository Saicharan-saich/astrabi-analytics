// --- REFACTORED: analysisEngine.ts ---
// Re-exports from extracted modules for backward compatibility
import { AggregationType, AnalysisResult, AnalysisType, ColumnDefinition, ColumnProfile, ColumnType, Dataset, ETLLog, QueryConfig, TimeContext, TimeGrain, SchemaType, CanonicalMapping, QuestionTemplate, QuestionGrain } from "../types";
import * as XLSX from 'xlsx';
import { findMeasure, findDimension } from './semanticModel';
import type { SemanticModel } from './semanticModel';

// Re-export from extracted modules
export { QUESTION_REGISTRY, QUESTION_BANK, getFullQuestionBank, getFullRegistry, getFullQuestionBankForDomain } from './questionRegistry';
export { getDates, excelDateToJSDate } from './dateHelpers';
export { evaluateLocally, validateRequirements, validateGrainSafety } from './evaluateLocally';

import { QUESTION_REGISTRY, getFullRegistry } from './questionRegistry';
import { getDates, excelDateToJSDate } from './dateHelpers';
import { evaluateLocally, validateRequirements } from './evaluateLocally';
import { validateAnalysis } from './analysisValidator';
import { executeSQLViaDuckDB } from './duckdbEngine';
import { pruneRowsForQuery } from './queryPruner';

// --- EXECUTION ENGINE ---
export const runAnalysis = async (dataset: Dataset, query: QueryConfig): Promise<AnalysisResult> => {
    const mapping = resolveMapping(dataset);
    if (query.semanticRoles) {
        Object.assign(mapping.fields, query.semanticRoles);
    }

    // CRITICAL: Never fall back to new Date() — always use the dataset's max date.
    // Using today's date for historical datasets (e.g. 2014-2018 data) produces wrong results.
    const resolvedAsOfDate = query.asOfDate
        || dataset.timeContext?.defaultAnchorDate
        || dataset.timeContext?.maxDate
        || '';
    const dates = getDates(resolvedAsOfDate || new Date().toISOString());

    if (!query.questionId) {
        return { data: [], xKey: '', yKey: '', yLabel: '', insight: '', sql: '', config: query };
    }

    // ═══ GRAIN ENFORCEMENT ═══════════════════════════════════════════
    // If semantic model exists but grain is undefined, warn strongly.
    // This ensures every analysis knows what a row represents.
    const semModel = dataset.semanticModel;
    if (semModel && !semModel.grain) {
        console.warn('[runAnalysis] ⚠️ Dataset grain is not defined in semantic model. Aggregation results may be unreliable.');
    }

    // ═══ CONFIDENCE THRESHOLD ════════════════════════════════════════
    const CONFIDENCE_THRESHOLD = 0.7;

    // ===== DIRECT AI SQL EXECUTION =====
    // If the query has aiSql, execute it directly via alasql — bypass evaluateLocally entirely
    if ((query as any).aiSql) {
        const aiSql = (query as any).aiSql;
        console.log('[runAnalysis] Direct AI SQL execution:', aiSql);
        const sqlResult = await executeSQLViaDuckDB(dataset.rows, aiSql);

        if (sqlResult.error) {
            return { data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', sql: aiSql, config: query, error: `SQL Error: ${sqlResult.error}` };
        }

        // Derive xKey (dimension) and yKey (metric) from result columns
        const cols = sqlResult.columns;
        let xKey = cols[0] || '';
        let yKey = cols.length > 1 ? cols[1] : cols[0] || '';

        // If there are aliases like "total_profit", "total_sales", use them
        const numericCols = cols.filter(c => {
            const firstVal = sqlResult.data[0]?.[c];
            return typeof firstVal === 'number';
        });
        const textCols = cols.filter(c => {
            const firstVal = sqlResult.data[0]?.[c];
            return typeof firstVal === 'string';
        });

        if (textCols.length > 0 && numericCols.length > 0) {
            xKey = textCols[0];
            yKey = numericCols[0];
        }

        // Determine visualization type
        let vis: any = 'bar';
        if (sqlResult.data.length === 1 && cols.length === 1) vis = 'kpiCard';
        else if (cols.length === 1) vis = 'table';

        // ═══ POST-VALIDATE AI SQL AGAINST SEMANTIC MODEL ═══════════════
        // AI-generated SQL bypasses the semantic model's aggregation guards.
        // Check if the SQL incorrectly uses SUM on non-additive metrics.
        const aiWarnings: string[] = [];
        if (semModel) {
            const sqlUpper = aiSql.toUpperCase();
            for (const measure of semModel.measures) {
                if (measure.behavior === 'non_additive') {
                    // Check if SUM is applied to this non-additive column
                    const colPattern = new RegExp(`SUM\\s*\\(\\s*["\`]?${measure.column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`]?\\s*\\)`, 'i');
                    if (colPattern.test(aiSql)) {
                        aiWarnings.push(
                            `⚠️ AI used SUM("${measure.column}") but this metric is non-additive (should use ${measure.aggregation}). Values may be incorrect.`
                        );
                        console.warn(`[runAnalysis] AI SQL VALIDATION: SUM used on non-additive metric "${measure.column}" (expected ${measure.aggregation})`);
                    }
                }
            }
        }

        return {
            data: sqlResult.data, xKey, yKey,
            yLabel: query.questionId || 'AI Query',
            insight: aiWarnings.length > 0
                ? `⚠️ ${aiWarnings.join(' | ')}`
                : `AI SQL Query Result`,
            sql: aiSql, // Show the ORIGINAL AI SQL
            config: query,
            vis,
            kpi: sqlResult.data.length === 1 ? sqlResult.data[0][yKey] : undefined,
            ...(aiWarnings.length > 0 ? { warnings: aiWarnings } : {}),
        };
    }

    // For 'custom_builder', NEVER look up registry — always use a fresh question definition.
    // This prevents saved AI SQL questions (stored in localStorage) from leaking into the Question Builder.
    const dq = query.questionId === 'custom_builder' ? undefined : getFullRegistry().find(q => q.id === query.questionId);

    const activeQ = dq || {
        id: 'custom_builder',
        category: 'Custom',
        question: query.metric
            ? `${query.aggregation || 'Sum'} of ${query.metric}${query.dimension ? ` by ${query.dimension}` : ''}`
            : 'Custom Analysis',
        req: [],
        grain: 'any',
        vis: 'bar',
        sql: ''
    };

    if (!dq && !query.metric) return { data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', sql: '', config: query, error: "Question definition not found." };

    const reqCheck = validateRequirements(activeQ as QuestionTemplate, mapping);
    if (activeQ.id !== 'custom_builder' && !reqCheck.valid) {
        return {
            data: [], xKey: '', yKey: '', yLabel: 'Error', insight: '', config: query,
            error: reqCheck.error,
            sql: `-- Validation Failed\n-- ${reqCheck.error}`
        };
    }

    let sql = activeQ.sql || `-- Dynamic SQL generated for ${activeQ.id}`;

    // ═══ AGGREGATION SAFETY GUARD ═══════════════════════════════════
    // If the semantic model says a metric is non-additive (e.g., current_quantity,
    // unit_price), auto-correct SUM to the model's recommended aggregation.
    // This prevents join-inflated numbers (e.g., 220 stock × 3 rows = 660).
    if (query.metric && dataset.semanticModel) {
        const semMeasure = findMeasure(dataset.semanticModel, query.metric);
        if (semMeasure && semMeasure.behavior === 'non_additive' && query.aggregation === 'SUM') {
            console.warn(`[runAnalysis] ⚠️ AGGREGATION GUARD: "${query.metric}" is non-additive (${semMeasure.behavior}). Auto-correcting SUM → ${semMeasure.aggregation}`);
            query = { ...query, aggregation: semMeasure.aggregation as any };
        }
        // Also guard semi-additive metrics when grouped by time
        if (semMeasure && semMeasure.behavior === 'semi_additive' && query.aggregation === 'SUM') {
            const timeGrains = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
            const dimIsTime = query.dimension && timeGrains.includes(query.dimension);
            if (dimIsTime) {
                console.warn(`[runAnalysis] ⚠️ AGGREGATION GUARD: "${query.metric}" is semi-additive — correcting SUM → MAX for time dimension`);
                query = { ...query, aggregation: 'MAX' as any };
            }
        }
    }
    // ═══ END AGGREGATION SAFETY GUARD ════════════════════════════════

    // ═══ SOURCE-SCHEMA QUERY PRUNING ═════════════════════════════════
    // If ALL queried columns come from a single dimension table (not the
    // fact table), deduplicate rows to eliminate join fan-out before
    // aggregation. e.g., current_quantity grouped by product_name →
    // both from Products → dedup 29 joined rows → 10 unique products.
    let activeRows = dataset.rows;
    const pruneResult = pruneRowsForQuery(dataset.rows, query, dataset.sourceSchema);
    if (pruneResult.pruned) {
        activeRows = pruneResult.rows;
        console.log(`[runAnalysis] 🔀 QUERY PRUNING: ${pruneResult.log}`);
    }

    const { data, xKey, yKey, kpi, growth, sql: generatedSQL } = evaluateLocally(activeQ as any, activeRows, mapping, dates, query, dataset.name, dataset.dimDate);

    // INJECT DATE FILTERS INTO SQL PREVIEW
    let finalSQL = generatedSQL || sql;
    if (query.dateFilters && query.dateFilters.length > 0) {
        const whereClauses = query.dateFilters.map((df: any) => {
            const valStr = df.values.map((v: string) => `'${v}'`).join(', ');
            return `${df.column} IN (${valStr})`;
        });

        const filterStr = whereClauses.join(' AND ');

        if (finalSQL.includes('WHERE')) {
            finalSQL = finalSQL.replace('WHERE', `WHERE ${filterStr} AND`);
        } else if (finalSQL.includes('GROUP BY')) {
            finalSQL = finalSQL.replace('GROUP BY', `WHERE ${filterStr}\nGROUP BY`);
        } else if (finalSQL.includes('ORDER BY')) {
            finalSQL = finalSQL.replace('ORDER BY', `WHERE ${filterStr}\nORDER BY`);
        } else {
            finalSQL += `\nWHERE ${filterStr}`;
        }
    }

    // Heuristic for Custom Visualization
    let visuals = activeQ.vis || 'bar';
    if (activeQ.id === 'custom_builder') {
        const d = query.dimension;
        const lowerD = (d || '').toLowerCase();

        // No dimension = scalar KPI → show as card
        if (!d || d === '') {
            visuals = 'kpiCard';
        } else if (['minute', 'hour', 'day', 'week', 'month', 'year'].includes(d) || query.timeFilter?.startsWith('last_')) {
            visuals = 'line';
        } else if (d === 'status' || d === 'source') {
            visuals = 'pie';
        } else if (['country', 'state', 'city', 'region', 'province', 'territory'].includes(lowerD) || lowerD.includes('location') || lowerD.includes('geo')) {
            // Auto-detect geographic dimensions — use bar chart (map is unreliable)
            visuals = 'bar';
        } else {
            visuals = 'bar';
        }
    }

    // ─── VALIDATOR: Pre-execution ─────────────────────────────────
    const preValidation = validateAnalysis.pre(dataset, query);

    // ─── VALIDATOR: SQL validation ───────────────────────────────
    const sqlValidation = validateAnalysis.sql(finalSQL, dataset);

    const analysisResult: AnalysisResult = {
        data, xKey, yKey, yLabel: activeQ.question, kpi,
        insight: `${activeQ.question}`,
        sql: finalSQL,
        config: query,
        vis: visuals as any,
        growth,
        // ── System Correction Directive: Confidence + Warnings ──
        confidence: 1.0,
        warnings: [],
    };

    // ── Compute confidence score ──
    const resultWarnings: string[] = [];
    let confidence = 1.0;
    const model = dataset.semanticModel;

    // Grain penalty
    if (model && !model.grain) {
        confidence -= 0.1;
        resultWarnings.push('Dataset grain not defined — row identity is ambiguous');
    }

    if (!model) {
        confidence -= 0.15;
        resultWarnings.push('No semantic model — aggregation may be inferred');
    } else {
        // Validate metric against semantic model
        if (query.metric) {
            const measure = findMeasure(model, query.metric);
            if (!measure) {
                confidence -= 0.1;
                resultWarnings.push(`Metric "${query.metric}" not in semantic model`);
            } else if (query.aggregation && query.aggregation !== measure.aggregation) {
                if (measure.behavior === 'non_additive' && query.aggregation === AggregationType.SUM) {
                    confidence -= 0.2;
                    resultWarnings.push(`Unsafe aggregation: SUM on non-additive metric "${query.metric}". Should use ${measure.aggregation}`);
                }
            }
        }
        // Validate dimension
        if (query.dimension) {
            const dim = findDimension(model, query.dimension);
            if (!dim) {
                confidence -= 0.05;
                resultWarnings.push(`Dimension "${query.dimension}" not in semantic model`);
            }
        }
    }

    // Check data quality
    if (data.length === 0) {
        confidence -= 0.3;
        resultWarnings.push('Query returned zero rows');
    }

    // Check for high null rate in metric column
    if (query.metric && dataset.rows.length > 0) {
        const nullCount = dataset.rows.filter(r => r[query.metric] === null || r[query.metric] === undefined).length;
        const nullRate = nullCount / dataset.rows.length;
        if (nullRate > 0.3) {
            confidence -= 0.1;
            resultWarnings.push(`High null rate (${Math.round(nullRate * 100)}%) in metric "${query.metric}"`);
        }
    }

    // Check for join-based datasets
    if (dataset.sourceSchema?.joinEdges && dataset.sourceSchema.joinEdges.length > 0) {
        confidence -= 0.05;
        resultWarnings.push('Data includes joined tables — verify no row duplication');

        // ═══ POST-AGGREGATION SANITY CHECK (P2 #7) ═══════════════════
        // Compare aggregated total against raw column total to detect join inflation.
        // If aggregated sum > 150% of raw unique-dimension sum, flag it.
        if (query.metric && query.aggregation !== 'COUNT' && query.aggregation !== 'COUNT_DISTINCT' && data.length > 1) {
            const aggTotal = data.reduce((s: number, r: any) => s + (Number(r[yKey]) || 0), 0);
            // Compute a reference: sum only unique dimension values from raw data
            const rawTotal = activeRows.reduce((s: number, r: any) => {
                const v = r[query.metric];
                return s + (typeof v === 'number' ? v : (Number(String(v || '0').replace(/[$€£¥,]/g, '')) || 0));
            }, 0);
            if (rawTotal > 0 && aggTotal > rawTotal * 1.5) {
                const inflationPct = Math.round((aggTotal / rawTotal) * 100);
                confidence -= 0.15;
                resultWarnings.push(`Possible join inflation: aggregated total (${aggTotal.toLocaleString()}) is ${inflationPct}% of raw total (${rawTotal.toLocaleString()})`);
                console.warn(`[runAnalysis] ⚠️ JOIN INFLATION DETECTED: agg=${aggTotal}, raw=${rawTotal}, ratio=${inflationPct}%`);
            }
        }
    }

    // ═══ POST-VALIDATION CONFIDENCE INTEGRATION (P3 #11) ═════════
    // Integrate the validator's post-execution checks into confidence scoring
    const postValCheck = validateAnalysis.post(analysisResult, dataset);
    if (postValCheck.status === 'error') {
        confidence -= 0.2;
        resultWarnings.push(...postValCheck.checks.filter(c => c.status === 'fail').map(c => c.message));
    } else if (postValCheck.status === 'warning') {
        confidence -= 0.05;
        resultWarnings.push(...postValCheck.checks.filter(c => c.status === 'warn').map(c => c.message));
    }

    analysisResult.confidence = Math.max(0, Math.min(1, confidence));
    analysisResult.warnings = resultWarnings;

    // ── Explainability ──
    if (query.metric && query.dimension) {
        const aggLabel = model ? (findMeasure(model, query.metric)?.aggregation || query.aggregation || 'SUM') : (query.aggregation || 'SUM');
        const filtersApplied: string[] = [];
        if (query.filters) {
            for (const [dim, vals] of Object.entries(query.filters)) {
                filtersApplied.push(`${dim} IN (${vals.join(', ')})`);
            }
        }
        if (query.dateFilters) {
            for (const df of query.dateFilters) {
                filtersApplied.push(`${df.column} IN (${df.values.join(', ')})`);
            }
        }
        analysisResult.explainability = {
            metric: query.metric,
            aggregation: String(aggLabel),
            sourceColumn: query.metric,
            dimension: query.dimension,
            filtersApplied,
            rowsProcessed: dataset.rows.length,
        };
    }

    // ── HARD CONFIDENCE THRESHOLD — Block unreliable results ──
    if (analysisResult.confidence < CONFIDENCE_THRESHOLD && data.length > 0) {
        return {
            data: [],
            xKey: analysisResult.xKey,
            yKey: analysisResult.yKey,
            yLabel: analysisResult.yLabel,
            insight: '',
            sql: analysisResult.sql,
            config: query,
            confidence: analysisResult.confidence,
            warnings: resultWarnings,
            explainability: analysisResult.explainability,
            error: `Result confidence (${Math.round(analysisResult.confidence * 100)}%) is below the reliability threshold (${Math.round(CONFIDENCE_THRESHOLD * 100)}%). ` +
                `Issues: ${resultWarnings.join('; ')}. ` +
                `Fix these issues or refine your query for a trustworthy result.`,
        };
    }

    // ─── VALIDATOR: Attach validation results ───────────────────
    analysisResult.validation = {
        pre: preValidation,
        sql: sqlValidation,
        post: postValCheck
    };

    return analysisResult;
};

// --- ETL & UTILS ---
export const inferColumnType = (key: string, sampleValues: any[]): ColumnType => {
    const lower = key.toLowerCase().trim();

    // 1. FORCE ID - Comprehensive ID patterns
    const idPatterns = [
        'id', 'row_id', 'record_id', 'pk', 'key',
        '_id', '_key', '_code', '_number', '_num',
        'sku', 'upc', 'barcode', 'isbn', 'ean',
        'zip', 'zipcode', 'postal', 'postcode',
        'ssn', 'ein', 'tin', 'vat',
        'guid', 'uuid', 'hash',
        'reference', 'ref_', 'confirmation',
        'tracking', 'serial', 'license'
    ];

    if (idPatterns.some(pattern =>
        lower === pattern ||
        lower.endsWith(pattern) ||
        lower.startsWith(pattern + '_') ||
        lower.includes('_' + pattern + '_')
    )) return ColumnType.ID;

    // 2. FORCE DATE - Comprehensive date/time patterns
    const datePatterns = [
        'date', 'time', 'timestamp', 'datetime',
        'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
        'created', 'updated', 'modified', 'deleted',
        'start', 'end', 'begin', 'finish',
        'due', 'expiry', 'expires', 'expired',
        'birth', 'dob', 'anniversary',
        'scheduled', 'published', 'posted'
    ];

    if (datePatterns.some(pattern => lower.includes(pattern))) {
        return ColumnType.DATE;
    }

    // 3. FORCE DIMENSION - Geographic, categorical, and descriptive data (CHECK BEFORE METRICS)
    const dimensionKeywords = [
        // Geographic
        'country', 'state', 'province', 'region', 'city', 'town',
        'continent', 'territory', 'district', 'county', 'area',
        'location', 'address', 'street', 'avenue', 'road',

        // Categorical
        'category', 'type', 'kind', 'class', 'group', 'segment',
        'status', 'stage', 'phase', 'level', 'tier',
        'priority', 'severity', 'urgency',

        // Descriptive
        'name', 'title', 'description', 'label', 'tag',
        'color', 'style', 'model', 'version',
        'brand', 'manufacturer', 'vendor', 'supplier',

        // Currency/Financial descriptors (not amounts)
        'currency', 'currency_code', 'payment_method', 'payment_type',

        // Boolean-like (treat as dimensions for grouping)
        'is_', 'has_', 'can_', 'should_', 'flag', 'active', 'enabled',

        // Modes/Methods
        'mode', 'method', 'via', 'channel'
    ];

    if (dimensionKeywords.some(k => lower.includes(k))) {
        return ColumnType.DIMENSION;
    }

    // 3.5 BOOLEAN DATA CHECK — must run BEFORE metric keywords to catch columns like 'returned' (0/1)
    const validForBool = sampleValues.filter(v => v !== null && v !== '' && v !== undefined);
    if (validForBool.length > 0) {
        const booleanValues = validForBool.filter(v => {
            const str = String(v).toLowerCase().trim();
            return ['true', 'false', '1', '0', 'yes', 'no', 't', 'f', 'y', 'n'].includes(str);
        });
        // Also check if the column has only 2 distinct values (strong boolean signal)
        const distinctValues = new Set(validForBool.map(v => String(v).toLowerCase().trim()));
        const isBinaryColumn = distinctValues.size <= 2;

        if (booleanValues.length / validForBool.length > 0.8 || (isBinaryColumn && booleanValues.length > 0)) {
            return ColumnType.DIMENSION; // Booleans are categorical, not metrics
        }
    }

    // 4. FORCE METRIC - Comprehensive numeric/financial patterns
    const metricKeywords = [
        // Financial
        'price', 'cost', 'amount', 'total', 'subtotal', 'grand_total',
        'revenue', 'sales', 'income', 'earnings', 'profit', 'loss',
        'margin', 'markup', 'discount', 'rebate', 'refund',
        'tax', 'vat', 'duty', 'fee', 'charge', 'surcharge',
        'balance', 'credit', 'debit', 'payment', 'deposit',
        'budget', 'forecast', 'target', 'quota', 'goal',
        'value', 'worth', 'valuation', 'appraisal',

        // Quantities
        'quantity', 'qty', 'count', 'number_of', 'num_of',
        'units', 'items', 'pieces', 'volume', 'weight',
        'length', 'width', 'height', 'depth', 'size',
        'capacity', 'limit', 'maximum', 'minimum',

        // Metrics & KPIs
        'rate', 'ratio', 'percentage', 'percent', 'pct',
        'score', 'rating', 'rank', 'index', 'factor',
        'growth', 'change', 'delta', 'variance', 'deviation',
        'average', 'mean', 'median',
        'sum', 'total', 'aggregate',

        // Business metrics
        'conversion', 'retention', 'churn', 'attrition',
        'engagement', 'reach', 'impressions', 'clicks',
        'views', 'visits', 'sessions', 'users', 'customers',
        'orders', 'transactions', 'bookings', 'reservations',

        // Inventory & Operations
        'stock', 'inventory', 'on_hand', 'available',
        'shipped', 'delivered', 'returned', 'damaged',
        'lead_time', 'cycle_time', 'duration', 'elapsed',

        // HR & People
        'salary', 'wage', 'compensation', 'bonus', 'commission',
        'hours', 'overtime', 'pto', 'vacation', 'sick_days',
        'headcount', 'fte', 'employees', 'staff'
    ];

    if (metricKeywords.some(k => lower.includes(k))) {
        return ColumnType.METRIC;
    }

    // 5. DATA CONTENT ANALYSIS
    const valid = sampleValues.filter(v => v !== null && v !== '' && v !== undefined);
    if (valid.length === 0) return ColumnType.DIMENSION; // Default to dim if empty

    const numCount = valid.filter(v => {
        const s = String(v).replace(/[$,\s%]/g, ''); // Remove currency, pct, whitespace
        return !isNaN(Number(s)) && s.trim() !== '';
    }).length;

    const numericRatio = numCount / valid.length;

    // If >90% numeric, treat as metric (unless it looked like an ID earlier, which is already handled)
    if (numericRatio > 0.9) return ColumnType.METRIC;

    return ColumnType.DIMENSION;
};

// --- Delegated to etlPipeline.ts ---
import { runETLPipeline } from './etlPipeline';

export const runAutomatedETL = (
    rawData: any[],
    fileName: string,
    columnTypeOverrides?: Record<string, ColumnType>
): { rows: any[], logs: ETLLog[], columns: ColumnDefinition[], timeContext?: TimeContext, dimDate?: import('../types').DimDateRow[] } => {
    const result = runETLPipeline(rawData, fileName, columnTypeOverrides);
    return {
        rows: result.rows,
        logs: result.logs,
        columns: result.columns,
        timeContext: result.timeContext,
        dimDate: result.dimDate,
    };
};

export const autoPickConfig = (dataset: Dataset, intent: any, asOfDate?: string): QueryConfig => {
    return {
        questionId: intent?.questionId,
        asOfDate,
        metric: '', dimension: '', aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD
    };
};

// ═══════════════════════════════════════════════════════════════════
// DYNAMIC AGGREGATION INFERENCE — Works for ANY domain automatically
// Analyzes column metadata to determine the correct aggregation.
// Priority: AI profile hints > column name patterns > data range > SUM default
// ═══════════════════════════════════════════════════════════════════
export const inferAggregationForColumn = (dataset: Dataset, columnName: string): { agg: string; format: string } => {
    const col = dataset.columns.find(c => c.name.toLowerCase() === columnName.toLowerCase());
    const lowerName = columnName.toLowerCase();

    // ════════════════════════════════════════════════════
    // SEMANTIC MODEL PATH (deterministic — no fallbacks)
    // ════════════════════════════════════════════════════
    if (dataset.semanticModel) {
        const measure = findMeasure(dataset.semanticModel, columnName);
        if (measure) {
            return {
                agg: measure.aggregation,
                format: measure.format === 'currency_usd' || measure.format === 'currency_eur' ? 'currency'
                    : measure.format === 'percent' ? 'percent'
                        : measure.format === 'count' ? 'count'
                            : 'raw',
            };
        }
        // ── HARD FAIL: metric not in semantic model ──
        // No heuristics allowed when model exists. This ensures
        // every aggregation is deterministic and auditable.
        throw new Error(
            `[DETERMINISTIC GUARD] Metric "${columnName}" is not defined in the semantic model. ` +
            `Available measures: ${dataset.semanticModel.measures.map(m => m.name).join(', ')}. ` +
            `Add this metric to the semantic model or check the column name.`
        );
    }

    // ════════════════════════════════════════════════════
    // LEGACY PATH — only when NO semantic model exists
    // (backward compatibility for datasets loaded before
    //  semantic model was introduced)
    // ════════════════════════════════════════════════════
    if (dataset.domainProfile?.columnSemantics) {
        const sem = Object.entries(dataset.domainProfile.columnSemantics)
            .find(([k]) => k.toLowerCase() === lowerName)?.[1];
        if (sem) {
            const fmtStr = String(sem.format || '').toLowerCase();
            const aggStr = String(sem.aggregation || '').toLowerCase();
            if (fmtStr.includes('percent')) return { agg: 'AVG', format: 'percent' };
            if (aggStr === 'avg' || aggStr === 'average') return { agg: 'AVG', format: fmtStr || 'raw' };
            if (aggStr === 'count') return { agg: 'COUNT', format: 'count' };
            if (aggStr === 'count_distinct') return { agg: 'COUNT_DISTINCT', format: 'count' };
            if (fmtStr.includes('currency') || fmtStr.includes('money')) return { agg: 'SUM', format: 'currency' };
        }
    }

    // Legacy heuristic fallbacks (name patterns)
    const ratePatterns = ['rate', 'percentage', 'pct', 'percent', '_pct', '_rate', 'margin', 'yield', 'efficiency'];
    if (ratePatterns.some(p => lowerName.includes(p))) return { agg: 'AVG', format: 'percent' };

    const scorePatterns = ['score', 'gpa', 'grade', 'rating', 'satisfaction', 'nps', 'index', 'mark', 'points'];
    if (scorePatterns.some(p => lowerName.includes(p))) return { agg: 'AVG', format: 'score' };

    const ratioPatterns = ['ratio', 'per_capita', 'per_student', 'per_employee', 'per_patient', 'average', 'avg_', 'mean_'];
    if (ratioPatterns.some(p => lowerName.includes(p))) return { agg: 'AVG', format: 'ratio' };

    if (col && col.type === ColumnType.ID) return { agg: 'COUNT_DISTINCT', format: 'count' };
    const idPatterns = ['_id', 'id_', 'identifier', 'key'];
    if (idPatterns.some(p => lowerName.includes(p)) || lowerName.endsWith('id')) return { agg: 'COUNT_DISTINCT', format: 'count' };

    const countPatterns = ['count', 'headcount', 'qty', 'quantity', 'units', 'volume', 'num_', 'number_of', 'total_'];
    if (countPatterns.some(p => lowerName.includes(p))) return { agg: 'SUM', format: 'count' };

    const amountPatterns = ['revenue', 'sales', 'amount', 'price', 'cost', 'fee', 'tuition', 'salary', 'wage',
        'payment', 'income', 'expense', 'profit', 'billing', 'invoice', 'total', 'spend', 'budget', 'value'];
    if (amountPatterns.some(p => lowerName.includes(p))) return { agg: 'SUM', format: 'currency' };

    return { agg: 'SUM', format: 'raw' };
};

export const resolveMapping = (dataset: Dataset): CanonicalMapping => {
    const columns = dataset.columns.map(c => c.name);
    const fields: Record<string, string> = {};

    // ═══════════════════════════════════════════════════════════════════
    // FAST PATH: Use AI Domain Profile if available (100% accurate)
    // This completely bypasses the regex synonym dictionary below.
    // The AI profile is generated once at upload time by aiSemanticProfiler.ts
    // ═══════════════════════════════════════════════════════════════════
    if (dataset.domainProfile?.columnSemantics) {
        const semantics = dataset.domainProfile.columnSemantics;
        console.log(`[resolveMapping] Using AI domain profile: ${dataset.domainProfile.domain}`);

        for (const [colName, sem] of Object.entries(semantics)) {
            if (sem.isHidden) continue; // Skip junk columns

            // Map by semanticRole to canonical field names
            if (sem.semanticRole === 'primary_metric') {
                if (!fields['revenue']) fields['revenue'] = colName;
            } else if (sem.semanticRole === 'secondary_metric') {
                // Map to known secondary metric roles
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('profit') || lowerLabel.includes('margin')) {
                    if (!fields['profit']) fields['profit'] = colName;
                } else if (lowerLabel.includes('cost') || lowerLabel.includes('expense')) {
                    if (!fields['cost']) fields['cost'] = colName;
                } else if (lowerLabel.includes('discount') || lowerLabel.includes('rebate')) {
                    if (!fields['discount']) fields['discount'] = colName;
                } else if (lowerLabel.includes('quantity') || lowerLabel.includes('count') || lowerLabel.includes('units')) {
                    if (!fields['quantity']) fields['quantity'] = colName;
                } else if (lowerLabel.includes('stock') || lowerLabel.includes('inventory')) {
                    if (!fields['stock']) fields['stock'] = colName;
                } else if (lowerLabel.includes('rating') || lowerLabel.includes('score')) {
                    if (!fields['rating']) fields['rating'] = colName;
                }
            } else if (sem.semanticRole === 'primary_date') {
                if (!fields['order_date']) fields['order_date'] = colName;
            } else if (sem.semanticRole === 'secondary_date') {
                if (!fields['ship_date']) fields['ship_date'] = colName;
            } else if (sem.semanticRole === 'primary_dimension') {
                if (!fields['product_name']) fields['product_name'] = colName;
            } else if (sem.semanticRole === 'secondary_dimension') {
                // Map to known secondary dimension roles
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('customer') || lowerLabel.includes('client') || lowerLabel.includes('patient') || lowerLabel.includes('employee')) {
                    if (!fields['customer_name']) fields['customer_name'] = colName;
                } else if (lowerLabel.includes('category') || lowerLabel.includes('department') || lowerLabel.includes('ward')) {
                    if (!fields['category']) fields['category'] = colName;
                } else if (lowerLabel.includes('region') || lowerLabel.includes('area') || lowerLabel.includes('territory')) {
                    if (!fields['region']) fields['region'] = colName;
                } else if (lowerLabel.includes('channel') || lowerLabel.includes('source') || lowerLabel.includes('medium')) {
                    if (!fields['source']) fields['source'] = colName;
                } else if (lowerLabel.includes('campaign') || lowerLabel.includes('promotion')) {
                    if (!fields['campaign']) fields['campaign'] = colName;
                } else if (lowerLabel.includes('segment') || lowerLabel.includes('tier')) {
                    if (!fields['segment']) fields['segment'] = colName;
                } else if (lowerLabel.includes('city') || lowerLabel.includes('town')) {
                    if (!fields['city']) fields['city'] = colName;
                } else if (lowerLabel.includes('state') || lowerLabel.includes('province')) {
                    if (!fields['state']) fields['state'] = colName;
                } else if (lowerLabel.includes('country') || lowerLabel.includes('nation')) {
                    if (!fields['country']) fields['country'] = colName;
                } else if (lowerLabel.includes('status') || lowerLabel.includes('stage')) {
                    if (!fields['status']) fields['status'] = colName;
                }
            } else if (sem.semanticRole === 'identifier') {
                const lowerLabel = sem.humanLabel.toLowerCase();
                if (lowerLabel.includes('order') || lowerLabel.includes('transaction') || lowerLabel.includes('invoice')) {
                    if (!fields['order_id']) fields['order_id'] = colName;
                } else if (lowerLabel.includes('product') || lowerLabel.includes('item') || lowerLabel.includes('sku')) {
                    if (!fields['product_id']) fields['product_id'] = colName;
                } else if (lowerLabel.includes('customer') || lowerLabel.includes('client') || lowerLabel.includes('patient') || lowerLabel.includes('employee')) {
                    if (!fields['customer_id']) fields['customer_id'] = colName;
                }
            }

            // ═══════════════════════════════════════════════════════════════════
            // DOMAIN-AWARE: Map rate/score/ratio columns regardless of semanticRole
            // These are new canonical roles used by domain-specific questions.
            // ═══════════════════════════════════════════════════════════════════
            const lbl = (sem.humanLabel || colName).toLowerCase();
            const fmt = sem.format || 'raw';

            // Rate/Percentage columns — attendance rate, graduation rate, pass rate, etc.
            if (!fields['rate'] && (fmt === 'percent' || lbl.includes('rate') || lbl.includes('percentage') || lbl.includes('pct') || lbl.includes('percent'))) {
                if (sem.role === 'METRIC' || sem.role === 'UNKNOWN') fields['rate'] = colName;
            }

            // Score columns — GPA, test score, satisfaction score, etc.
            if (!fields['score'] && (lbl.includes('score') || lbl.includes('gpa') || lbl.includes('grade') || lbl.includes('mark') || lbl.includes('points'))) {
                if (sem.role === 'METRIC' || sem.role === 'UNKNOWN') fields['score'] = colName;
            }

            // Ratio columns — student-to-faculty ratio, etc.
            if (!fields['ratio'] && (lbl.includes('ratio') || lbl.includes('per capita') || lbl.includes('per student'))) {
                if (sem.role === 'METRIC' || sem.role === 'UNKNOWN') fields['ratio'] = colName;
            }
        }

        // Fallback: if no dedicated 'rate' or 'score' was found but primary_metric exists,
        // map rate/score to primary_metric so questions still resolve to something
        if (!fields['rate'] && fields['revenue']) fields['rate'] = fields['revenue'];
        if (!fields['score'] && fields['revenue']) fields['score'] = fields['revenue'];
        if (!fields['ratio'] && fields['revenue']) fields['ratio'] = fields['revenue'];

        console.log('[resolveMapping] AI Semantic roles:', fields);
        return { schemaType: 'flat', fields, missingFields: [] };
    }

    // ═══════════════════════════════════════════════════════════════════
    // FALLBACK: COMPREHENSIVE SYNONYM DICTIONARY — Covers global naming conventions
    // Each role maps to an array of synonyms (lowercase). The engine will
    // match exact, stem, token, contains, and prefix to find the best fit.
    // ═══════════════════════════════════════════════════════════════════
    const heuristics: Record<string, string[]> = {
        'revenue': [
            // English
            'revenue', 'sales', 'sale', 'total_sales', 'net_sales', 'gross_sales',
            'amount', 'total_amount', 'net_amount', 'gross_amount', 'transaction_amount',
            'sale_amount', 'sales_amount', 'sale_amt', 'sales_amt', 'amt',
            'price', 'unit_price', 'selling_price', 'sale_price', 'list_price',
            'total_price', 'extended_price', 'line_total', 'order_total',
            'value', 'total_value', 'order_value', 'transaction_value', 'purchase_amount',
            'income', 'total_income', 'gross_income', 'net_income',
            'turnover', 'total_turnover', 'gross_turnover',
            'proceeds', 'receipts', 'total_receipts',
            'billing', 'billed_amount', 'invoice_amount', 'invoice_total',
            'gmv', 'gross_merchandise_value', 'merchandise_value',
            'rev', 'total_rev', 'net_rev', 'gross_rev',
            'total', 'grand_total', 'subtotal', 'sub_total',
            'payment', 'payment_amount', 'pay_amount', 'pay_amt',
            'spend', 'total_spend', 'expenditure',
            'earnings', 'total_earnings',
            'money', 'cash', 'dollars', 'usd', 'gbp', 'eur',
            'topline', 'top_line',
            // Abbreviated
            'tot_sales', 'tot_amt', 'tot_rev', 'ttl_sales', 'ttl_amt',
            'sls', 'sls_amt', 'sl_amt', 'rev_amt',
        ],
        'profit': [
            'profit', 'net_profit', 'gross_profit', 'total_profit',
            'margin', 'net_margin', 'gross_margin', 'profit_margin',
            'earnings', 'net_earnings', 'operating_income', 'operating_profit',
            'ebitda', 'ebit', 'bottom_line', 'pnl', 'p_and_l',
            'contribution', 'contribution_margin',
            'surplus', 'gain', 'net_gain',
            'prof', 'prft', 'mrgn',
        ],
        'cost': [
            'cost', 'total_cost', 'unit_cost', 'cogs', 'cost_of_goods',
            'cost_of_goods_sold', 'cost_price', 'purchase_price', 'buying_price',
            'expense', 'expenses', 'total_expense', 'operating_expense',
            'opex', 'capex', 'overhead', 'cost_amount', 'cost_amt',
        ],
        'discount': [
            'discount', 'discount_amount', 'discount_amt', 'disc', 'disc_amt',
            'discount_pct', 'discount_percent', 'discount_rate', 'rebate',
            'markdown', 'allowance', 'deduction', 'promo_discount',
            'coupon', 'coupon_amount', 'voucher', 'voucher_amount',
        ],
        'order_date': [
            'order_date', 'orderdate', 'date', 'transaction_date', 'txn_date',
            'purchase_date', 'sale_date', 'saledate', 'sales_date',
            'created_at', 'created_date', 'creation_date', 'create_date',
            'invoice_date', 'billing_date', 'booking_date', 'record_date',
            'entry_date', 'posted_date', 'posting_date', 'effective_date',
            'order_dt', 'txn_dt', 'trans_date', 'trans_dt',
            'dt', 'ord_date', 'ord_dt',
            'event_date', 'activity_date', 'interaction_date',
            'period', 'period_date', 'report_date', 'reporting_date',
        ],
        'ship_date': [
            'ship_date', 'shipped_date', 'shipping_date', 'delivery_date',
            'dispatch_date', 'fulfillment_date', 'fulfilled_date',
            'ship_dt', 'delivery_dt', 'dispatch_dt', 'shipdate',
            'received_date', 'arrival_date', 'eta', 'delivered_date',
            'completion_date', 'close_date',
        ],
        'order_id': [
            'order_id', 'orderid', 'order_number', 'order_no', 'order_num',
            'transaction_id', 'txn_id', 'invoice_id', 'invoice_number',
            'invoice_no', 'receipt_id', 'receipt_no', 'ticket_id',
            'confirmation_number', 'reference_number', 'ref_no', 'ref_id',
            'po_number', 'purchase_order', 'booking_id', 'booking_no',
            'ord_id', 'ord_no', 'sale_id', 'sales_id',
        ],
        'product_name': [
            'product_name', 'product', 'product_title', 'product_label',
            'item_name', 'item', 'item_title', 'item_description',
            'product_description', 'sku_name', 'sku_description',
            'goods', 'merchandise', 'article', 'article_name',
            'prod_name', 'prod', 'prod_desc', 'item_desc',
            'material', 'material_name', 'material_description',
            'offering', 'service_name', 'service',
        ],
        'product_id': [
            'product_id', 'productid', 'sku', 'sku_id', 'sku_code',
            'item_id', 'item_code', 'item_number', 'item_no',
            'upc', 'ean', 'asin', 'barcode', 'part_number', 'part_no',
            'prod_id', 'prod_code', 'article_id', 'article_no',
            'material_id', 'material_no', 'catalog_id',
        ],
        'quantity': [
            'quantity', 'qty', 'units', 'unit_count', 'count',
            'items_sold', 'units_sold', 'qty_sold', 'quantity_sold',
            'order_quantity', 'order_qty', 'sales_qty', 'sale_qty',
            'volume', 'pcs', 'pieces', 'num_items', 'number_of_items',
            'item_count', 'total_qty', 'total_quantity',
            'demand', 'ordered', 'shipped_qty', 'delivered_qty',
        ],
        'customer_id': [
            'customer_id', 'customerid', 'cust_id', 'custid', 'client_id',
            'buyer_id', 'account_id', 'acct_id', 'user_id', 'userid',
            'member_id', 'memberid', 'subscriber_id', 'patron_id',
            'shopper_id', 'consumer_id', 'party_id',
            'email', 'email_address', 'customer_email',
            // Cross-domain: HR
            'emp_id', 'employee_id', 'empid', 'staff_id', 'staffid',
            'worker_id', 'workerid', 'personnel_id', 'associate_id',
            // Cross-domain: Healthcare
            'patient_id', 'patientid', 'mrn', 'medical_record_number',
            // Cross-domain: Education
            'student_id', 'studentid', 'learner_id', 'enrollment_id',
            'faculty_id', 'teacher_id', 'instructor_id',
        ],
        'customer_name': [
            'customer_name', 'customer', 'client_name', 'client',
            'buyer_name', 'buyer', 'account_name', 'account',
            'full_name', 'name', 'contact_name', 'contact',
            'first_name', 'last_name', 'person_name', 'person',
            'member_name', 'member', 'subscriber_name',
            'cust_name', 'cust', 'patron_name', 'patron',
            'user_name', 'username', 'display_name',
            // Cross-domain: HR
            'emp_name', 'employee_name', 'staff_name', 'worker_name',
            'associate_name', 'personnel_name',
            // Cross-domain: Healthcare
            'patient_name', 'patient',
            // Cross-domain: Education
            'student_name', 'student', 'learner_name',
            'faculty_name', 'teacher_name', 'instructor_name',
        ],
        'category': [
            'category', 'product_category', 'item_category',
            'sub_category', 'subcategory', 'sub category',
            'department', 'division', 'section',
            'class', 'classification', 'group', 'product_group',
            'type', 'product_type', 'item_type',
            'family', 'product_family', 'product_line', 'line',
            'cat', 'categ', 'prod_cat', 'main_category',
            'tier', 'level', 'hierarchy',
        ],
        'segment': [
            'segment', 'customer_segment', 'market_segment',
            'tier', 'customer_tier', 'loyalty_tier',
            'cohort', 'customer_cohort', 'customer_type', 'customer_group',
            'persona', 'demographic', 'psychographic',
            'classification', 'rating', 'grade', 'rank',
            'buyer_type', 'account_type',
        ],
        'source': [
            'source', 'utm_source', 'traffic_source', 'acquisition_source',
            'lead_source', 'referral_source', 'origin', 'referral',
            'acquisition_channel', 'marketing_source',
            'src', 'ref', 'referrer',
        ],
        'channel': [
            'channel', 'sales_channel', 'distribution_channel',
            'marketing_channel', 'medium', 'utm_medium',
            'platform', 'marketplace', 'storefront', 'store',
            'outlet', 'venue', 'touchpoint', 'point_of_sale', 'pos',
        ],
        'campaign': [
            'campaign', 'campaign_name', 'campaign_id',
            'utm_campaign', 'promo', 'promotion', 'promotion_name',
            'ad_campaign', 'marketing_campaign', 'initiative',
        ],
        'region': [
            'region', 'area', 'territory', 'zone', 'geography', 'geo',
            'market', 'market_area', 'sales_region', 'sales_territory',
            'district', 'division', 'locale', 'location',
        ],
        'city': [
            'city', 'city_name', 'metro', 'metro_area', 'town',
            'municipality', 'urban_area', 'locality',
        ],
        'state': [
            'state', 'state_name', 'province', 'province_name',
            'county', 'county_name', 'prefecture',
            'administrative_area', 'admin_area',
        ],
        'country': [
            'country', 'country_name', 'nation', 'country_code',
            'iso_country', 'territory',
        ],
        'ship_mode': [
            'ship_mode', 'shipping_mode', 'shipping_method', 'delivery_method',
            'shipment_type', 'shipping_type', 'freight_type',
            'carrier', 'shipping_carrier', 'courier',
            'delivery_type', 'fulfillment_method', 'ship_method',
            'shipping', 'transport', 'transport_mode',
        ],
        'stock': [
            'inventory', 'stock', 'qty_on_hand', 'quantity_on_hand',
            'stock_level', 'stock_qty', 'available_qty',
            'on_hand', 'warehouse_qty', 'supply',
            'stock_count', 'inventory_level', 'inventory_count',
        ],
        'rating': [
            'rating', 'review_rating', 'score', 'stars',
            'customer_rating', 'product_rating', 'satisfaction',
            'nps', 'net_promoter_score', 'feedback_score',
            'quality_score', 'avg_rating', 'average_rating',
        ],
        'status': [
            'status', 'order_status', 'shipment_status', 'delivery_status',
            'payment_status', 'fulfillment_status', 'state',
            'condition', 'stage', 'phase', 'progress',
        ],
        // Domain-aware canonical roles
        'rate': [
            'rate', 'percentage', 'pct', 'percent',
            'graduation_rate', 'dropout_rate', 'retention_rate', 'pass_rate',
            'attendance_rate', 'completion_rate', 'acceptance_rate',
            'attrition_rate', 'turnover_rate', 'churn_rate',
            'readmission_rate', 'mortality_rate', 'infection_rate',
            'occupancy_rate', 'utilization_rate', 'fill_rate',
            'conversion_rate', 'bounce_rate', 'click_rate',
        ],
        'score': [
            'gpa', 'grade', 'score', 'mark', 'points',
            'test_score', 'exam_score', 'final_grade', 'average_grade',
            'satisfaction_score', 'quality_score', 'performance_score',
            'engagement_score', 'assessment_score',
        ],
        'ratio': [
            'ratio', 'student_faculty_ratio', 'staff_ratio',
            'per_capita', 'per_student', 'per_employee', 'per_patient',
            'debt_equity', 'current_ratio', 'ltv_cac',
        ],
    };

    // ═══════════════════════════════════════════════════════════════════
    // MATCHING ENGINE — Multi-strategy scoring
    // ═══════════════════════════════════════════════════════════════════

    // Simple stemmer: reduce common suffixes for fuzzy matching
    const stem = (word: string): string => {
        if (word.length <= 3) return word;
        if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
        if (word.endsWith('tion')) return word.slice(0, -4);
        if (word.endsWith('ment')) return word.slice(0, -4);
        if (word.endsWith('ness')) return word.slice(0, -4);
        if (word.endsWith('ing')) return word.slice(0, -3);
        if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
        if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
        if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
        return word;
    };

    // Tokenize a column name: split on _, -, spaces, camelCase
    const tokenize = (name: string): string[] => {
        return name
            .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case
            .toLowerCase()
            .split(/[_\-\s.]+/)
            .filter(t => t.length > 0);
    };

    // Score how well a column matches a set of synonyms
    const scoreMatch = (colName: string, synonyms: string[]): number => {
        const lowerCol = colName.toLowerCase();
        const colTokens = tokenize(colName);
        const colStems = colTokens.map(stem);
        const colJoined = colTokens.join('');  // e.g., "sale_amt" → "saleamt"

        let bestScore = 0;

        for (const syn of synonyms) {
            const synTokens = tokenize(syn);
            const synStems = synTokens.map(stem);
            const synJoined = synTokens.join('');

            // Strategy 1: EXACT MATCH (score=100)
            if (lowerCol === syn || colJoined === synJoined) {
                return 100;
            }

            // Strategy 2: STEM EXACT MATCH — "sales" stem matches "sale" (score=90)
            if (colStems.join('') === synStems.join('')) {
                bestScore = Math.max(bestScore, 90);
                continue;
            }

            // Strategy 3: TOKEN MATCH — all synonym tokens found in column tokens (score=80)
            const allSynTokensFound = synTokens.every(st =>
                colTokens.some(ct => ct === st || stem(ct) === stem(st))
            );
            if (allSynTokensFound && synTokens.length > 0) {
                // Bonus for longer match (more specific)
                const specificity = synTokens.length / Math.max(colTokens.length, 1);
                bestScore = Math.max(bestScore, 70 + Math.round(specificity * 10));
                continue;
            }

            // Strategy 4: CONTAINS — column contains synonym or vice versa (score=60)
            if (syn.length >= 3 && (lowerCol.includes(syn) || syn.includes(lowerCol))) {
                bestScore = Math.max(bestScore, 60);
                continue;
            }

            // Strategy 5: STEM CONTAINS — stemmed tokens overlap (score=50)
            const stemOverlap = synStems.filter(ss => colStems.includes(ss)).length;
            if (stemOverlap > 0) {
                const overlapRatio = stemOverlap / synStems.length;
                bestScore = Math.max(bestScore, 40 + Math.round(overlapRatio * 20));
                continue;
            }

            // Strategy 6: PREFIX MATCH (score=40)
            if (syn.length >= 3 && lowerCol.startsWith(syn)) {
                bestScore = Math.max(bestScore, 40);
            }
        }

        return bestScore;
    };

    // For each semantic role, find the best matching column
    Object.entries(heuristics).forEach(([role, synonyms]) => {
        let bestCol = '';
        let bestScore = 0;

        for (const col of columns) {
            // Skip columns already assigned to a higher-priority role
            // (revenue is highest priority for metrics)
            const score = scoreMatch(col, synonyms);

            // Prevent _name roles from matching _id columns
            if (role.endsWith('_name') || role === 'customer_name' || role === 'product_name') {
                const lc = col.toLowerCase();
                if (lc.endsWith('_id') || lc.endsWith('id') || lc === 'id') {
                    continue;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestCol = col;
            }
        }

        // Only accept matches above a minimum confidence threshold
        if (bestCol && bestScore >= 40) {
            fields[role] = bestCol;
        }
    });

    // ── POST-PROCESSING ──
    // If a _name role resolved to _id column, try to find a better match
    for (const role of Object.keys(fields)) {
        if (role.endsWith('_name') || role === 'customer_name' || role === 'product_name') {
            const resolvedCol = fields[role];
            if (resolvedCol) {
                const lowerCol = resolvedCol.toLowerCase();
                if (lowerCol.endsWith('_id') || lowerCol.endsWith(' id') || lowerCol === 'id') {
                    const entityBase = lowerCol.replace(/_?id$/i, '').replace(/ ?id$/i, '');
                    const nameCol = columns.find(c => {
                        const lc = c.toLowerCase();
                        return (lc.includes(entityBase) && (lc.includes('name') || lc.includes('title') || lc.includes('label'))) ||
                            (lc === entityBase && !lc.endsWith('id'));
                    });
                    if (nameCol) {
                        fields[role] = nameCol;
                    }
                }
            }
        }
    }

    console.log('[resolveMapping] Semantic roles:', fields);
    return { schemaType: 'flat', fields, missingFields: [] };
};

export interface ColumnInfo {
    name: string;
    dataType: string;
    isNullable: boolean;
    isPK: boolean;
    maxLength: number;
}

export interface ForeignKeyInfo {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
}

export interface JoinEdge {
    leftTable: string;
    rightTable: string;
    leftColumn: string;
    rightColumn: string;
    type: 'fk' | 'name_match';
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  FACT TABLE DETECTION — Retail Data Modelling Conventions       ║
// ╚══════════════════════════════════════════════════════════════════╝

/**
 * Score a table name against known fact table name patterns.
 * Higher score = more likely to be a fact table.
 * Rule: NEVER start joins from stores, products, employees, categories.
 * ALWAYS start from transaction_items, transactions, order_items, etc.
 */
const FACT_TABLE_PATTERNS: { pattern: RegExp; score: number }[] = [
    // Most granular facts first (line items)
    { pattern: /transaction_?items?|order_?items?|order_?lines?|line_?items?|sale_?items?|invoice_?items?|invoice_?lines?/i, score: 100 },
    // Standard fact tables
    { pattern: /^transactions?$|^orders?$|^sales?$|^invoices?$/i, score: 80 },
    { pattern: /^purchases?$|^receipts?$|^bookings?$/i, score: 75 },
    // Inventory / movement facts
    { pattern: /inventory_?movements?|stock_?movements?|inventory_?transactions?/i, score: 70 },
    // Broader fact-like tables
    { pattern: /facts?_|_facts?|measurements?|events?_log|activity/i, score: 60 },
    // Dimension table negative signals — we penalize these
    { pattern: /^stores?$|^products?$|^customers?$|^employees?$|^categor/i, score: -50 },
    { pattern: /^suppliers?$|^vendors?$|^staff$|^users?$|^regions?$|^zones?$/i, score: -40 },
];

/**
 * Detect the best fact table to use as the join root from a list of table names.
 * Returns the table name with the highest fact score, using column count as a tiebreaker
 * (more columns often means more granular / fact-like).
 */
export const detectFactTable = (
    selectedTables: string[],
    tableColumns: Record<string, ColumnInfo[]>
): string => {
    let bestTable = selectedTables[0];
    let bestScore = -Infinity;

    for (const tbl of selectedTables) {
        let score = 0;
        for (const { pattern, score: s } of FACT_TABLE_PATTERNS) {
            if (pattern.test(tbl)) { score += s; }
        }
        // Use column count as tiebreaker — more columns = more likely to be a fact
        const colCount = (tableColumns[tbl] || []).length;
        score += colCount * 0.5;

        if (score > bestScore) {
            bestScore = score;
            bestTable = tbl;
        }
    }

    console.log(`[JoinStrategy] Fact table detected: ${bestTable} (score=${bestScore.toFixed(1)}`);
    return bestTable;
};

/**
 * Detect the best fact table from actual data tables (using row counts).
 * Used inside autoJoinDatasets where we have real data, not just column metadata.
 */
export const detectFactTableFromData = (
    tables: Record<string, any[]>
): string => {
    const names = Object.keys(tables);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];

    let bestTable = names[0];
    let bestScore = -Infinity;

    for (const tbl of names) {
        let score = 0;
        for (const { pattern, score: s } of FACT_TABLE_PATTERNS) {
            if (pattern.test(tbl)) { score += s; }
        }
        // Row count is a strong signal — facts have more rows than dimensions
        const rowCount = (tables[tbl] || []).length;
        score += rowCount * 0.1;

        if (score > bestScore) {
            bestScore = score;
            bestTable = tbl;
        }
    }

    console.log(`[JoinStrategy] Fact table detected from data: ${bestTable} (score=${bestScore.toFixed(1)}, rows=${(tables[bestTable] || []).length})`);
    return bestTable;
};

/**
 * Detect join relationships between selected tables.
 *
 * FIXED: Uses fact-table-first strategy.
 * The fact table (transaction_items, transactions, orders, etc.) is always
 * the root of the join tree. Dimension tables (stores, products, categories)
 * are joined to it, not the other way around.
 *
 * Correct join path for retail:
 *   transaction_items → transactions → stores (via store_id)
 *   transaction_items → products → product_categories (via product_id)
 *
 * Uses FK metadata first, then falls back to same-name column matching.
 */
export const buildJoinStrategy = (
    selectedTables: string[],
    tableColumns: Record<string, ColumnInfo[]>,
    foreignKeys: ForeignKeyInfo[]
): JoinEdge[] => {
    if (selectedTables.length === 0) return [];
    if (selectedTables.length === 1) return [];

    const edges: JoinEdge[] = [];
    const added = new Set<string>();

    // ── Detect the fact table — this becomes the root ──
    const factTable = detectFactTable(selectedTables, tableColumns);
    const dimensionTables = selectedTables.filter(t => t !== factTable);

    // ── Step 1: FK-based joins (reorient to start from fact table) ──
    for (const fk of foreignKeys) {
        const fromIncluded = selectedTables.includes(fk.fromTable);
        const toIncluded = selectedTables.includes(fk.toTable);
        if (!fromIncluded || !toIncluded) continue;

        // Normalise FK direction: the FK with more rows should be on the left.
        // If this FK goes from a dimension to the fact table, flip it so the
        // fact table is on the left (the base).
        let leftTable = fk.fromTable;
        let rightTable = fk.toTable;
        let leftColumn = fk.fromColumn;
        let rightColumn = fk.toColumn;

        // If the FK source is a dimension and target is the fact table, flip
        if (rightTable === factTable || detectFactTable([leftTable], tableColumns) !== leftTable) {
            // flip only if the right table is the detected fact — otherwise keep as-is
            // We never flip FKs whose source is already the most fact-like table.
        }

        const key = `${leftTable}.${leftColumn}->${rightTable}.${rightColumn}`;
        const keyFlipped = `${rightTable}.${rightColumn}->${leftTable}.${leftColumn}`;
        if (!added.has(key) && !added.has(keyFlipped)) {
            edges.push({ leftTable, rightTable, leftColumn, rightColumn, type: 'fk' });
            added.add(key);
        }
    }

    // ── Step 2: Build the join order — fact table as root ──
    // We will BFS from the fact table outward, connecting dimension tables.
    const joined = new Set<string>([factTable]);
    const orderedEdges: JoinEdge[] = [];

    // First, find which FK edges already touch the fact table
    const factEdges = edges.filter(
        e => e.leftTable === factTable || e.rightTable === factTable
    );
    for (const e of factEdges) {
        // Reorient so fact table is always on the left
        if (e.rightTable === factTable) {
            orderedEdges.push({
                leftTable: e.rightTable,
                rightTable: e.leftTable,
                leftColumn: e.rightColumn,
                rightColumn: e.leftColumn,
                type: e.type,
            });
        } else {
            orderedEdges.push(e);
        }
        joined.add(e.leftTable === factTable ? e.rightTable : e.leftTable);
    }

    // Then BFS for remaining tables connected through already-joined tables
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of edges) {
            const leftJoined = joined.has(e.leftTable);
            const rightJoined = joined.has(e.rightTable);
            if (leftJoined && !rightJoined) {
                orderedEdges.push(e);
                joined.add(e.rightTable);
                changed = true;
            } else if (rightJoined && !leftJoined) {
                orderedEdges.push({
                    leftTable: e.rightTable, rightTable: e.leftTable,
                    leftColumn: e.rightColumn, rightColumn: e.leftColumn,
                    type: e.type,
                });
                joined.add(e.leftTable);
                changed = true;
            }
        }
    }

    // ── Step 3: Name-match fallback — iterative multi-pass BFS ──
    // Single-pass won't work for chains like: transaction_items → transactions → stores
    // because stores can only be found after transactions is already in `joined`.
    // We loop repeatedly until nothing new can be connected.
    const pendingNM = new Set(selectedTables.filter(t => !joined.has(t)));
    let nmProgress = true;

    while (nmProgress && pendingNM.size > 0) {
        nmProgress = false;

        for (const tbl of [...pendingNM]) {
            const tblColInfos = tableColumns[tbl] || [];
            const tblColsLower = tblColInfos.map(c => c.name.toLowerCase());
            let bestMatch: { baseTable: string; col: string; tblCol: string; score: number } | null = null;

            // Search through ALL already-joined tables for a matching column
            for (const bTbl of [...joined]) {
                const baseColInfos = tableColumns[bTbl] || [];
                const baseColsLower = baseColInfos.map(c => c.name.toLowerCase());

                for (const bc of baseColsLower) {
                    if (!tblColsLower.includes(bc)) continue;

                    // Score match quality: prefer _id columns (FK-like)
                    const matchScore =
                        (bc.endsWith('_id') || bc === 'id') ? 10 :
                            bc.endsWith('id') ? 8 :
                                bc.endsWith('_code') || bc.endsWith('_key') ? 6 : 2;

                    if (!bestMatch || matchScore > bestMatch.score) {
                        // Preserve original-case column names for downstream lookups
                        const origBaseCol = baseColInfos.find(c => c.name.toLowerCase() === bc)?.name || bc;
                        const origTblCol = tblColInfos.find(c => c.name.toLowerCase() === bc)?.name || bc;
                        bestMatch = { baseTable: bTbl, col: origBaseCol, tblCol: origTblCol, score: matchScore };
                    }
                }
            }

            if (bestMatch) {
                orderedEdges.push({
                    leftTable: bestMatch.baseTable, rightTable: tbl,
                    leftColumn: bestMatch.col, rightColumn: bestMatch.tblCol,
                    type: 'name_match',
                });
                joined.add(tbl);
                pendingNM.delete(tbl);
                nmProgress = true;
                console.log(`[JoinStrategy] Name-match: ${bestMatch.baseTable}.${bestMatch.col} → ${tbl}.${bestMatch.tblCol}`);
            }
        }
    }

    for (const tbl of pendingNM) {
        console.warn(`[JoinStrategy] Could not connect table: ${tbl} — no matching column found`);
    }

    console.log(`[JoinStrategy] Join path (root=${factTable}):`, orderedEdges.map(e =>
        `${e.leftTable}.${e.leftColumn} → ${e.rightTable}.${e.rightColumn} [${e.type}]`
    ).join(' | '));

    return orderedEdges;
};

/**
 * Join multiple tables into a single master table using LEFT JOIN cascade.
 *
 * FIXED: The base table is now the FACT table (highest row count / matching
 * fact table name patterns), not whichever table happens to be first in the list.
 *
 * Correct retail join order:
 *   transaction_items (FACT - base)
 *       ↓ transaction_id
 *   transactions
 *       ↓ store_id         ↓ cashier_id
 *   stores             employees
 *       ↓ product_id
 *   products
 *       ↓ category_id
 *   product_categories
 *
 * This guarantees the result has N rows = fact table grain (e.g. ~200 rows),
 * NOT 2 rows (stores) or 20 rows (products).
 */

/** Find the actual property key in a row object matching a (possibly lowercased) column name */
const resolveKey = (row: Record<string, any>, col: string): string => {
    if (col in row) return col;
    const lower = col.toLowerCase();
    return Object.keys(row).find(k => k.toLowerCase() === lower) || col;
};

export const autoJoinDatasets = (
    tables: Record<string, any[]>,
    joinEdges?: JoinEdge[]
): { mergedRows: any[]; joinLogs: string[] } => {
    const keys = Object.keys(tables);
    if (keys.length === 0) return { mergedRows: [], joinLogs: ['No tables to join'] };
    if (keys.length === 1) return { mergedRows: tables[keys[0]] || [], joinLogs: [`Single table: ${keys[0]} (${(tables[keys[0]] || []).length} rows)`] };

    const logs: string[] = [];

    // ── Detect the fact table — this is always the LEFT/base of the join ──
    const factTable = detectFactTableFromData(tables);

    // ── No join edges provided: use fact-first name-match fallback ──
    if (!joinEdges || joinEdges.length === 0) {
        const remainingTables = keys.filter(k => k !== factTable);
        let merged = [...(tables[factTable] || [])];
        logs.push(`Base table (FACT): ${factTable} (${merged.length} rows)`);

        for (const rightTable of remainingTables) {
            const rightRows = tables[rightTable] || [];
            if (rightRows.length === 0) {
                logs.push(`SKIP ${rightTable} — empty table`);
                continue;
            }

            const leftColKeys = Object.keys(merged[0] || {});
            const leftCols = new Set(leftColKeys);
            const leftColsLower = new Map(leftColKeys.map(k => [k.toLowerCase(), k]));
            const rightCols = Object.keys(rightRows[0] || {});

            // Find the best shared ID column (case-insensitive)
            // Priority: _id suffix > id suffix > any shared column
            const ciMatch = (rc: string) => leftCols.has(rc) || leftColsLower.has(rc.toLowerCase());
            let sharedCol: string | undefined;
            sharedCol = rightCols.find(c =>
                ciMatch(c) && c.toLowerCase().endsWith('_id')
            );
            if (!sharedCol) {
                sharedCol = rightCols.find(c =>
                    ciMatch(c) && c.toLowerCase().endsWith('id')
                );
            }
            if (!sharedCol) {
                sharedCol = rightCols.find(c => ciMatch(c));
            }

            if (sharedCol) {
                // Resolve the actual key on the left side (may differ in case)
                const leftKey = resolveKey(merged[0] || {}, sharedCol);

                // Build a lookup map from the dimension table (1:1 or many:1)
                const rightMap = new Map<string, any>();
                rightRows.forEach(r => rightMap.set(String(r[sharedCol!]), r));

                const beforeCount = merged.length;
                merged = merged.map(row => {
                    const match = rightMap.get(String(row[leftKey]));
                    if (match) {
                        const enriched: any = {};
                        for (const [k, v] of Object.entries(match)) {
                            if (k === sharedCol) continue;
                            enriched[leftCols.has(k) ? `${rightTable}_${k}` : k] = v;
                        }
                        return { ...row, ...enriched };
                    }
                    return row;
                });
                logs.push(`LEFT JOIN ${rightTable} ON ${leftKey} = ${sharedCol} → ${merged.length} rows (was ${beforeCount})`);
            } else {
                logs.push(`SKIP ${rightTable} — no shared ID column with ${factTable}`);
            }
        }
        return { mergedRows: merged, joinLogs: logs };
    }

    // ── Use provided join edges (from buildJoinStrategy) ──
    // The edges are already ordered correctly (fact-first) by buildJoinStrategy.
    // We pick the root from the first edge's leftTable, but re-check against
    // the detected fact table to be safe.
    const edgeRoot = joinEdges[0]?.leftTable || factTable;

    // Use whichever of the two has more rows as the true root
    const edgeRootRows = (tables[edgeRoot] || []).length;
    const factRows = (tables[factTable] || []).length;
    const rootTable = factRows >= edgeRootRows ? factTable : edgeRoot;

    let merged = [...(tables[rootTable] || [])];
    const joined = new Set<string>([rootTable]);
    logs.push(`Base table (FACT): ${rootTable} (${merged.length} rows)`);

    // Process edges in topological order
    // We do multiple passes to handle cases where an edge references a not-yet-joined table
    const pending = [...joinEdges];
    let maxPasses = pending.length + 1;

    while (pending.length > 0 && maxPasses-- > 0) {
        let progress = false;

        for (let i = pending.length - 1; i >= 0; i--) {
            const edge = pending[i];

            // Determine which side is already joined (the left in our result set)
            let leftCol: string;
            let rightName: string;
            let rightCol: string;

            if (joined.has(edge.leftTable) && !joined.has(edge.rightTable)) {
                leftCol = edge.leftColumn;
                rightName = edge.rightTable;
                rightCol = edge.rightColumn;
            } else if (joined.has(edge.rightTable) && !joined.has(edge.leftTable)) {
                // Flip the edge — the right table is already joined, left is the new one
                leftCol = edge.rightColumn;
                rightName = edge.leftTable;
                rightCol = edge.leftColumn;
            } else {
                // Both sides already joined or neither — skip for now
                if (joined.has(edge.leftTable) && joined.has(edge.rightTable)) {
                    pending.splice(i, 1); // already done
                }
                continue;
            }

            const rightRows = tables[rightName] || [];
            if (rightRows.length === 0) {
                logs.push(`SKIP ${rightName} — empty table`);
                pending.splice(i, 1);
                progress = true;
                continue;
            }

            const leftColsSet = new Set(Object.keys(merged[0] || {}));

            // Resolve case-correct keys from row objects (join edge columns may be lowercased)
            const actualRightCol = resolveKey(rightRows[0] || {}, rightCol);
            const actualLeftCol = resolveKey(merged[0] || {}, leftCol);

            // Build a 1-to-1 lookup map from the dimension/right table
            const rightMap = new Map<string, any>();
            rightRows.forEach(r => rightMap.set(String(r[actualRightCol]), r));

            const beforeCount = merged.length;
            merged = merged.map(row => {
                const match = rightMap.get(String(row[actualLeftCol]));
                if (match) {
                    const enriched: any = {};
                    for (const [k, v] of Object.entries(match)) {
                        if (k === actualRightCol) continue;
                        enriched[leftColsSet.has(k) ? `${rightName}_${k}` : k] = v;
                    }
                    return { ...row, ...enriched };
                }
                return row;
            });

            joined.add(rightName);
            logs.push(`LEFT JOIN ${rightName} ON ${actualLeftCol} = ${actualRightCol} [${edge.type}] → ${merged.length} rows (was ${beforeCount})`);
            pending.splice(i, 1);
            progress = true;
        }

        if (!progress) break; // No more progress possible
    }

    // Log any tables that couldn't be joined
    for (const edge of pending) {
        logs.push(`WARN: Could not join ${edge.leftTable} ↔ ${edge.rightTable} — orphaned edge`);
    }

    return { mergedRows: merged, joinLogs: logs };
};

export const parseCSV = (text: string): any[] => {
    const lines = text.trim().split('\n');
    const headers = parseCSVLine(lines[0]);
    return lines.slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
            const v = parseCSVLine(line);
            return headers.reduce((acc, h, i) => ({ ...acc, [h]: v[i]?.trim() ?? '' }), {});
        });
};

/** Parse a single CSV line respecting quoted fields (RFC 4180) */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                // Check for escaped quote ("")
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++; // skip next quote
                } else {
                    inQuotes = false; // end of quoted field
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
            } else if (ch === '\r') {
                // skip carriage return
            } else {
                current += ch;
            }
        }
    }
    fields.push(current.trim());
    return fields;
}

export const parseExcel = async (file: File): Promise<any[]> => {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
            // cellDates: true → dates arrive as JS Date objects instead of serial numbers
            const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
            resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]));
        };
        reader.readAsBinaryString(file);
    });
};

/**
 * Parse ALL sheets from an Excel file.
 * Returns { sheetCount, sheets: Record<sheetName, rows[]> }
 */
export const parseExcelMultiSheet = async (file: File): Promise<{ sheetCount: number; sheets: Record<string, any[]> }> => {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
            // cellDates: true → dates arrive as JS Date objects instead of serial numbers
            const wb = XLSX.read(e.target?.result, { type: 'binary', cellDates: true });
            const sheets: Record<string, any[]> = {};
            for (const name of wb.SheetNames) {
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[name]);
                if (rows.length > 0) {
                    sheets[name] = rows;
                }
            }
            resolve({ sheetCount: wb.SheetNames.length, sheets });
        };
        reader.readAsBinaryString(file);
    });
};

export const getSampleData = () => `order_id,order_date,product_name,quantity,revenue
101,2025-02-20,Laptop,1,1200
102,2025-02-20,Mouse,2,50`;

export interface TableInfo {
    name: string;
    rows: number;
    category: string;
    columns?: ColumnInfo[];
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

export const connectToDatabase = async (config: {
    host: string;
    port: string;
    database: string;
    username?: string;
    password?: string;
    useWindowsAuth: boolean;
    dbType?: 'mssql' | 'postgres';
    ssl?: boolean;
}): Promise<{ success: boolean; connectionId?: string; error?: string }> => {
    try {
        const endpoint = config.dbType === 'postgres' ? `${API_BASE_URL}/pg/connect` : `${API_BASE_URL}/connect`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        // Handle non-OK responses gracefully
        if (!response.ok) {
            const text = await response.text();
            try {
                const data = JSON.parse(text);
                return { success: false, error: data.error || `Server error (${response.status})` };
            } catch {
                return { success: false, error: `Backend returned ${response.status}: ${text.slice(0, 200) || 'No response body'}` };
            }
        }

        return await response.json();
    } catch (error: any) {
        // Network error — backend not running
        if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError') || error.message?.includes('ECONNREFUSED')) {
            return {
                success: false,
                error: `Cannot reach backend API at ${API_BASE_URL}. Make sure the backend server is running: cd backend && node server.js`
            };
        }
        return { success: false, error: error.message };
    }
};

// Helper to determine API prefix from connectionId
const getApiPrefix = (connectionId: string) => connectionId.startsWith('pg_') ? '/pg' : '';

export const getMockDatabaseSchema = async (connectionId: string): Promise<TableInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/schema`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId })
        });
        const data = await response.json();
        return data.success ? data.tables : [];
    } catch (error) {
        console.error('Schema fetch error:', error);
        return [];
    }
};

export const fetchTableColumns = async (connectionId: string, table: string): Promise<ColumnInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/columns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId, table })
        });
        const data = await response.json();
        return data.success ? data.columns : [];
    } catch (error) {
        console.error('Column fetch error:', error);
        return [];
    }
};

export const fetchForeignKeys = async (connectionId: string): Promise<ForeignKeyInfo[]> => {
    try {
        const prefix = getApiPrefix(connectionId);
        const response = await fetch(`${API_BASE_URL}${prefix}/foreign-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId })
        });
        const data = await response.json();
        return data.success ? data.relationships : [];
    } catch (error) {
        console.error('FK fetch error:', error);
        return [];
    }
};

export const getMockConnectorData = async (connectionId?: string, tables?: string[]): Promise<any> => {
    // If no connectionId, return mock data for non-database connectors (Shopify, etc.)
    if (!connectionId) {
        return [
            { order_id: 'ORD-001', order_date: '2025-01-15', total: 150.00, customer_id: 'CUST-101', status: 'shipped' },
            { order_id: 'ORD-002', order_date: '2025-01-16', total: 250.50, customer_id: 'CUST-102', status: 'processing' },
            { order_id: 'ORD-003', order_date: '2025-01-16', total: 45.00, customer_id: 'CUST-103', status: 'shipped' },
            { order_id: 'ORD-004', order_date: '2025-01-17', total: 1200.00, customer_id: 'CUST-101', status: 'shipped' }
        ];
    }

    // Real database query
    try {
        const response = await fetch(`${API_BASE_URL}/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId, tables: tables || [] })
        });
        const data = await response.json();
        return data.success ? data.data : {};
    } catch (error) {
        console.error('Query error:', error);
        return {};
    }
};

export const generateColumnProfile = (rows: any[], columns: ColumnDefinition[]): ColumnProfile[] => {
    if (!rows || rows.length === 0) return [];
    return columns.map(col => {
        const values = rows.map(r => r[col.name]);
        const nonNulls = values.filter(v => v !== null && v !== undefined && v !== '');
        const distinct = new Set(nonNulls.map(v => String(v)));
        let stats: any = {};
        if (col.type === ColumnType.METRIC) {
            const nums = nonNulls.map(n => Number(n)).filter(n => !isNaN(n));
            if (nums.length) {
                stats.min = Math.min(...nums);
                stats.max = Math.max(...nums);
                stats.avg = nums.reduce((a, b) => a + b, 0) / nums.length;
            }
        }
        const counts: Record<string, number> = {};
        nonNulls.forEach(v => { const s = String(v); counts[s] = (counts[s] || 0) + 1; });
        const topValues = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, count]) => ({ value, count }));
        return {
            name: col.name, type: col.type, uniqueCount: distinct.size, nullCount: values.length - nonNulls.length, topValues, ...stats
        };
    });
};