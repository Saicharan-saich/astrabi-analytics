/**
 * Semantic Layer — Constrained Probabilistic Decision Engine
 *
 * Upgraded from a rule-based classifier to a full arbitration pipeline:
 *   1. Constraint Gates → hard physics (Boolean/Date/Anti-ID/Ordinal)
 *   2. User Feedback Cache → scoped overrides with frequency weighting
 *   3. Deterministic Scoring → weighted name+stats confidence
 *   4. AI Arbitration → optional async cross-verification (batched LLM)
 *   5. Continuous Delta → asymmetric arbitration with physics ceiling
 *
 * PRIORITY: Hard Physics > User Feedback > Deterministic > AI
 */

import { Dataset, ColumnType } from '../../types';
import {
    SemanticField, SemanticModel, SemanticType, FieldRole, MetricDefinition
} from './types';
import { buildCompositeMetrics, buildDerivedMetrics } from './metricRegistry';
import { runConstraintGates, ColumnStatProfile } from './constraintGates';
import { lookupFeedback, bucketUniqueRatio, bucketRangeSpan } from './classificationFeedback';
import { arbitrate } from './arbitrationEngine';
import { runAIArbitration, AIClassificationRequest } from './aiArbitrator';

// ─── Synonym Dictionary ──────────────────────────────────────────
const SYNONYM_MAP: Record<string, string[]> = {
    // Revenue / Sales
    sales: ['revenue', 'turnover', 'income', 'earnings', 'total sales', 'proceeds', 'receipts'],
    revenue: ['sales', 'turnover', 'income', 'earnings', 'total revenue', 'proceeds', 'receipts'],
    // Cost
    cost: ['expense', 'expenditure', 'spending', 'cogs', 'outlay'],
    discount: ['markdown', 'reduction', 'rebate', 'deduction'],
    shipping: ['freight', 'delivery cost', 'shipping cost', 'postage'],
    // Profit
    profit: ['margin', 'net income', 'net profit', 'earnings', 'bottom line', 'net revenue'],
    // Quantity
    quantity: ['qty', 'units', 'volume', 'count', 'items', 'pieces'],
    // Price
    price: ['unit price', 'cost per unit', 'rate', 'unit cost'],
    // HR / People
    salary: ['wage', 'pay', 'compensation', 'remuneration', 'base pay'],
    bonus: ['incentive', 'commission', 'payout'],
    employee: ['staff', 'worker', 'associate', 'team member', 'headcount'],
    // Geography
    region: ['area', 'territory', 'zone', 'geo', 'geos', 'district'],
    state: ['province', 'territory'],
    city: ['town', 'municipality', 'metro'],
    country: ['nation'],
    // Product
    category: ['segment', 'group', 'type', 'class', 'division'],
    product: ['item', 'sku', 'article', 'merchandise'],
    // Customer
    customer: ['client', 'buyer', 'account', 'user', 'patron'],
    // Order / Transaction
    order: ['transaction', 'purchase', 'sale', 'deal'],
    // Time
    date: ['day', 'order date', 'transaction date'],
    month: ['period', 'month name'],
    year: ['fiscal year', 'calendar year'],
    // Rate / Percentage
    margin: ['margin pct', 'profit margin', 'gross margin'],
    rate: ['percentage', 'ratio', 'pct'],
    // Amount
    amount: ['value', 'total', 'sum', 'payment'],
};

// ─── Column Name Pattern Matchers (kept for synonym/display logic) ────
const DATE_PATTERNS = /\b(date|day|month|year|quarter|week|time|timestamp|created|updated|ordered|shipped|delivered)\b/i;

/**
 * Determine default aggregation — now handles ordinal type
 */
function inferDefaultAgg(semanticType: SemanticType, role: FieldRole): SemanticField['defaultAgg'] {
    if (role === 'dimension') return 'none';
    switch (semanticType) {
        case 'currency': return 'sum';
        case 'quantity': return 'sum';
        case 'count': return 'count';
        case 'percentage': return 'avg';
        case 'ratio': return 'avg';
        case 'ordinal': return 'none'; // Ordinals are dimensions, never aggregated
        default: return 'sum';
    }
}

/**
 * Derive format hint from the arbitrated semantic type
 */
function deriveFormatHint(semanticType: SemanticType): SemanticField['formatHint'] {
    switch (semanticType) {
        case 'currency': return 'currency_usd';
        case 'percentage': return 'percent';
        case 'date': return 'date';
        case 'quantity': return 'decimal';
        case 'count': return 'integer';
        case 'ratio': return 'decimal';
        case 'ordinal': return 'integer';
        case 'identifier': return 'text';
        case 'boolean': return 'text';
        default: return 'text';
    }
}

