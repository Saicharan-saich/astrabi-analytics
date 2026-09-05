import type { DynamicQuerySpec } from './directSqlEngine';
import type { TraceStory, TraceStoryStep } from './types';

interface TraceStoryInput {
    sql: string;
    querySpec?: DynamicQuerySpec;
    sourceTables: Array<{ name: string; rowCount: number }>;
    resultRows: number;
    resultColumns: string[];
    chart?: { chartType?: string; xKey?: string; yKey?: string; secondaryYKeys?: string[] };
}

const cleanIdentifier = (value: string) => value.replace(/^["`]|["`]$/g, '');
const human = (value: string) => cleanIdentifier(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
const unique = (values: string[]) => values.filter((value, index, all) =>
    all.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index
);

function containsIdentifier(sql: string, field: string): boolean {
    const escaped = cleanIdentifier(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:["\`]${escaped}["\`]|\\b${escaped}\\b)`, 'i').test(sql);
}

function sourceTableNames(sql: string): string[] {
    const ctes = new Set<string>();
    const ctePattern = /(?:\bWITH|,)\s*(["`]?[A-Za-z_][A-Za-z0-9_$]*["`]?)\s+AS\s*\(/gi;
    for (const match of sql.matchAll(ctePattern)) ctes.add(cleanIdentifier(match[1]).toLowerCase());

    const names: string[] = [];
    const tablePattern = /\b(?:FROM|JOIN)\s+(["`]?[A-Za-z_][A-Za-z0-9_.$]*["`]?)/gi;
    for (const match of sql.matchAll(tablePattern)) {
        const name = cleanIdentifier(match[1]).split('.').pop() || cleanIdentifier(match[1]);
        if (!ctes.has(name.toLowerCase())) names.push(name);
    }
    return unique(names);
}

function verifiedSpecFields(
    clauseSql: string,
    values: unknown,
    selector: (item: Record<string, unknown>) => unknown,
): string[] {
    if (!Array.isArray(values)) return [];
    return unique(values.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const selected = selector(item as Record<string, unknown>);
        return typeof selected === 'string' && selected.trim() && containsIdentifier(clauseSql, selected)
            ? [cleanIdentifier(selected.trim()).split('.').pop() || selected.trim()]
            : [];
    }));
}

function clauseSegments(sql: string, clause: 'WHERE' | 'GROUP BY'): string {
    const lead = clause === 'WHERE' ? 'WHERE' : 'GROUP\\s+BY';
    const pattern = new RegExp(
        `\\b${lead}\\b([\\s\\S]*?)(?=\\bWHERE\\b|\\bGROUP\\s+BY\\b|\\bHAVING\\b|\\bORDER\\s+BY\\b|\\bLIMIT\\b|\\bQUALIFY\\b|\\bUNION\\b|\\bINTERSECT\\b|\\bEXCEPT\\b|$)`,
        'gi',
    );
    return [...sql.matchAll(pattern)].map(match => match[1]).join(' ');
}

