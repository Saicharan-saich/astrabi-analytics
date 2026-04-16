/**
 * Semantic Layer — Auto-infers a SemanticModel from the dataset
 * 
 * Uses existing ETL column profiles (currency/percentage/date detection)
 * to classify each column with its semantic type, role, default aggregation,
 * time grain support, and synonyms.
 */

import { Dataset, ColumnType } from '../../types';
import {
    SemanticField, SemanticModel, SemanticType, FieldRole, MetricDefinition
} from './types';
import { buildCompositeMetrics, buildDerivedMetrics } from './metricRegistry';

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

// ─── Column Name Pattern Matchers ────────────────────────────────
const CURRENCY_PATTERNS = /\b(sales|revenue|price|cost|total|amount|profit|discount|shipping|tax|payment|spend|income|earning|margin|fee|charge|balance)\b/i;
const PERCENTAGE_PATTERNS = /\b(rate|pct|percent|ratio|margin_pct|discount_pct|growth_pct|share|proportion)\b/i;
const COUNT_PATTERNS = /\b(count|num|number_of|total_count|qty|quantity|units|items|orders|transactions)\b/i;
const DATE_PATTERNS = /\b(date|day|month|year|quarter|week|time|timestamp|created|updated|ordered|shipped|delivered)\b/i;
const GEO_PATTERNS = /\b(region|state|city|country|zip|postal|address|geo|territory|area|location|lat|lng|longitude|latitude)\b/i;
const ID_PATTERNS = /\b(id|_id|key|code|number|no|num)$/i;

/**
 * Infer the semantic type for a single column
 */
function inferSemanticType(
    colName: string,
    colType: ColumnType,
    distinctCount: number,
    totalRows: number,
    sampleValues: any[]
): { semanticType: SemanticType; formatHint?: SemanticField['formatHint'] } {
    const name = colName.toLowerCase();

    // Date columns
    if (colType === ColumnType.DATE) {
        return { semanticType: 'date', formatHint: 'date' };
    }

    // ID columns
    if (colType === ColumnType.ID || ID_PATTERNS.test(name)) {
        return { semanticType: 'identifier', formatHint: 'text' };
    }

    // Numeric columns — classify by name patterns
    if (colType === ColumnType.METRIC) {
        // Check for percentage patterns first (more specific)
        if (PERCENTAGE_PATTERNS.test(name)) {
            return { semanticType: 'percentage', formatHint: 'percent' };
        }
        // Check for currency patterns
        if (CURRENCY_PATTERNS.test(name)) {
            // Check if values look like small percentages vs large currency
            const maxVal = Math.max(...sampleValues.filter(v => typeof v === 'number').map(Math.abs));
            if (maxVal <= 1 && PERCENTAGE_PATTERNS.test(name)) {
                return { semanticType: 'percentage', formatHint: 'percent' };
            }
            return { semanticType: 'currency', formatHint: 'currency_usd' };
        }
        // Check for count/quantity patterns
        if (COUNT_PATTERNS.test(name)) {
            return { semanticType: 'quantity', formatHint: 'integer' };
        }
        // Default numeric — check value ranges
        const numericSamples = sampleValues.filter(v => typeof v === 'number');
        if (numericSamples.length > 0) {
            const maxVal = Math.max(...numericSamples.map(Math.abs));
            if (maxVal <= 1) return { semanticType: 'ratio', formatHint: 'decimal' };
            if (maxVal <= 100 && name.includes('pct')) return { semanticType: 'percentage', formatHint: 'percent' };
        }
        return { semanticType: 'quantity', formatHint: 'decimal' };
    }

    // Text/Dimension columns
    if (GEO_PATTERNS.test(name)) {
        return { semanticType: 'geography', formatHint: 'text' };
    }

    // Category vs text — use cardinality
    if (distinctCount > 0 && distinctCount < totalRows * 0.5) {
        return { semanticType: 'category', formatHint: 'text' };
    }

    return { semanticType: 'text', formatHint: 'text' };
}

/**
 * Determine the role (metric vs dimension) for a column
 */