/**
 * Build a ColumnStatProfile from dataset rows for the constraint engine.
 */
function buildColumnStatProfile(
    colName: string,
    colType: ColumnType,
    rows: Record<string, any>[],
    actualKey: string,
): ColumnStatProfile {
    const totalRows = rows.length;
    const sampleSize = Math.min(totalRows, 2000);

    let distinctValues = new Set<any>();
    let nullCount = 0;
    let numericValues: number[] = [];
    let dateParseCount = 0;
    let integerCount = 0;
    const sampleValues: any[] = [];

    for (let i = 0; i < sampleSize; i++) {
        const val = rows[i]?.[actualKey];
        distinctValues.add(val);

        if (val === null || val === undefined || val === '') {
            nullCount++;
            continue;
        }

        if (sampleValues.length < 20) sampleValues.push(val);

        if (typeof val === 'number') {
            numericValues.push(val);
            if (Number.isInteger(val)) integerCount++;
        } else if (typeof val === 'string') {
            const num = Number(val);
            if (!isNaN(num) && val.trim() !== '') {
                numericValues.push(num);
                if (Number.isInteger(num)) integerCount++;
            }
            // Quick date parse check
            if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(val) || /^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(val)) {
                dateParseCount++;
            }
        }
    }

    const nonNullCount = sampleSize - nullCount;
    const dateParseRate = nonNullCount > 0 ? dateParseCount / nonNullCount : 0;
    const isIntegerLike = numericValues.length > 0 && integerCount >= numericValues.length * 0.95;

    let range: { min: number; max: number } | undefined;
    if (numericValues.length > 0) {
        range = {
            min: Math.min(...numericValues),
            max: Math.max(...numericValues),
        };
    }

    return {
        name: colName,
        etlType: colType,
        totalRows,
        distinctCount: distinctValues.size,
        nullRate: totalRows > 0 ? nullCount / sampleSize : 0,
        range,
        isIntegerLike,
        dateParseRate,
        sampleValues,
    };
}

/**
 * Generate synonyms from column name
 */
function generateSynonyms(colName: string): string[] {
    const baseName = colName.toLowerCase().replace(/_/g, ' ').trim();
    const synonyms = new Set<string>();

    // Look up in synonym dictionary
    for (const [key, vals] of Object.entries(SYNONYM_MAP)) {
        if (baseName.includes(key) || key.includes(baseName)) {
            vals.forEach(v => synonyms.add(v));
        }
    }

    // Add the name without underscores as a synonym
    if (colName.includes('_')) {
        synonyms.add(baseName);
    }

    return Array.from(synonyms).slice(0, 8);
}

/**
 * Generate a human-readable display label from a column name
 */
function generateDisplayLabel(colName: string): string {
    return colName
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .trim();
}

/**
 * Build a complete SemanticModel from a Dataset.
 *
 * UPGRADED: Now uses the Constrained Probabilistic Decision Engine:
 *   1. Build ColumnStatProfile for each column
 *   2. Run constraint gates → allowedTypes + detConf
 *   3. Check user feedback cache (scoped by column/domain/distribution)
 *   4. Run deterministic arbitration (sync, no AI)
 *   5. Attach classification signals for explainability
 *
 * AI cross-verification is handled separately by enhanceWithAIArbitration()
 * which runs async after the initial model is built.
 */
