import type { AnalyticalIR, AnalyticalOperator, IRVerificationIssue } from './analyticalIR';

function visibleColumns(rows: Record<string, unknown>[]): string[] {
    return rows.length ? Object.keys(rows[0]) : [];
}

function findNumericValue(row: Record<string, unknown>, preferred: string[]): number | undefined {
    for (const key of preferred) {
        const actual = Object.keys(row).find(column => column.toLowerCase() === key.toLowerCase());
        if (actual && typeof row[actual] === 'number' && Number.isFinite(row[actual])) return row[actual] as number;
    }
    const values = Object.values(row).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length === 1 ? values[0] : undefined;
}

/**
 * Validate executed rows against analytical invariants implied by the IR.
 * These checks never compare against benchmark gold data and never inspect
 * rows outside the local browser process.
 */
export function validateAnalyticalResult(
    rows: Record<string, unknown>[],
    ir: AnalyticalIR,
): IRVerificationIssue[] {
    const issues: IRVerificationIssue[] = [];
    const operators = <K extends AnalyticalOperator['kind']>(kind: K) =>
        ir.operators.filter((operator): operator is Extract<AnalyticalOperator, { kind: K }> => operator.kind === kind);
    const limit = operators('limit')[0];
    const ratio = operators('ratio')[0];
    const group = operators('group')[0];

    if (ir.answer.cardinality === 'scalar' && rows.length !== 1) {
        issues.push({ code: 'scalar_cardinality', severity: 'error', message: `A scalar answer must return exactly one row; received ${rows.length}.` });
    }
    if (limit && rows.length > limit.count) {
        issues.push({ code: 'limit_cardinality', severity: 'error', message: `The requested limit is ${limit.count}, but ${rows.length} rows were returned.` });
    }

    const uniqueFields = ir.answer.distinct
        ? ir.answer.fields.filter(field => field.visibility === 'visible').map(field => field.field)
        : group?.grain.map(field => field.field) || [];
    if (uniqueFields.length && rows.length > 1) {
        const keys = rows.map(row => uniqueFields.map(field => {
            const actual = Object.keys(row).find(column => column.toLowerCase() === field.toLowerCase());
            return actual ? JSON.stringify(row[actual]) : '__missing__';
        }).join('|'));
        if (new Set(keys).size !== keys.length) {
            issues.push({ code: 'duplicate_result_grain', severity: 'error', message: `The result repeats the requested grain (${uniqueFields.join(', ')}).` });
        }
    }

    if (rows.length) {
        const available = visibleColumns(rows);
        for (const field of ir.answer.fields.filter(candidate => candidate.visibility === 'visible' && candidate.role !== 'calculation')) {
            if (!available.some(column => column.toLowerCase() === field.field.toLowerCase())) {
                issues.push({ code: 'missing_visible_field', severity: 'error', message: `The result is missing requested field "${field.field}".` });
            }
        }
    }

    if (ratio?.scale === 100 && rows.length === 1) {
        const aliases = ir.answer.fields.filter(field => field.role === 'calculation').map(field => field.field);
        const value = findNumericValue(rows[0], aliases);
        if (value !== undefined && (value < 0 || value > 100)) {
            issues.push({ code: 'percentage_range', severity: 'error', message: `A share/percentage of a population must be between 0 and 100; received ${value}.` });
        }
    }

    return issues;
}

