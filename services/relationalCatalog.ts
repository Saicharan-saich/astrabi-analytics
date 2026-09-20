import { ColumnType, type Dataset, type RelatedTable, type SourceSchema, type SourceJoinEdge, type TimeContext } from '../types';
import { discoverRelationships, detectCandidateKeys } from './ai-sql/relationshipDiscovery';

export interface SubjectArea { id: string; table: string; kind: 'fact' | 'dimension' | 'standalone' | 'metadata' }
export interface RelationalCatalog {
    version: 1;
    subjects: SubjectArea[];
    schema: SourceSchema;
    rejected: ReturnType<typeof discoverRelationships>['rejected'];
}
const id = (...parts: string[]) => parts.map(encodeURIComponent).join('/');
const key = (v: unknown) => String(v).trim();
const blank = (v: unknown) => v == null || key(v) === '';
const tuple = (row: Record<string, any>, columns: string[]) => JSON.stringify(columns.map(c => key(row[c])));
export const sourceColumns = (table: RelatedTable) => [...new Set([...(table.columns || []), ...table.rows.flatMap(Object.keys)])];

export function validateRelationship(tables: RelatedTable[], edge: SourceJoinEdge) {
    const source = tables.find(t => t.name === edge.leftTable);
    const target = tables.find(t => t.name === edge.rightTable);
    const from = edge.leftColumns || [edge.leftColumn];
    const to = edge.rightColumns || [edge.rightColumn];
    if (!source || !target || from.length !== to.length || !from.length) throw new Error('Select matching source and target columns.');
    if (new Set(from).size !== from.length || new Set(to).size !== to.length) throw new Error('Each key column must be selected once.');
    if (source.name === target.name) throw new Error('Self relationships require an explicit hierarchy and are not supported in subject views yet.');
    for (const [table, cols] of [[source, from], [target, to]] as const) {
        if (cols.some(c => !sourceColumns(table).includes(c))) throw new Error(`Column not found in ${table.name}.`);
    }
    const keys = new Set<string>();
    for (const row of target.rows) {
        if (to.some(c => blank(row[c]))) throw new Error(`Blank lookup key: ${target.name}.${to.join(' + ')}`);
        const value = tuple(row, to);
        if (keys.has(value)) throw new Error(`Duplicate lookup key: ${target.name}.${to.join(' + ')}`);
        keys.add(value);
    }
    let unmatched = 0;
    for (const row of source.rows) {
        if (from.some(c => blank(row[c]))) continue;
        if (!keys.has(tuple(row, from))) unmatched++;
    }
    return { unmatched };
}

export function buildRelationalCatalog(tables: RelatedTable[]): RelationalCatalog {
    const discovery = discoverRelationships(tables);
    const subjects = tables.map(t => {
        const columns = sourceColumns(t);
        const kind: SubjectArea['kind'] = columns.includes('from_table') && columns.includes('to_table') ? 'metadata'
            : /^fact[_ ]/i.test(t.name) || columns.some(c => /^(value|amount|revenue|sales|quantity|price)(_|$)/i.test(c)) ? 'fact'
            : discovery.relationships.some(r => r.toTable === t.name) ? 'dimension' : 'standalone';
        return { id: id(t.name), table: t.name, kind };
    });
    const schema: SourceSchema = {
        tables: tables.map(t => {
            const keys = detectCandidateKeys(t).filter(k => k.isKey && !discovery.relationships.some(r => r.fromTable === t.name && r.fromColumn === k.column));
            const stem = t.name.replace(/^(fact|dim)[_ ]/i, '').replace(/s$/i, '').toLowerCase();
            const primary = keys.find(k => k.column.toLowerCase() === `${stem}_id`)
                || keys.find(k => /^id$/i.test(k.column))
                || keys.find(k => /(^|_)id$/i.test(k.column)) || keys[0];
            return { name: t.name, rows: t.rows.length, columns: sourceColumns(t).map(name => {
                const definition = t.columnDefinitions?.find(column => column.name === name);
                const value = t.rows.find(r => !blank(r[name]))?.[name];
                const normalized = definition?.conversion?.normalizedType || definition?.physicalType;
                const dataType = normalized === 'number' ? 'numeric'
                    : normalized === 'date' ? 'date'
                        : normalized === 'boolean' ? 'boolean'
                            : typeof value === 'number' ? 'numeric' : 'varchar';
                return {
                    name,
                    dataType,
                    isPK: primary?.column === name,
                    isNullable: t.rows.some(r => blank(r[name])),
                    sourceDataType: definition?.conversion?.sourceType,
                    normalizedDataType: definition?.conversion?.normalizedType || definition?.physicalType,
                    analyticalRole: definition?.type,
                    parseSuccessRate: definition?.conversion?.parseSuccessRate,
                    invalidCount: definition?.conversion?.invalidCount,
                    convertedCount: definition?.conversion?.convertedCount,
                };
            }) };
        }),
        joinEdges: discovery.relationships.map(r => ({ leftTable: r.fromTable, leftColumn: r.fromColumn, rightTable: r.toTable, rightColumn: r.toColumn, type: 'fk' as const, provenance: 'inferred', cardinality: r.cardinality, confidence: r.confidence, evidence: r.evidence })),
        joinLogs: discovery.rejected.map(r => `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}: ${r.reason}`),
    };
    return { version: 1, subjects, schema, rejected: discovery.rejected };
}