export function buildSemanticModel(dataset: Dataset): SemanticModel {
    const fields: SemanticField[] = [];
    const rows = dataset.rows;
    const totalRows = rows.length;
    const domain = dataset.domainProfile?.domain || 'Other';

    let arbitrationStats = { total: 0, ordinal: 0, feedbackUsed: 0, needsReview: 0 };

    for (const col of dataset.columns) {
        // Get the actual key in the data (case-insensitive match)
        const actualKey = totalRows > 0
            ? Object.keys(rows[0]).find(k => k.toLowerCase() === col.name.toLowerCase()) || col.name
            : col.name;

        // ── STEP 1: Build statistical profile ────────────────────
        const statProfile = buildColumnStatProfile(col.name, col.type, rows, actualKey);

        // Collect sample values for display
        const sampleSet = new Set<string>();
        for (let i = 0; i < Math.min(totalRows, 500) && sampleSet.size < 10; i++) {
            const val = rows[i][actualKey];
            if (val !== null && val !== undefined && val !== '') {
                sampleSet.add(String(val).substring(0, 50));
            }
        }

        // ── STEP 2: Run constraint gates (hard physics) ──────────
        const constraintResult = runConstraintGates(statProfile);

        // ── STEP 3: Check user feedback cache ────────────────────
        const uniqueRatio = totalRows > 0 ? statProfile.distinctCount / totalRows : 0;
        const rangeSpan = statProfile.range ? statProfile.range.max - statProfile.range.min : undefined;
        const feedback = lookupFeedback(col.name, domain, uniqueRatio, rangeSpan);

        // ── STEP 4: Run arbitration (deterministic + feedback, no AI yet) ──
        const arbResult = arbitrate(col.name, constraintResult, null, feedback);

        // Track stats
        arbitrationStats.total++;
        if (arbResult.semanticType === 'ordinal') arbitrationStats.ordinal++;
        if (arbResult.signals.finalSource === 'user_override' || arbResult.signals.finalSource === 'seed') arbitrationStats.feedbackUsed++;
        if (arbResult.needsReview) arbitrationStats.needsReview++;

        // ── STEP 5: Build SemanticField with classification signals ──
        const semanticType = arbResult.semanticType;
        const role = arbResult.role;
        const defaultAgg = inferDefaultAgg(semanticType, role);
        const formatHint = deriveFormatHint(semanticType);

        const timeGrainSupport = semanticType === 'date'
            ? (['day', 'week', 'month', 'quarter', 'year'] as const).map(g => g)
            : [];

        // Check for nulls
        const nullCount = rows.slice(0, 500).filter(r => r[actualKey] === null || r[actualKey] === undefined || r[actualKey] === '').length;

        fields.push({
            name: col.name,
            physicalType: col.type === ColumnType.DATE ? 'date'
                : col.type === ColumnType.METRIC ? 'number'
                    : col.type === ColumnType.BOOLEAN ? 'boolean'
                        : 'string',
            semanticType,
            role,
            defaultAgg,
            timeGrainSupport: timeGrainSupport as any,
            synonyms: generateSynonyms(col.name),
            sampleValues: Array.from(sampleSet).slice(0, 5),
            distinctCount: statProfile.distinctCount,
            hasNulls: nullCount > 0,
            range: statProfile.range,
            displayLabel: generateDisplayLabel(col.name),
            formatHint,
            classificationSignals: arbResult.signals,
        });
    }

    console.log(`[SemanticLayer] ✅ Decision Engine: ${arbitrationStats.total} columns classified ` +
        `(${arbitrationStats.ordinal} ordinal, ${arbitrationStats.feedbackUsed} from feedback, ` +
        `${arbitrationStats.needsReview} needs review)`);

    // Detect primary date column
    const dateFields = fields.filter(f => f.semanticType === 'date');
    const primaryDateCol = dateFields.length > 0
        ? (dateFields.find(f => f.name.toLowerCase().includes('order'))
            || dateFields.find(f => f.name.toLowerCase().includes('transaction'))
            || dateFields[0])
        : undefined;

    // Detect grain
    const grain = detectGrain(dataset);

    // Build composite metrics from the semantic fields
    const compositeMetrics = buildCompositeMetrics(fields);

    // Build derived metrics (two-stage aggregations like avg_daily_sales)
    const derivedMetrics = buildDerivedMetrics(fields);

    // Performance guardrails
    if (totalRows > 500000) {
        console.warn(`[SemanticLayer] ⚠️ LARGE DATASET: ${totalRows.toLocaleString()} rows. Performance may be affected.`);
    }

    return {
        fields,
        compositeMetrics,
        derivedMetrics,
        datasetName: dataset.name || 'data',
        rowCount: totalRows,
        timeContext: dataset.timeContext ? {
            anchorDate: dataset.timeContext.defaultAnchorDate || dataset.timeContext.maxDate,
            minDate: dataset.timeContext.minDate,
            maxDate: dataset.timeContext.maxDate,
            primaryDateColumn: primaryDateCol?.name || dataset.timeContext.anchorDateColumn || '',
        } : undefined,
        joinGraph: dataset.sourceSchema ? {
            edges: dataset.sourceSchema.joinEdges.map(e => ({
                left: e.leftTable,
                right: e.rightTable,
                leftCol: e.leftColumn,
                rightCol: e.rightColumn,
                type: e.type,
            }))
        } : undefined,
        grain,
    };
}