function aggregateExpressions(sql: string): string[] {
    const expressions: string[] = [];
    const pattern = /\b(SUM|AVG|COUNT|MIN|MAX|MEDIAN)\s*\(\s*(DISTINCT\s+)?(["`]?[A-Za-z_][A-Za-z0-9_.$]*["`]?|\*)\s*\)/gi;
    for (const match of sql.matchAll(pattern)) {
        const distinct = match[2] ? 'DISTINCT ' : '';
        expressions.push(`${match[1].toUpperCase()}(${distinct}${cleanIdentifier(match[3])})`);
    }
    return unique(expressions);
}

function windowFunctions(sql: string): string[] {
    if (!/\bOVER\s*\(/i.test(sql)) return [];
    return unique([
        ['ROW_NUMBER', /\bROW_NUMBER\s*\(/i],
        ['RANK', /\bRANK\s*\(/i],
        ['DENSE_RANK', /\bDENSE_RANK\s*\(/i],
        ['LAG', /\bLAG\s*\(/i],
        ['LEAD', /\bLEAD\s*\(/i],
        ['running/windowed SUM', /\bSUM\s*\([^)]*\)\s*OVER\s*\(/i],
        ['windowed AVG', /\bAVG\s*\([^)]*\)\s*OVER\s*\(/i],
        ['windowed COUNT', /\bCOUNT\s*\([^)]*\)\s*OVER\s*\(/i],
    ].filter(([, pattern]) => (pattern as RegExp).test(sql)).map(([name]) => name as string));
}

export function buildTraceStory(input: TraceStoryInput): TraceStory {
    const sql = (input.sql || '').replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').trim();
    const steps: TraceStoryStep[] = [];
    const physicalTables = sourceTableNames(sql);
    const tableStats = new Map(input.sourceTables.map(table => [table.name.toLowerCase(), table.rowCount]));
    const sourceDescriptions = physicalTables.map(table => {
        const rows = tableStats.get(table.toLowerCase()) ?? (table.toLowerCase() === 'data' ? tableStats.get('data') : undefined);
        return typeof rows === 'number' ? `${human(table)} (${rows.toLocaleString()} rows)` : human(table);
    });
    steps.push({
        kind: 'source',
        title: 'Started with the local source data',
        description: sourceDescriptions.length
            ? `Read ${sourceDescriptions.join(', ')} in local DuckDB.`
            : 'Read the locally loaded dataset in DuckDB.',
        evidence: physicalTables.length ? `FROM/JOIN: ${physicalTables.join(', ')}` : 'Executed SQL source',
    });

    const joinCount = [...sql.matchAll(/\b(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\b/gi)].length;
    if (joinCount > 0) {
        steps.push({
            kind: 'relationship',
            title: 'Connected related tables',
            description: `Applied ${joinCount} join${joinCount === 1 ? '' : 's'} using the relationship conditions in the executed query.`,
            evidence: `${joinCount} JOIN operator${joinCount === 1 ? '' : 's'}`,
        });
    }

    const whereSql = clauseSegments(sql, 'WHERE');
    const filterFields = verifiedSpecFields(whereSql, input.querySpec?.operations?.filters, item => item.field);
    const whereCount = [...sql.matchAll(/\bWHERE\b/gi)].length;
    if (whereCount > 0) {
        steps.push({
            kind: 'filter',
            title: 'Filtered the relevant rows',
            description: filterFields.length
                ? `Applied row conditions using ${filterFields.map(human).join(', ')} before producing the answer.`
                : `Applied ${whereCount} row-filter stage${whereCount === 1 ? '' : 's'} defined in the executed SQL.`,
            evidence: filterFields.length ? `WHERE fields: ${filterFields.join(', ')}` : `${whereCount} WHERE clause${whereCount === 1 ? '' : 's'}`,
        });
    }

    const groupSql = clauseSegments(sql, 'GROUP BY');
    const groupFields = verifiedSpecFields(groupSql, input.querySpec?.operations?.groupBy, item => item.field);
    const hasGrouping = /\bGROUP\s+BY\b/i.test(sql);
    const aggregates = aggregateExpressions(sql);
    if (hasGrouping) {
        steps.push({
            kind: 'group',
            title: 'Created the requested groups',
            description: groupFields.length
                ? `Grouped the working rows by ${groupFields.map(human).join(', ')}.`
                : 'Grouped the working rows at the grain defined by the executed SQL.',
            evidence: groupFields.length ? `GROUP BY: ${groupFields.join(', ')}` : 'GROUP BY present',
        });
    }
    if (aggregates.length > 0) {
        steps.push({
            kind: 'calculate',
            title: 'Calculated the measures',
            description: `${aggregates.map(expression => expression.replace(/_/g, ' ')).join(', ')}${hasGrouping ? ' for the groups' : ''}.`,
            evidence: aggregates.join(', '),
        });
    }

    if (/\bHAVING\b/i.test(sql)) {
        steps.push({
            kind: 'qualify',
            title: 'Kept only qualifying groups',
            description: 'Applied the aggregate condition in HAVING after group calculations were complete.',
            evidence: 'HAVING present',
        });
    }

    const windows = windowFunctions(sql);
    if (windows.length > 0) {
        steps.push({
            kind: 'calculate',
            title: 'Applied table calculations',
            description: `Calculated ${windows.join(', ')} over the prepared result rows.`,
            evidence: `Window functions: ${windows.join(', ')}`,
        });
    }

    const setOperators = unique([...sql.matchAll(/\b(UNION(?:\s+ALL)?|INTERSECT|EXCEPT)\b/gi)].map(match => match[1].toUpperCase()));
    if (setOperators.length > 0) {
        steps.push({
            kind: 'set',
            title: 'Combined analytical result sets',
            description: `Applied ${setOperators.join(', ')} to the independently calculated result sets.`,
            evidence: setOperators.join(', '),
        });
    }

    const limitMatch = sql.match(/\bLIMIT\s+(\d+)\b/i);
    const nonWindowSql = sql.replace(/\bOVER\s*\([^)]*\)/gi, ' ');
    const hasOrderedStage = /\bORDER\s+BY\b/i.test(nonWindowSql);
    if (hasOrderedStage || limitMatch) {
        const limit = limitMatch ? Number(limitMatch[1]) : undefined;
        steps.push({
            kind: 'rank',
            title: limit ? `Limited an ordered stage to ${limit} rows` : 'Ordered a query stage',
            description: limit
                ? `${hasOrderedStage ? 'Ordered the calculated rows and a' : 'A'}pplied LIMIT ${limit} at that SQL stage.`
                : 'Applied an ORDER BY definition in the executed SQL.',
            evidence: `${hasOrderedStage ? 'ORDER BY' : ''}${limit ? `${hasOrderedStage ? ' + ' : ''}LIMIT ${limit}` : ''}`,
        });
    }

    const visibleMetrics = unique([
        input.chart?.yKey || '',
        ...(input.chart?.secondaryYKeys || []),
    ].filter(Boolean));
    const visual = input.chart?.chartType
        ? ` The result was mapped to a ${human(input.chart.chartType)} visual${input.chart.xKey ? ` by ${human(input.chart.xKey)}` : ''}${visibleMetrics.length ? ` using ${visibleMetrics.map(human).join(', ')}` : ''}.`
        : '';
    steps.push({
        kind: 'result',
        title: 'Produced the final insight',
        description: `DuckDB returned ${input.resultRows.toLocaleString()} result row${input.resultRows === 1 ? '' : 's'}${input.resultColumns.length ? ` with ${input.resultColumns.map(human).join(', ')}` : ''}.${visual}`,
        evidence: `${input.resultRows} row${input.resultRows === 1 ? '' : 's'}; columns: ${input.resultColumns.join(', ') || 'none'}`,
    });

    return { version: 1, verifiedFrom: 'executed_sql_and_result', steps };
}