function inferRole(colType: ColumnType, semanticType: SemanticType): FieldRole {
    if (semanticType === 'currency' || semanticType === 'percentage' ||
        semanticType === 'quantity' || semanticType === 'count' || semanticType === 'ratio') {
        return 'metric';
    }
    if (colType === ColumnType.METRIC) return 'metric';
    return 'dimension';
}

/**
 * Determine default aggregation
 */
function inferDefaultAgg(semanticType: SemanticType, role: FieldRole): SemanticField['defaultAgg'] {
    if (role === 'dimension') return 'none';
    switch (semanticType) {
        case 'currency': return 'sum';
        case 'quantity': return 'sum';
        case 'count': return 'count';
        case 'percentage': return 'avg';
        case 'ratio': return 'avg';
        default: return 'sum';
    }
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
 * This is the main entry point for the semantic layer.
 */
export function buildSemanticModel(dataset: Dataset): SemanticModel {
    const fields: SemanticField[] = [];
    const rows = dataset.rows;
    const totalRows = rows.length;

    for (const col of dataset.columns) {
        // Get the actual key in the data (case-insensitive match)
        const actualKey = totalRows > 0
            ? Object.keys(rows[0]).find(k => k.toLowerCase() === col.name.toLowerCase()) || col.name
            : col.name;

        // Collect sample values
        const sampleSet = new Set<string>();
        const numericSamples: number[] = [];
        for (let i = 0; i < Math.min(totalRows, 500) && sampleSet.size < 10; i++) {
            const val = rows[i][actualKey];
            if (val !== null && val !== undefined && val !== '') {
                sampleSet.add(String(val).substring(0, 50));
                if (typeof val === 'number') numericSamples.push(val);
            }
        }

        // Compute distinct count
        const distinctValues = new Set<any>();
        for (let i = 0; i < Math.min(totalRows, 2000); i++) {
            distinctValues.add(rows[i]?.[actualKey]);
        }
        const distinctCount = distinctValues.size;

        // Check for nulls
        const nullCount = rows.slice(0, 500).filter(r => r[actualKey] === null || r[actualKey] === undefined || r[actualKey] === '').length;

        // Infer semantic type
        const { semanticType, formatHint } = inferSemanticType(
            col.name, col.type, distinctCount, totalRows, numericSamples
        );

        // Infer role and aggregation
        const role = inferRole(col.type, semanticType);
        const defaultAgg = inferDefaultAgg(semanticType, role);

        // Time grain support
        const timeGrainSupport = semanticType === 'date'
            ? (['day', 'week', 'month', 'quarter', 'year'] as const).map(g => g)
            : [];

        // Compute range for numeric fields
        let range: { min: number; max: number } | undefined;
        if (numericSamples.length > 0) {
            range = {
                min: Math.min(...numericSamples),
                max: Math.max(...numericSamples)
            };
        }

        fields.push({
            name: col.name,
            physicalType: col.type === ColumnType.DATE ? 'date'
                : col.type === ColumnType.METRIC ? 'number'
                    : 'string',
            semanticType,
            role,
            defaultAgg,
            timeGrainSupport: timeGrainSupport as any,
            synonyms: generateSynonyms(col.name),
            sampleValues: Array.from(sampleSet).slice(0, 5),
            distinctCount,
            hasNulls: nullCount > 0,
            range,
            displayLabel: generateDisplayLabel(col.name),
            formatHint,
        });
    }

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
        console.warn(`[SemanticLayer] ⚠️ LARGE DATASET: ${totalRows.toLocaleString()} rows. Performance may be affected. Consider sampling or filtering.`);
    } else if (totalRows > 100000) {
        console.warn(`[SemanticLayer] NOTE: ${totalRows.toLocaleString()} rows — performance should be fine for most queries.`);
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

    // Fields table
    lines.push('Fields:');
    lines.push('  field | type | semantic | role | default_agg | samples');
    lines.push('  ' + '-'.repeat(90));

    for (const f of model.fields) {
        const samples = f.sampleValues.slice(0, 3).map(s => `"${s}"`).join(', ');
        lines.push(
            `  ${f.name} | ${f.physicalType} | ${f.semanticType} | ${f.role} | ${f.defaultAgg} | ${samples}`
        );
        if (f.synonyms.length > 0) {
            lines.push(`    synonyms: ${f.synonyms.join(', ')}`);
        }
    }

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