/**
 * ASYNC AI ENHANCEMENT — Optional second pass.
 *
 * Runs AI cross-verification on the existing semantic model's fields
 * and re-arbitrates with the AI results. Returns an upgraded model.
 *
 * Call this after buildSemanticModel() when AI is available.
 * If AI is unavailable, the original model is returned unchanged.
 */
export async function enhanceWithAIArbitration(
    model: SemanticModel,
    dataset: Dataset,
): Promise<SemanticModel> {
    const domain = dataset.domainProfile?.domain || 'Other';
    const domainConfidence = dataset.domainProfile?.confidence ?? 0.5;

    // Build AI classification requests from existing constraint data
    const requests: AIClassificationRequest[] = [];
    for (const field of model.fields) {
        if (!field.classificationSignals) continue;
        // Only send columns that aren't already locked by physics (boolean/date)
        if (field.semanticType === 'boolean' || field.semanticType === 'date') continue;

        requests.push({
            columnName: field.name,
            constraintResult: {
                allowedTypes: field.classificationSignals.allowedTypes,
                detConf: field.classificationSignals.detConf,
                bestGuess: { semanticType: field.semanticType, role: field.role },
                reason: field.classificationSignals.reason,
                signals: field.classificationSignals.signals as any,
            },
        });
    }

    if (requests.length === 0) return model;

    // Run batched AI arbitration
    const aiResults = await runAIArbitration(
        requests, model.datasetName, domain, domainConfidence,
    );

    if (!aiResults || aiResults.length === 0) {
        console.log('[SemanticLayer] AI arbitration returned no results — keeping deterministic model');
        return model;
    }

    // Build lookup for fast access
    const aiLookup = new Map(aiResults.map(r => [r.columnName, r]));

    // Re-arbitrate fields with AI results
    let aiUpgrades = 0;
    const updatedFields = model.fields.map(field => {
        const aiResult = aiLookup.get(field.name);
        if (!aiResult || !field.classificationSignals) return field;

        const uniqueRatio = field.distinctCount / (model.rowCount || 1);
        const rangeSpan = field.range ? field.range.max - field.range.min : undefined;
        const feedback = lookupFeedback(field.name, domain, uniqueRatio, rangeSpan);

        const reArbResult = arbitrate(
            field.name,
            {
                allowedTypes: field.classificationSignals.allowedTypes,
                detConf: field.classificationSignals.detConf,
                bestGuess: { semanticType: field.semanticType, role: field.role },
                reason: field.classificationSignals.reason,
                signals: field.classificationSignals.signals as any,
            },
            aiResult,
            feedback,
        );

        if (reArbResult.semanticType !== field.semanticType || reArbResult.role !== field.role) {
            aiUpgrades++;
        }

        return {
            ...field,
            semanticType: reArbResult.semanticType,
            role: reArbResult.role,
            defaultAgg: inferDefaultAgg(reArbResult.semanticType, reArbResult.role),
            formatHint: deriveFormatHint(reArbResult.semanticType),
            classificationSignals: reArbResult.signals,
        };
    });

    console.log(`[SemanticLayer] 🧠 AI arbitration complete: ${aiUpgrades} field(s) upgraded`);

    // Rebuild composite/derived metrics with updated field types
    return {
        ...model,
        fields: updatedFields,
        compositeMetrics: buildCompositeMetrics(updatedFields),
        derivedMetrics: buildDerivedMetrics(updatedFields),
    };
}

/**
 * Detect the grain of the dataset (e.g., "one row per order line item")
 */
function detectGrain(dataset: Dataset): string {
    const cols = dataset.columns.map(c => c.name.toLowerCase());

    // Look for common grain indicators
    if (cols.some(c => c.includes('line_item') || c.includes('lineitem'))) {
        return 'one row per line item';
    }
    if (cols.some(c => c.includes('order_id') || c.includes('transaction_id'))) {
        if (cols.some(c => c.includes('product') || c.includes('item'))) {
            return 'one row per order line item';
        }
        return 'one row per order';
    }
    if (cols.some(c => c.includes('customer_id') || c.includes('client_id'))) {
        return 'one row per customer record';
    }
    return 'one row per record';
}

/**
 * Serialize the semantic model to a compact string for LLM prompts.
 * This replaces the old raw schema injection.
 */
