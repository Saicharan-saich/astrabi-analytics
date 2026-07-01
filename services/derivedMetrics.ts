/**
 * derivedMetrics.ts — Deterministic Derived Metric Engine
 *
 * RULES:
 *   - NO AI formulas allowed — all computations are explicit
 *   - Formulas are defined in the SemanticModel, not at runtime
 *   - Division by zero → null (not 0, not Infinity)
 *   - All operations are row-level (no cross-row logic)
 *
 * SUPPORTED FORMULAS:
 *   - subtract: numerator - denominator (e.g., profit = revenue - cost)
 *   - divide:   numerator / denominator (e.g., AOV = revenue / orders)
 *   - multiply: numerator * denominator (rarely used)
 */

import type { DerivedMeasure, SemanticModel } from './semanticModel';

/**
 * Compute a derived metric for a single row.
 * Returns null if inputs are invalid or division by zero.
 */
export function computeDerivedValue(
    row: Record<string, any>,
    derived: DerivedMeasure,
    allDerived?: DerivedMeasure[]
): number | null {
    let numVal: number;
    let denVal: number;

    // Resolve numerator — may reference another derived metric
    if (allDerived) {
        const numDerived = allDerived.find(d => d.id === derived.numerator);
        if (numDerived) {
            const computed = computeDerivedValue(row, numDerived);
            if (computed === null) return null;
            numVal = computed;
        } else {
            numVal = Number(row[derived.numerator]);
        }
    } else {
        numVal = Number(row[derived.numerator]);
    }

    denVal = Number(row[derived.denominator]);

    if (isNaN(numVal) || isNaN(denVal)) return null;

    let result: number;
    switch (derived.formula) {
        case 'subtract':
            result = numVal - denVal;
            break;
        case 'divide':
            if (denVal === 0) return null; // HARD: no division by zero
            result = numVal / denVal;
            break;
        case 'multiply':
            result = numVal * denVal;
            break;
        default:
            return null;
    }

    if (derived.multiply) {
        result *= derived.multiply;
    }

    return result;
}

/**
 * Compute all derived metrics for a dataset and add them as new columns.
 * Returns the enriched rows (new array, original untouched).
 */
export function computeAllDerivedMetrics(
    rows: Record<string, any>[],
    model: SemanticModel
): Record<string, any>[] {
    if (!model.derivedMeasures || model.derivedMeasures.length === 0) {
        return rows;
    }

    return rows.map(row => {
        const enriched = { ...row };
        for (const dm of model.derivedMeasures) {
            enriched[dm.id] = computeDerivedValue(row, dm, model.derivedMeasures);
        }
        return enriched;
    });
}

/**
 * Compute aggregated derived metric from grouped data.
 * For divide formulas: SUM(numerator) / SUM(denominator) — NOT AVG of ratios.
 * This is critical for correctness (e.g., AOV = total revenue / total orders).
 */
export function aggregateDerivedMetric(
    rows: Record<string, any>[],
    derived: DerivedMeasure,
    allDerived?: DerivedMeasure[]
): number | null {
    if (derived.formula === 'divide') {
        // Correct: SUM(num) / SUM(denom) — not AVG of per-row ratios
        let numSum = 0;
        let denSum = 0;
        let validCount = 0;

        for (const row of rows) {
            let numVal: number;
            // Resolve numerator that may be a derived metric itself
            if (allDerived) {
                const numDerived = allDerived.find(d => d.id === derived.numerator);
                if (numDerived) {
                    // For chained derived metrics (e.g. margin = profit / revenue where profit = revenue - cost)
                    // Compute the intermediate value per row
                    const computed = computeDerivedValue(row, numDerived);
                    if (computed === null) continue;
                    numVal = computed;
                } else {
                    numVal = Number(row[derived.numerator]);
                }
            } else {
                numVal = Number(row[derived.numerator]);
            }

            const denVal = Number(row[derived.denominator]);
            if (!isNaN(numVal) && !isNaN(denVal)) {
                numSum += numVal;
                denSum += denVal;
                validCount++;
            }
        }

        if (validCount === 0 || denSum === 0) return null;
        let result = numSum / denSum;
        if (derived.multiply) result *= derived.multiply;
        return result;
    }

    if (derived.formula === 'subtract') {
        // SUM(numerator) - SUM(denominator)
        let numSum = 0;
        let denSum = 0;
        for (const row of rows) {
            const numVal = Number(row[derived.numerator]);
            const denVal = Number(row[derived.denominator]);
            if (!isNaN(numVal)) numSum += numVal;
            if (!isNaN(denVal)) denSum += denVal;
        }
        return numSum - denSum;
    }

    return null;
}
