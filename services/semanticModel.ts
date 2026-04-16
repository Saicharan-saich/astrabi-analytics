/**
 * semanticModel.ts — Deterministic Semantic Model Layer
 *
 * MANDATORY CORE: Every dataset MUST have a SemanticModel before any analysis runs.
 * The semantic model is the single source of truth for:
 *   - Which columns are dimensions vs measures
 *   - How each measure should be aggregated (SUM, AVG, COUNT_DISTINCT, etc.)
 *   - Whether a measure is additive, semi-additive, or non-additive
 *   - What relationships exist between tables (for join validation)
 *   - Which column is the primary date column
 *
 * RULES:
 *   - No analysis allowed without a valid SemanticModel
 *   - AI suggestions are accepted ONLY if confidence >= 0.9 AND pass rule-based validation
 *   - System MUST FAIL instead of GUESS when model is incomplete
 */

import {
    Dataset,
    ColumnType,
    ColumnDefinition,
    AggregationType,
    DatasetDomainProfile,
    ColumnSemantic,
} from '../types';
import { classifyMetric, classifyDimension } from './metricRegistry';

// ═══════════════════════════════════════════════════════════════════
// CORE TYPES
// ═══════════════════════════════════════════════════════════════════

export type MetricBehavior = 'additive' | 'semi_additive' | 'non_additive';

export interface SemanticDimension {
    /** Display name */
    name: string;
    /** Actual column name in dataset rows */
    column: string;
    /** Data type of the dimension */
    dataType: 'string' | 'date' | 'number';
    /** Human-readable label (e.g., "Product Category") */
    label?: string;
    /** Whether this dimension is hidden from the UI */
    isHidden: boolean;
}

export interface SemanticMeasure {
    /** Display name */
    name: string;
    /** Actual column name in dataset rows */
    column: string;
    /** Deterministic aggregation — NEVER inferred at runtime */
    aggregation: AggregationType;
    /** Metric behavior type: additive (SUM-safe), semi-additive (SUM over some dims), non-additive (AVG/COUNT only) */
    behavior: MetricBehavior;
    /** Display format */
    format: 'currency_usd' | 'currency_eur' | 'percent' | 'raw' | 'count';
    /** Whether this metric requires weighting for correct AVG across groups */
    requiresWeighting: boolean;
    /** Column to use as weight (e.g., quantity for weighted average price) */
    weightColumn?: string;
    /** Human-readable label */
    label?: string;
    /** Whether this measure is hidden from the UI */
    isHidden: boolean;
}

export type RelationshipType = 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE';

export interface SemanticRelationship {
    leftTable: string;
    rightTable: string;
    leftKey: string;
    rightKey: string;
    type: RelationshipType;
    /** Whether this relationship was validated by cardinality check */
    validated: boolean;
}

/** Deterministic derived measure — computed from other columns, no AI */
export interface DerivedMeasure {
    id: string;
    label: string;
    formula: 'subtract' | 'divide' | 'multiply';
    numerator: string;    // column name
    denominator: string;  // column name
    multiply?: number;    // e.g. 100 for percentages
    format: 'currency_usd' | 'percent' | 'raw';
}

