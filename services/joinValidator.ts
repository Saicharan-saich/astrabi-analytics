/**
 * joinValidator.ts — Join Validation Engine
 *
 * RULES:
 *   - MANY_TO_MANY → THROW ERROR (never allowed)
 *   - Unknown relationship → THROW ERROR
 *   - Enrichment requires exact left-row preservation and unique lookup keys
 *   - Every join must be validated for cardinality BEFORE results are used
 *
 * PRINCIPLE: System MUST FAIL instead of producing silently duplicated data.
 */

import type { SemanticRelationship, RelationshipType } from './semanticModel';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface JoinValidationResult {
    valid: boolean;
    relationship: RelationshipType | 'MANY_TO_MANY' | 'UNKNOWN';
    leftRowCount: number;
    rightRowCount: number;
    joinedRowCount: number;
    fanOutRatio: number;
    warnings: string[];
    error?: string;
}

export interface CardinalityReport {
    leftDistinctKeys: number;
    rightDistinctKeys: number;
    leftDuplicateRate: number;
    rightDuplicateRate: number;
    relationship: RelationshipType | 'MANY_TO_MANY';
    isValid: boolean;
    error?: string;
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/** Maximum allowed fan-out ratio before a join is rejected */
const MAX_FANOUT_RATIO = 1; // Exact row preservation for enrichment.

/** Uniqueness threshold for a key to be considered "unique" in a table */
const UNIQUENESS_THRESHOLD = 1; // A duplicate lookup key is never effectively unique.

// ═══════════════════════════════════════════════════════════════════
// CARDINALITY DETECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect the cardinality relationship between two sets of join keys.
 *
 * ONE_TO_ONE:   Both sides have unique keys
 * ONE_TO_MANY:  Left side unique, right side has duplicates
 * MANY_TO_ONE:  Right side unique, left side has duplicates
 * MANY_TO_MANY: Both sides have duplicate keys → ERROR
 */
export function detectCardinality(
    leftRows: Record<string, any>[],
    rightRows: Record<string, any>[],
    leftKey: string,
    rightKey: string
): CardinalityReport {
    // Extract key values
    const leftKeys = leftRows.map(r => r[leftKey]).filter(v => v !== null && v !== undefined);
    const rightKeys = rightRows.map(r => r[rightKey]).filter(v => v !== null && v !== undefined);

    const leftDistinct = new Set(leftKeys.map(String));
    const rightDistinct = new Set(rightKeys.map(String));

    const leftDistinctKeys = leftDistinct.size;
    const rightDistinctKeys = rightDistinct.size;

    const leftDuplicateRate = leftKeys.length > 0 ? 1 - (leftDistinctKeys / leftKeys.length) : 0;
    const rightDuplicateRate = rightKeys.length > 0 ? 1 - (rightDistinctKeys / rightKeys.length) : 0;

    const leftIsUnique = leftKeys.length > 0 && (leftDistinctKeys / leftKeys.length) >= UNIQUENESS_THRESHOLD;
    const rightIsUnique = rightKeys.length > 0 && (rightDistinctKeys / rightKeys.length) >= UNIQUENESS_THRESHOLD;

    let relationship: RelationshipType | 'MANY_TO_MANY';
    let isValid = true;
    let error: string | undefined;

    if (leftIsUnique && rightIsUnique) {
        relationship = 'ONE_TO_ONE';
    } else if (leftIsUnique && !rightIsUnique) {
        relationship = 'ONE_TO_MANY';
    } else if (!leftIsUnique && rightIsUnique) {
        relationship = 'MANY_TO_ONE';
    } else {
        relationship = 'MANY_TO_MANY';
        isValid = false;
        error = `MANY_TO_MANY relationship detected between "${leftKey}" and "${rightKey}". ` +
            `Left has ${Math.round(leftDuplicateRate * 100)}% duplicates, right has ${Math.round(rightDuplicateRate * 100)}% duplicates. ` +
            `This will cause row duplication. A bridge table or pre-aggregation is required.`;
    }

    return {
        leftDistinctKeys,
        rightDistinctKeys,
        leftDuplicateRate,
        rightDuplicateRate,
        relationship,
        isValid,
        error,
    };
}

// ═══════════════════════════════════════════════════════════════════
// JOIN VALIDATION — Post-Join Check
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate a join result by comparing row counts.
 * THROWS if fan-out is detected (joined rows > MAX_FANOUT_RATIO * left rows).
 *
 * This is the LAST LINE OF DEFENSE — if cardinality detection missed something,
 * this catches the actual row duplication.
 */
export function validateJoin(
    leftRows: any[],
    rightRows: any[],
    joinedRows: any[],
    leftTable: string,
    rightTable: string,
    leftKey: string,
    rightKey: string
): JoinValidationResult {
    const leftCount = leftRows.length;
    const rightCount = rightRows.length;
    const joinedCount = joinedRows.length;
    const fanOutRatio = leftCount > 0 ? joinedCount / leftCount : 0;

    const warnings: string[] = [];

    const cardinality = detectCardinality(leftRows, rightRows, leftKey, rightKey);
    // A lookup can silently discard duplicate target rows without changing size.
    if (joinedCount !== leftCount || cardinality.rightDuplicateRate > 0) {
        const error = `Unsafe enrichment: "${leftTable}" (${leftCount} rows) LEFT JOIN "${rightTable}" (${rightCount} rows) ` +
            `produced ${joinedCount} rows (${Math.round(fanOutRatio * 100)}% fan-out). ` +
            `Expected ≤ ${Math.round(leftCount * MAX_FANOUT_RATIO)} rows. ` +
            `Check for MANY_TO_MANY relationship on keys "${leftKey}" ↔ "${rightKey}".`;

        return {
            valid: false,
            relationship: 'UNKNOWN',
            leftRowCount: leftCount,
            rightRowCount: rightCount,
            joinedRowCount: joinedCount,
            fanOutRatio,
            warnings,
            error,
        };
    }

    // Check for significant data loss (LEFT JOIN should not lose rows)
    if (joinedCount < leftCount * 0.5) {
        warnings.push(
            `Join lost ${leftCount - joinedCount} rows (${Math.round((1 - joinedCount / leftCount) * 100)}% loss). ` +
            `Check if join key "${leftKey}" matches "${rightKey}".`
        );
    }

    // Check for null join keys
    const nullLeftKeys = leftRows.filter(r => r[leftKey] === null || r[leftKey] === undefined).length;
    const nullRightKeys = rightRows.filter(r => r[rightKey] === null || r[rightKey] === undefined).length;

    if (nullLeftKeys > 0) {
        warnings.push(`${nullLeftKeys} rows in "${leftTable}" have NULL values for join key "${leftKey}".`);
    }
    if (nullRightKeys > 0) {
        warnings.push(`${nullRightKeys} rows in "${rightTable}" have NULL values for join key "${rightKey}".`);
    }

    // Determine relationship from actual keys, not the output row count.
    let relationship: RelationshipType | 'MANY_TO_MANY' | 'UNKNOWN';
    relationship = cardinality.relationship;

    return {
        valid: true,
        relationship,
        leftRowCount: leftCount,
        rightRowCount: rightCount,
        joinedRowCount: joinedCount,
        fanOutRatio,
        warnings,
    };
}

// ═══════════════════════════════════════════════════════════════════
// PRE-JOIN VALIDATION — Check Before Executing Join
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate that a join is safe to execute BEFORE running it.
 * THROWS on MANY_TO_MANY relationships.
 */
export function validateJoinSafety(
    leftRows: Record<string, any>[],
    rightRows: Record<string, any>[],
    leftKey: string,
    rightKey: string,
    leftTable: string,
    rightTable: string
): { safe: boolean; relationship: SemanticRelationship; warnings: string[] } {
    const cardinality = detectCardinality(leftRows, rightRows, leftKey, rightKey);
    const warnings: string[] = [];

    if (!cardinality.isValid) {
        throw new Error(cardinality.error || `Unsafe join detected between "${leftTable}" and "${rightTable}".`);
    }

    if (cardinality.relationship === 'MANY_TO_MANY') {
        throw new Error(
            `MANY_TO_MANY join between "${leftTable}.${leftKey}" and "${rightTable}.${rightKey}" is not allowed. ` +
            `This will produce ${leftRows.length * rightRows.length} rows (cartesian product). ` +
            `Pre-aggregate one side or use a bridge table.`
        );
    }

    // Warn on high duplicate rates even for valid joins
    if (cardinality.leftDuplicateRate > 0.5) {
        warnings.push(
            `High duplicate rate (${Math.round(cardinality.leftDuplicateRate * 100)}%) in "${leftTable}.${leftKey}".`
        );
    }
    if (cardinality.rightDuplicateRate > 0.5) {
        warnings.push(
            `High duplicate rate (${Math.round(cardinality.rightDuplicateRate * 100)}%) in "${rightTable}.${rightKey}".`
        );
    }

    return {
        safe: true,
        relationship: {
            leftTable,
            rightTable,
            leftKey,
            rightKey,
            type: cardinality.relationship as RelationshipType,
            validated: true,
        },
        warnings,
    };
}

// ═══════════════════════════════════════════════════════════════════
// METRIC DUPLICATION DETECTION — Advanced Post-Join Validation
// ═══════════════════════════════════════════════════════════════════

export interface MetricDuplicationResult {
    isDuplicated: boolean;
    metricColumn: string;
    preJoinSum: number;
    postJoinSum: number;
    inflationRatio: number;
    error?: string;
}

/**
 * Detect if a join has caused metric values to be duplicated.
 *
 * Compares SUM(metric) before the join vs SUM(metric) after the join.
 * If the post-join sum is >5% higher, the join has silently inflated totals.
 *
 * Example: Orders (revenue=$1000) LEFT JOIN Order_Items → revenue duplicated per item → $3000
 * This function catches that.
 *
 * THROWS if duplication is detected and threshold exceeded.
 */
export function detectMetricDuplication(
    preJoinRows: Record<string, any>[],
    postJoinRows: Record<string, any>[],
    metricColumns: string[],
    tolerance: number = 0.05 // 5% tolerance
): MetricDuplicationResult[] {
    const results: MetricDuplicationResult[] = [];

    for (const metric of metricColumns) {
        // Compute pre-join sum
        let preJoinSum = 0;
        let preCount = 0;
        for (const row of preJoinRows) {
            const val = Number(row[metric]);
            if (!isNaN(val)) {
                preJoinSum += val;
                preCount++;
            }
        }

        // Compute post-join sum
        let postJoinSum = 0;
        let postCount = 0;
        for (const row of postJoinRows) {
            const val = Number(row[metric]);
            if (!isNaN(val)) {
                postJoinSum += val;
                postCount++;
            }
        }

        // Skip if no data
        if (preCount === 0 || preJoinSum === 0) continue;

        const inflationRatio = postJoinSum / preJoinSum;
        const isDuplicated = inflationRatio > (1 + tolerance);

        if (isDuplicated) {
            results.push({
                isDuplicated: true,
                metricColumn: metric,
                preJoinSum,
                postJoinSum,
                inflationRatio,
                error: `Metric duplication detected: "${metric}" sum inflated from ${preJoinSum.toLocaleString()} → ${postJoinSum.toLocaleString()} ` +
                    `(${Math.round((inflationRatio - 1) * 100)}% inflation). ` +
                    `The join is duplicating metric rows. Pre-aggregate the metric before joining.`,
            });
        } else {
            results.push({
                isDuplicated: false,
                metricColumn: metric,
                preJoinSum,
                postJoinSum,
                inflationRatio,
            });
        }
    }

    // Hard fail if ANY metric is duplicated
    const duplicated = results.filter(r => r.isDuplicated);
    if (duplicated.length > 0) {
        throw new Error(
            `[JOIN SAFETY] Metric duplication detected in ${duplicated.length} column(s):\n` +
            duplicated.map(d => `  • ${d.error}`).join('\n')
        );
    }

    return results;
}
