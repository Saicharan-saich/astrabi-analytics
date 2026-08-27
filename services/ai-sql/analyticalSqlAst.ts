import type { AnalyticalIR, AnalyticalOperator, IRFieldRef, IRPredicate } from './analyticalIR';

export type SqlExpression =
    | { kind: 'column'; name: string; table?: string }
    | { kind: 'star' }
    | { kind: 'literal'; value: unknown }
    | { kind: 'aggregate'; fn: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX'; argument: SqlExpression }
    | { kind: 'binary'; left: SqlExpression; operator: string; right: SqlExpression }
    | { kind: 'list'; values: SqlExpression[] };

export interface SelectItemAst {
    expression: SqlExpression;
    alias?: string;
}

export interface SelectQueryAst {
    kind: 'select';
    distinct: boolean;
    select: SelectItemAst[];
    from: { table: string; alias?: string };
    where: SqlExpression[];
    groupBy: SqlExpression[];
    having: SqlExpression[];
    orderBy: Array<{ expression: SqlExpression; direction: 'ASC' | 'DESC' }>;
    limit?: number;
}

export interface IRSQLCompilation {
    supported: boolean;
    sql?: string;
    ast?: SelectQueryAst;
    reasons: string[];
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function literal(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return `'${String(value).replace(/'/g, "''")}'`;
}

function renderExpression(expression: SqlExpression): string {
    switch (expression.kind) {
        case 'column': return expression.table
            ? `${quoteIdentifier(expression.table)}.${quoteIdentifier(expression.name)}`
            : quoteIdentifier(expression.name);
        case 'star': return '*';
        case 'literal': return literal(expression.value);
        case 'aggregate': return `${expression.fn}(${renderExpression(expression.argument)})`;
        case 'binary': return `${renderExpression(expression.left)} ${expression.operator} ${renderExpression(expression.right)}`;
        case 'list': return `(${expression.values.map(renderExpression).join(', ')})`;
    }
}

export function renderSelectAst(ast: SelectQueryAst): string {
    const lines = [
        `SELECT${ast.distinct ? ' DISTINCT' : ''}`,
        `  ${ast.select.map(item => `${renderExpression(item.expression)}${item.alias ? ` AS ${quoteIdentifier(item.alias)}` : ''}`).join(',\n  ')}`,
        `FROM ${quoteIdentifier(ast.from.table)}${ast.from.alias ? ` AS ${quoteIdentifier(ast.from.alias)}` : ''}`,
    ];
    if (ast.where.length) lines.push(`WHERE ${ast.where.map(renderExpression).join('\n  AND ')}`);
    if (ast.groupBy.length) lines.push(`GROUP BY ${ast.groupBy.map(renderExpression).join(', ')}`);
    if (ast.having.length) lines.push(`HAVING ${ast.having.map(renderExpression).join('\n  AND ')}`);
    if (ast.orderBy.length) lines.push(`ORDER BY ${ast.orderBy.map(order => `${renderExpression(order.expression)} ${order.direction}`).join(', ')}`);
    if (ast.limit !== undefined) lines.push(`LIMIT ${ast.limit}`);
    return lines.join('\n');
}

function column(field: IRFieldRef, qualify = false): SqlExpression {
    return { kind: 'column', name: field.field, table: qualify ? field.table : undefined };
}

function aggregateExpression(
    measure: Extract<AnalyticalOperator, { kind: 'aggregate' }>['measures'][number],
): SqlExpression {
    return {
        kind: 'aggregate',
        fn: measure.aggregation.toUpperCase() as 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX',
        argument: measure.field === '*' ? { kind: 'star' } : column(measure),
    };
}

function predicateExpression(
    predicate: IRPredicate,
    aggregateMeasures: Extract<AnalyticalOperator, { kind: 'aggregate' }>['measures'],
): SqlExpression | undefined {
    const measure = predicate.scope === 'having'
        ? aggregateMeasures.find(candidate => candidate.field.toLowerCase() === predicate.field.toLowerCase())
        : undefined;
    const left = measure ? aggregateExpression(measure) : ({ kind: 'column', name: predicate.field } as SqlExpression);
    if (predicate.operator === 'in' || predicate.operator === 'not_in') {
        const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
        return { kind: 'binary', left, operator: predicate.operator === 'in' ? 'IN' : 'NOT IN', right: { kind: 'list', values: values.map(value => ({ kind: 'literal', value })) } };
    }
    if (predicate.operator === 'between' && Array.isArray(predicate.value) && predicate.value.length >= 2) {
        return {
            kind: 'binary',
            left,
            operator: 'BETWEEN',
            right: { kind: 'binary', left: { kind: 'literal', value: predicate.value[0] }, operator: 'AND', right: { kind: 'literal', value: predicate.value[1] } },
        };
    }
    if (predicate.operator === 'above_avg' || predicate.operator === 'below_avg' || predicate.operator.startsWith('this_')) return undefined;
    return {
        kind: 'binary',
        left,
        operator: predicate.operator === 'like' ? 'LIKE' : predicate.operator,
        right: { kind: 'literal', value: predicate.value },
    };
}

/**
 * Compile the safe single-table analytical subset from IR to a typed SQL AST.
 * Unsupported operators return a reason instead of silently approximating the
 * question. LLM SQL remains available for those open-ended cases.
 */
export function compileAnalyticalIRToSQL(ir: AnalyticalIR): IRSQLCompilation {
    const reasons: string[] = [];
    const operators = <K extends AnalyticalOperator['kind']>(kind: K) =>
        ir.operators.filter((operator): operator is Extract<AnalyticalOperator, { kind: K }> => operator.kind === kind);
    const unsupportedKinds = new Set(['join', 'set', 'relative_compare', 'ratio', 'compare_periods', 'window']);
    const unsupported = ir.operators.filter(operator => unsupportedKinds.has(operator.kind));
    if (unsupported.length) reasons.push(`Unsupported compositional operators: ${[...new Set(unsupported.map(operator => operator.kind))].join(', ')}`);
    if (ir.relationships.tables.length > 1) reasons.push('Multi-table SQL must follow the relationship-graph compiler or constrained LLM route.');
    if (ir.confidence.unresolved.length) reasons.push(...ir.confidence.unresolved);
    if (reasons.length) return { supported: false, reasons };

    const aggregates = operators('aggregate')[0]?.measures || [];
    const group = operators('group')[0]?.grain || [];
    const filters = operators('filter').flatMap(operator => operator.predicates);
    const rank = operators('rank')[0];
    const sort = operators('sort')[0];
    const limit = operators('limit')[0];
    const table = ir.relationships.tables[0] || 'data';
    const select: SelectItemAst[] = [];

    const physicalVisible = ir.answer.fields.filter(field => field.visibility === 'visible' && field.role !== 'calculation');
    for (const field of physicalVisible) select.push({ expression: column(field) });
    for (const measure of aggregates.filter(candidate => candidate.visibility === 'visible')) {
        select.push({ expression: aggregateExpression(measure), alias: measure.alias });
    }
    for (const field of group) {
        if (!select.some(item => item.expression.kind === 'column' && item.expression.name.toLowerCase() === field.field.toLowerCase())) {
            select.push({ expression: column(field) });
        }
    }
    if (!select.length && aggregates.length) {
        for (const measure of aggregates) select.push({ expression: aggregateExpression(measure), alias: measure.alias });
    }
    if (!select.length) return { supported: false, reasons: ['No executable SELECT projection was grounded.'] };

    const where: SqlExpression[] = [];
    const having: SqlExpression[] = [];
    for (const filter of filters) {
        const expression = predicateExpression(filter, aggregates);
        if (!expression) return { supported: false, reasons: [`Predicate ${filter.field} ${filter.operator} requires a compositional subquery compiler.`] };
        (filter.scope === 'having' ? having : where).push(expression);
    }

    const orderBy: SelectQueryAst['orderBy'] = [];
    if (rank) {
        const rankedMeasure = rank.target
            ? aggregates.find(measure => measure.field.toLowerCase() === rank.target!.field.toLowerCase())
            : aggregates[0];
        const expression = rank.mode === 'frequency'
            ? ({ kind: 'aggregate', fn: 'COUNT', argument: { kind: 'star' } } as SqlExpression)
            : rankedMeasure
                ? aggregateExpression(rankedMeasure)
                : rank.target
                    ? column(rank.target)
                    : undefined;
        if (!expression) return { supported: false, reasons: ['Ranking target is not grounded.'] };
        orderBy.push({ expression, direction: rank.direction.toUpperCase() as 'ASC' | 'DESC' });
    } else if (sort?.field) {
        orderBy.push({ expression: column(sort.field), direction: sort.direction.toUpperCase() as 'ASC' | 'DESC' });
    }

    const ast: SelectQueryAst = {
        kind: 'select',
        distinct: ir.answer.distinct,
        select,
        from: { table },
        where,
        groupBy: group.map(field => column(field)),
        having,
        orderBy,
        limit: limit?.count,
    };
    return { supported: true, ast, sql: renderSelectAst(ast), reasons: [] };
}