export interface SemanticModel {
    /** All recognized dimensions */
    dimensions: SemanticDimension[];
    /** All recognized measures with explicit aggregations */
    measures: SemanticMeasure[];
    /** Derived measures — computed deterministically from other columns */
    derivedMeasures: DerivedMeasure[];
    /** Table relationships (for multi-table datasets) */
    relationships: SemanticRelationship[];
    /** The primary date column used for time intelligence */
    primaryDateColumn: string | null;
    /** All date columns in the dataset */
    dateColumns: string[];
    /** Dataset grain — defines what each row represents (e.g. 'order_id', 'transaction') */
    grain: string | null;
    /** Model version — incremented on rebuild */
    version: number;
    /** Timestamp of model creation */
    builtAt: number;
    /** Build source */
    source: 'etl' | 'ai_enriched' | 'manual';
    /** Warnings generated during model building */
    warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════
// AI SUGGESTION GATE — Layer 1 (Enrichment) + Layer 2 (Validation)
// ═══════════════════════════════════════════════════════════════════

export interface AISuggestion {
    column: string;
    suggestedRole: ColumnType;
    suggestedAggregation: AggregationType;
    suggestedFormat: string;
    confidence: number;
    reason: string;
}

const AI_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Validate an AI suggestion against dataset statistics and rule-based checks.
 * AI output is NEVER used directly — it must pass this gate.
 */
function validateAISuggestion(
    suggestion: AISuggestion,
    column: ColumnDefinition,
    rows: Record<string, any>[]
): { accepted: boolean; reason: string } {
    // Gate 1: Confidence threshold
    if (suggestion.confidence < AI_CONFIDENCE_THRESHOLD) {
        return { accepted: false, reason: `Confidence ${suggestion.confidence} < threshold ${AI_CONFIDENCE_THRESHOLD}` };
    }

    // Gate 2: Role must match ETL classification (AI can't override deterministic classification)
    if (suggestion.suggestedRole !== column.type && column.type !== ColumnType.UNKNOWN) {
        return { accepted: false, reason: `AI role ${suggestion.suggestedRole} conflicts with ETL classification ${column.type}` };
    }

    // Gate 3: For metrics, verify aggregation makes sense
    if (suggestion.suggestedRole === ColumnType.METRIC) {
        const ruleBasedMetric = classifyMetric(suggestion.column);
        if (ruleBasedMetric && ruleBasedMetric.aggregation !== suggestion.suggestedAggregation) {
            return { accepted: false, reason: `AI aggregation ${suggestion.suggestedAggregation} conflicts with rule-based ${ruleBasedMetric.aggregation}` };
        }
    }

    // Gate 4: Statistical validation — check that numeric columns have actual numeric data
    if (suggestion.suggestedRole === ColumnType.METRIC) {
        const sample = rows.slice(0, 100);
        const numericCount = sample.filter(r => {
            const v = r[suggestion.column];
            return v !== null && v !== undefined && typeof v === 'number' && !isNaN(v);
        }).length;
        const numericRate = sample.length > 0 ? numericCount / sample.length : 0;
        if (numericRate < 0.5) {
            return { accepted: false, reason: `Column has only ${Math.round(numericRate * 100)}% numeric values, too low for METRIC` };
        }
    }

    return { accepted: true, reason: 'Passed all validation gates' };
}

// ═══════════════════════════════════════════════════════════════════
// MODEL BUILDER — Deterministic construction from ETL output
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a SemanticModel from a dataset's columns and optional AI profile.
 *
 * RULES:
 *   1. Start with deterministic classification from ETL (column.type)
 *   2. Apply metric registry for explicit aggregation rules
 *   3. Optionally enrich with AI suggestions (only if they pass validation gate)
 *   4. THROW if no measures or no dimensions found
 */
export function buildSemanticModel(
    dataset: Dataset,
    existingModel?: SemanticModel
): SemanticModel {
    const warnings: string[] = [];
    const dimensions: SemanticDimension[] = [];
    const measures: SemanticMeasure[] = [];
    const dateColumns: string[] = [];
    let primaryDateColumn: string | null = null;

    // ── Step 1: Classify each column using ETL types + Metric Registry ──
    for (const col of dataset.columns) {
        switch (col.type) {
            case ColumnType.DATE: {
                dateColumns.push(col.name);
                // Date columns are also dimensions (for time-based grouping)
                dimensions.push({
                    name: col.name,
                    column: col.name,
                    dataType: 'date',
                    label: humanizeColumnName(col.name),
                    isHidden: false,
                });
                break;
            }

            case ColumnType.METRIC: {
                const metricDef = classifyMetric(col.name);
                if (metricDef) {
                    measures.push({
                        name: col.name,
                        column: col.name,
                        aggregation: metricDef.aggregation,
                        behavior: metricDef.behavior,
                        format: metricDef.format,
                        requiresWeighting: metricDef.requiresWeighting,
                        weightColumn: metricDef.weightColumn,
                        label: humanizeColumnName(col.name),
                        isHidden: false,
                    });
                } else {
                    // Metric column not in registry — default to SUM with warning
                    warnings.push(`Metric "${col.name}" not found in registry, defaulting to SUM. Review recommended.`);
                    measures.push({
                        name: col.name,
                        column: col.name,
                        aggregation: AggregationType.SUM,
                        behavior: 'additive',
                        format: 'raw',
                        requiresWeighting: false,
                        label: humanizeColumnName(col.name),
                        isHidden: false,
                    });
                }
                break;
            }

            case ColumnType.DIMENSION: {
                const dimDef = classifyDimension(col.name);
                dimensions.push({
                    name: col.name,
                    column: col.name,
                    dataType: dimDef?.dataType || 'string',
                    label: humanizeColumnName(col.name),
                    isHidden: false,
                });
                break;
            }

            case ColumnType.ID: {
                // IDs are hidden dimensions by default — available for COUNT_DISTINCT
                dimensions.push({
                    name: col.name,
                    column: col.name,
                    dataType: 'string',
                    label: humanizeColumnName(col.name),
                    isHidden: true,
                });
                // Also register as a countable measure
                measures.push({
                    name: `${col.name}_count`,
                    column: col.name,
                    aggregation: AggregationType.COUNT_DISTINCT,
                    behavior: 'non_additive',
                    format: 'count',
                    requiresWeighting: false,
                    label: `Unique ${humanizeColumnName(col.name)}`,
                    isHidden: false,
                });
                break;
            }

            default: {
                warnings.push(`Column "${col.name}" has unknown type, skipping.`);
                break;
            }
        }
    }

    // ── Step 2: Determine primary date column ──
    if (dataset.timeContext?.anchorDateColumn) {
        primaryDateColumn = dataset.timeContext.anchorDateColumn;
    } else if (dateColumns.length === 1) {
        primaryDateColumn = dateColumns[0];
    } else if (dateColumns.length > 1) {
        // Prefer common date names
        const preferred = ['order_date', 'sale_date', 'date', 'created_at', 'transaction_date', 'purchase_date'];
        primaryDateColumn = dateColumns.find(d => preferred.includes(d.toLowerCase())) || dateColumns[0];
        warnings.push(`Multiple date columns found (${dateColumns.join(', ')}). Using "${primaryDateColumn}" as primary.`);
    }
    // If no date columns, time intelligence will be disabled (not an error)

    // ── Step 3: Enrich with AI profile (if available + passes validation) ──
    if (dataset.domainProfile?.columnSemantics) {
        const semantics = dataset.domainProfile.columnSemantics;

        for (const [colName, semantic] of Object.entries(semantics)) {
            const col = dataset.columns.find(c => c.name === colName);
            if (!col) continue;

            const suggestion: AISuggestion = {
                column: colName,
                suggestedRole: semantic.role,
                suggestedAggregation: semantic.aggregation as AggregationType || AggregationType.SUM,
                suggestedFormat: semantic.format,
                confidence: dataset.domainProfile.confidence ?? 0,
                reason: semantic.description || '',
            };

            const validation = validateAISuggestion(suggestion, col, dataset.rows);

            if (validation.accepted) {
                // Update labels and descriptions from AI (non-computational enrichment)
                const existingMeasure = measures.find(m => m.column === colName);
                if (existingMeasure && semantic.humanLabel) {
                    existingMeasure.label = semantic.humanLabel;
                }
                const existingDim = dimensions.find(d => d.column === colName);
                if (existingDim && semantic.humanLabel) {
                    existingDim.label = semantic.humanLabel;
                }

                // Apply hidden flag from AI
                if (semantic.isHidden) {
                    const m = measures.find(m => m.column === colName);
                    if (m) m.isHidden = true;
                    const d = dimensions.find(d => d.column === colName);
                    if (d) d.isHidden = true;
                }
            }
            // If rejected, keep the deterministic classification — no fallback
        }
    }

    // ── Step 4: Validation ──
    const visibleMeasures = measures.filter(m => !m.isHidden);
    const visibleDimensions = dimensions.filter(d => !d.isHidden);

    if (visibleMeasures.length === 0) {
        warnings.push('No visible measures detected. Analysis will be limited to COUNT operations.');
    }
    if (visibleDimensions.length === 0) {
        warnings.push('No visible dimensions detected. Only aggregate KPIs will be available.');
    }

    // ── Step 5: Detect grain (what each row represents) ──
    let grain: string | null = null;
    // Priority 1: ID columns (most specific)
    const idCols = dataset.columns.filter(c => c.type === ColumnType.ID);
    if (idCols.length > 0) {
        // Prefer 'order_id', 'transaction_id' over generic 'id'
        const preferred = idCols.find(c => /order|transaction|invoice|ticket|booking/i.test(c.name));
        grain = (preferred || idCols[0]).name;
    } else {
        // Priority 2: Primary key from unique columns
        const sample = dataset.rows.slice(0, 500);
        for (const col of dataset.columns) {
            if (col.type === ColumnType.METRIC || col.type === ColumnType.DATE) continue;
            const vals = sample.map(r => r[col.name]).filter(v => v !== null && v !== undefined);
            const uniq = new Set(vals.map(String));
            if (vals.length > 10 && uniq.size / vals.length >= 0.95) {
                grain = col.name;
                break;
            }
        }
    }
    if (!grain) {
        warnings.push('Grain not detected — each row\'s identity is ambiguous. Add an ID column for reliability.');
    }

    // ── Step 6: Build derived measures deterministically ──
    const derivedMeasures: DerivedMeasure[] = [];
    const measureNames = measures.map(m => m.column.toLowerCase());

    // profit = revenue - cost
    const hasRevenue = measureNames.find(n => /revenue|sales|amount/.test(n));
    const hasCost = measureNames.find(n => /cost|cogs|expense/.test(n));
    if (hasRevenue && hasCost) {
        const revCol = measures.find(m => m.column.toLowerCase() === hasRevenue)!.column;
        const costCol = measures.find(m => m.column.toLowerCase() === hasCost)!.column;
        derivedMeasures.push({ id: 'profit', label: 'Profit', formula: 'subtract', numerator: revCol, denominator: costCol, format: 'currency_usd' });
    }

    // AOV = revenue / order count
    const hasOrderId = dataset.columns.find(c => c.type === ColumnType.ID && /order|transaction/i.test(c.name));
    if (hasRevenue && hasOrderId) {
        const revCol = measures.find(m => m.column.toLowerCase() === hasRevenue)!.column;
        derivedMeasures.push({ id: 'aov', label: 'Average Order Value', formula: 'divide', numerator: revCol, denominator: hasOrderId.name, format: 'currency_usd' });
    }

    // Margin % = profit / revenue × 100 (only if profit derived exists)
    if (hasRevenue && hasCost) {
        const revCol = measures.find(m => m.column.toLowerCase() === hasRevenue)!.column;
        derivedMeasures.push({ id: 'margin_pct', label: 'Profit Margin %', formula: 'divide', numerator: 'profit', denominator: revCol, multiply: 100, format: 'percent' });
    }

    return {
        dimensions,
        measures,
        derivedMeasures,
        relationships: existingModel?.relationships || [],
        primaryDateColumn,
        dateColumns,
        grain,
        version: (existingModel?.version || 0) + 1,
        builtAt: Date.now(),
        source: dataset.domainProfile ? 'ai_enriched' : 'etl',
        warnings,
    };
}

// ═══════════════════════════════════════════════════════════════════
// MODEL LOOKUP FUNCTIONS — Used by the analysis engine
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the measure definition for a column. THROWS if not found.
 */
export function getMeasure(model: SemanticModel, columnName: string): SemanticMeasure {
    // Try exact match first
    let measure = model.measures.find(m => m.column === columnName);
    if (measure) return measure;

    // Try by name (for derived measures like "order_id_count")
    measure = model.measures.find(m => m.name === columnName);
    if (measure) return measure;

    // Try case-insensitive
    const lower = columnName.toLowerCase();
    measure = model.measures.find(m => m.column.toLowerCase() === lower || m.name.toLowerCase() === lower);
    if (measure) return measure;

    throw new Error(`[SemanticModel] Unknown metric: "${columnName}". Available measures: ${model.measures.map(m => m.column).join(', ')}`);
}

/**
 * Try to get a measure, returns null if not found (non-throwing variant).
 */
export function findMeasure(model: SemanticModel, columnName: string): SemanticMeasure | null {
    try {
        return getMeasure(model, columnName);
    } catch {
        return null;
    }
}

/**
 * Get the dimension definition for a column. THROWS if not found.
 */
export function getDimension(model: SemanticModel, columnName: string): SemanticDimension {
    let dim = model.dimensions.find(d => d.column === columnName);
    if (dim) return dim;

    // Case-insensitive fallback
    const lower = columnName.toLowerCase();
    dim = model.dimensions.find(d => d.column.toLowerCase() === lower);
    if (dim) return dim;

    throw new Error(`[SemanticModel] Unknown dimension: "${columnName}". Available dimensions: ${model.dimensions.map(d => d.column).join(', ')}`);
}

/**
 * Try to get a dimension, returns null if not found.
 */
export function findDimension(model: SemanticModel, columnName: string): SemanticDimension | null {
    try {
        return getDimension(model, columnName);
    } catch {
        return null;
    }
}

/**
 * Validate that a QueryConfig is compatible with the semantic model.
 * Returns warnings and throws on critical errors.
 */
export function validateQueryAgainstModel(
    model: SemanticModel,
    metric: string,
    dimension: string,
    aggregation?: AggregationType
): { warnings: string[]; resolvedMetric: SemanticMeasure; resolvedDimension: SemanticDimension } {
    const warnings: string[] = [];

    const resolvedMetric = getMeasure(model, metric);
    const resolvedDimension = getDimension(model, dimension);

    // Check aggregation override consistency
    if (aggregation && aggregation !== resolvedMetric.aggregation) {
        if (resolvedMetric.behavior === 'non_additive' && aggregation === AggregationType.SUM) {
            throw new Error(
                `[SemanticModel] Cannot SUM non-additive metric "${metric}" (e.g., price, rate). ` +
                `Use ${resolvedMetric.aggregation} instead.`
            );
        }
        warnings.push(
            `Aggregation override: "${metric}" uses ${aggregation} instead of default ${resolvedMetric.aggregation}.`
        );
    }

    return { warnings, resolvedMetric, resolvedDimension };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert snake_case column name to human-readable label.
 */
function humanizeColumnName(name: string): string {
    return name
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .replace(/\bId\b/g, 'ID')
        .replace(/\bAov\b/g, 'AOV')
        .replace(/\bSku\b/g, 'SKU')
        .trim();
}