/** Materialize only directed, exact many-to-one lookups. Never cross into another fact. */
export function materializeSubject(tables: RelatedTable[], catalog: RelationalCatalog, table: string, standalone = false) {
    const base = tables.find(t => t.name === table);
    if (!base) throw new Error(`Source table ${table} is unavailable`);
    const columns = sourceColumns(base);
    let rows = base.rows.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null])));
    const lineage: Record<string, string> = Object.fromEntries(columns.map(c => [c, id(table, c)]));
    const origins: NonNullable<Dataset['fieldOrigins']> = Object.fromEntries(columns.map(c => [c, { table, column: c }]));
    const visit = (source: string, sourceFields: Record<string, string>, path: string[], ancestors: string[]) => {
        if (standalone) return;
        for (const edge of catalog.schema.joinEdges.filter(e => e.leftTable === source)) {
            if (ancestors.includes(edge.rightTable)) continue;
            const targetKind = catalog.subjects.find(s => s.table === edge.rightTable)?.kind;
            if (targetKind === 'fact' || targetKind === 'metadata') continue;
            const target = tables.find(t => t.name === edge.rightTable);
            if (!target) continue;
            validateRelationship(tables, edge);
            const from = edge.leftColumns || [edge.leftColumn];
            const to = edge.rightColumns || [edge.rightColumn];
            const lookup = new Map<string, Record<string, any>>();
            for (const record of target.rows) {
                const value = tuple(record, to);
                if (lookup.has(value)) throw new Error(`Duplicate lookup key: ${edge.rightTable}.${edge.rightColumn}`);
                lookup.set(value, record);
            }
            const role = [...path, `${from.join(' + ')} → ${edge.rightTable}`];
            const mapping: Record<string, string> = {};
            for (const c of sourceColumns(target)) {
                const alias = `${role.join(' / ')}.${c}`;
                if (lineage[alias]) throw new Error(`Ambiguous field alias ${alias}`);
                mapping[c] = alias;
                lineage[alias] = id(table, ...role, c);
                origins[alias] = { table: target.name, column: c };
                columns.push(alias);
            }
            rows = rows.map(r => {
                const columns = from.map(c => sourceFields[c]);
                const match = columns.some(c => blank(r[c])) ? undefined : lookup.get(tuple(r, columns));
                return { ...r, ...Object.fromEntries(Object.entries(mapping).map(([c, alias]) => [alias, match?.[c] ?? null])) };
            });
            visit(edge.rightTable, mapping, role, [...ancestors, edge.rightTable]);
        }
    };
    visit(table, Object.fromEntries(columns.map(c => [c, c])), [], [table]);
    rows = rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value instanceof Date ? value.toISOString() : value])));
    const typedColumns = columns.map(name => {
        const origin = origins[name];
        const sourceDefinition = tables.find(source => source.name === origin?.table)
            ?.columnDefinitions?.find(column => column.name === origin?.column);
        if (sourceDefinition) return { ...sourceDefinition, name };
        const values = rows.map(r => r[name]).filter(v => !blank(v));
        const leaf = name.split('.').pop()!;
        const type = /(^|_)id$/i.test(leaf) ? ColumnType.ID
            : /date/i.test(leaf) && values.length > 0 && values.every(v => v instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(v))) ? ColumnType.DATE
            : values.length > 0 && values.every(v => typeof v === 'number') && !/(rank|percent|share)/i.test(leaf) ? ColumnType.METRIC : ColumnType.DIMENSION;
        return { name, type, originalType: typeof values[0] };
    });
    const dateColumns = typedColumns.filter(c => c.type === ColumnType.DATE);
    const dateColumnMaxDates: Record<string, string> = {};
    const ranges = new Map<string, { min: string; max: string }>();
    for (const c of dateColumns) {
        const values = rows.map(r => r[c.name]).filter(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)).map(v => v.slice(0, 10)).sort();
        if (values.length) { ranges.set(c.name, { min: values[0], max: values[values.length - 1] }); dateColumnMaxDates[c.name] = values[values.length - 1]; }
    }
    const anchor = dateColumns.find(c => !c.name.includes(' → ') && ranges.has(c.name))
        || dateColumns.find(c => /period/i.test(c.name) && /end_date$/i.test(c.name) && ranges.has(c.name))
        || dateColumns.find(c => !/accessed|updated|created/i.test(c.name) && ranges.has(c.name));
    const timeContext: TimeContext | undefined = anchor ? {
        minDate: ranges.get(anchor.name)!.min, maxDate: ranges.get(anchor.name)!.max,
        defaultAnchorDate: ranges.get(anchor.name)!.max, anchorDateColumn: anchor.name,
        dateColumnMaxDates,
    } : undefined;
    return { rows, lineage, origins, columns: typedColumns, timeContext };
}

export function createSubjectDataset(parent: Dataset, table: string, standalone = false): Dataset {
    const tables = parent.sourceTables || parent.relatedTables || [];
    const catalog = parent.relationalCatalog || buildRelationalCatalog(tables);
    const view = materializeSubject(tables, catalog, table, standalone);
    const root = parent.sourceDatasetId || parent.id;
    return {
        id: `${root}/subject/${id(table, standalone ? 'source' : 'analysis')}/v${parent.version || 1}`,
        sourceDatasetId: root, subjectTable: table, standaloneSubject: standalone,
        name: `${table}${standalone ? ' (source)' : ''}`, rows: view.rows, rawRows: tables.find(t => t.name === table)?.rows,
        columns: view.columns, fieldLineage: view.lineage, fieldOrigins: view.origins, totalRows: view.rows.length, timeContext: view.timeContext,
        etlLogs: [], sourceSchema: catalog.schema, sourceTables: tables, rawSourceTables: parent.rawSourceTables, relationalCatalog: catalog,
        version: parent.version || 1, createdAt: parent.createdAt,
        connectionMode: parent.connectionMode || 'import', liveConnection: parent.liveConnection,
    };
}