export function serializeSemanticModel(model: SemanticModel): string {
    const lines: string[] = [
        `Dataset: "${model.datasetName}" (${model.rowCount.toLocaleString()} rows)`,
        `Grain: ${model.grain}`,
        '',
    ];

    // Time context
    if (model.timeContext) {
        lines.push('Time Context:');
        lines.push(`  Current reference date ("today"): ${model.timeContext.anchorDate}`);
        lines.push(`  Data range: ${model.timeContext.minDate} to ${model.timeContext.maxDate}`);
        lines.push(`  Primary date column: ${model.timeContext.primaryDateColumn}`);
        lines.push('');
    }

    // Fields table — include range for numeric fields so LLM can reason about filtering
    lines.push('Fields:');
    lines.push('  field | type | semantic | role | default_agg | range | distinct | samples');
    lines.push('  ' + '-'.repeat(110));

    for (const f of model.fields) {
        const samples = f.sampleValues.slice(0, 3).map(s => `"${s}"`).join(', ');
        const rangeStr = f.range ? `${f.range.min}–${f.range.max}` : '—';
        const distinctStr = String(f.distinctCount);
        lines.push(
            `  ${f.name} | ${f.physicalType} | ${f.semanticType} | ${f.role} | ${f.defaultAgg} | ${rangeStr} | ${distinctStr} | ${samples}`
        );
        if (f.synonyms.length > 0) {
            lines.push(`    synonyms: ${f.synonyms.join(', ')}`);
        }
    }

    // Filtering rules — critical for correct column selection
    lines.push('');
    lines.push('FILTERING RULES (CRITICAL):');
    lines.push('  - ANY field (metric or dimension) can be used in WHERE clauses for filtering.');
    lines.push('  - For numeric fields, use BETWEEN / >= / <= operators for range filtering.');
    lines.push('  - When the user describes a numeric range ("in their forties", "over 50", "under 30",');
    lines.push('    "between 20 and 30"), ALWAYS prefer the raw numeric column with BETWEEN/>=/<= over');
    lines.push('    a categorical grouping column. Example: use "WHERE age BETWEEN 40 AND 49" not');
    lines.push('    "WHERE age_group IN (\'40-49\')".');
    lines.push('  - Look at the range column above to identify which fields are numeric and filterable.');

    // Composite metrics
    if (model.compositeMetrics.length > 0) {
        lines.push('');
        lines.push('Composite Metrics (governed formulas):');
        for (const m of model.compositeMetrics) {
            lines.push(`  ${m.id}: ${m.formula}  — ${m.description}`);
            if (m.synonyms.length > 0) {
                lines.push(`    synonyms: ${m.synonyms.join(', ')}`);
            }
        }
    }

    // Derived metrics (two-stage aggregations)
    if (model.derivedMetrics && model.derivedMetrics.length > 0) {
        lines.push('');
        lines.push('Derived Metrics (two-stage aggregations — use these for compound averages):');
        for (const dm of model.derivedMetrics) {
            lines.push(`  ${dm.id}: ${dm.finalAgg.toUpperCase()}( ${dm.baseMetric.agg.toUpperCase()}(${dm.baseMetric.field}) GROUP BY ${dm.groupBy.field} per ${dm.groupBy.grain} )  — ${dm.description}`);
            if (dm.synonyms.length > 0) {
                lines.push(`    synonyms: ${dm.synonyms.join(', ')}`);
            }
        }
    }

    // Null handling policy documentation (for audit/review)
    lines.push('');
    lines.push('Null Handling Policy:');
    lines.push('  - Metric columns: NULLs are KEPT in the data but excluded from aggregation (SQL standard)');
    lines.push('    → SUM, AVG, COUNT skip NULLs. Totals are not inflated or deflated.');
    lines.push('  - Dimension columns: NULLs are allowed as a distinct category (displayed as "[Unknown]")');
    lines.push('    → No rows are dropped. NULL dimensions appear in GROUP BY results.');
    lines.push('  - Rows are NEVER deleted from the source data due to NULLs.');

    // Add null rate info for fields that have nulls
    const fieldsWithNulls = model.fields.filter(f => f.hasNulls);
    if (fieldsWithNulls.length > 0) {
        lines.push('');
        lines.push('Fields with NULL values:');
        for (const f of fieldsWithNulls) {
            lines.push(`  ${f.name} (${f.role}) — has NULLs, handling: ${f.role === 'metric' ? 'excluded from aggregation' : 'kept as [Unknown] category'}`);
        }
    }

    // Performance note
    if (model.rowCount > 100000) {
        lines.push('');
        lines.push(`Performance note: Dataset has ${model.rowCount.toLocaleString()} rows.`);
        if (model.rowCount > 500000) {
            lines.push('  ⚠️ Large dataset — queries may take longer. Consider applying date filters to reduce scope.');
        }
    }

    return lines.join('\n');
}
