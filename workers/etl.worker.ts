import { runAutomatedETL, parseCSV, parseExcelMultiSheet } from '../services/analysisEngine';
import { buildRelationalCatalog, materializeSubject, validateRelationship } from '../services/relationalCatalog';
import { normalizeRelatedTables } from '../services/relationalNormalization';

self.onmessage = async (e: MessageEvent) => {
    const { type, file, fileName, rawData, isConnector, columnTypeOverrides, sourceColumnTypeOverrides, sourceSchema, joinEdges } = e.data;
    if (type !== 'PROCESS_FILE') return;
    try {
        let data: any[] = [];
        let relatedTables: { name: string; rows: any[]; columns?: string[] }[] | undefined;
        if (rawData) {
            if (typeof rawData === 'object' && !Array.isArray(rawData)) {
                relatedTables = Object.entries(rawData).map(([name, rows]) => ({ name, rows: rows as any[] }));
            } else data = typeof rawData === 'string' ? parseCSV(rawData) : rawData;
        } else if (file?.name.match(/\.csv$/i)) {
            data = parseCSV(await file.text());
        } else if (file?.name.match(/\.xlsx?$/i)) {
            const { sheets, columns } = await parseExcelMultiSheet(file);
            const entries = Object.entries(sheets);
            if (entries.length > 1) relatedTables = entries.map(([name, rows]) => ({ name, rows, columns: columns?.[name] }));
            else data = entries[0]?.[1] || [];
        } else throw new Error('Unsupported file format');

        const rawRelatedTables = relatedTables?.map(table => ({
            name: table.name,
            rows: table.rows.map(row => ({ ...row })),
            columns: table.columns ? [...table.columns] : undefined,
        }));
        const declaredEdges = joinEdges || sourceSchema?.joinEdges;
        if (relatedTables?.length && declaredEdges?.length) {
            // Validate declared keys before normalization. Cleaning must never
            // hide duplicate lookup keys or change the evidence used here.
            for (const edge of declaredEdges) validateRelationship(relatedTables, edge);
        }
        let relationalLogs: any[] = [];
        if (relatedTables?.length) {
            const normalized = normalizeRelatedTables(relatedTables, fileName || file?.name || 'dataset', sourceColumnTypeOverrides);
            relatedTables = normalized.tables;
            relationalLogs = normalized.logs;
        }

        let catalog: ReturnType<typeof buildRelationalCatalog> | undefined;
        let subject: ReturnType<typeof materializeSubject> | undefined;
        let subjectTable: string | undefined;
        if (relatedTables?.length) {
            catalog = buildRelationalCatalog(relatedTables);
            // Database schema declarations outrank spreadsheet inference for column
            // metadata, while every source column remains represented.
            if (isConnector && sourceSchema?.tables) {
                catalog.schema.tables = catalog.schema.tables.map(table => {
                    const declared = sourceSchema.tables.find((candidate: any) => candidate.name === table.name);
                    if (!declared) return table;
                    return { ...table, columns: table.columns.map(column => {
                        const known = declared.columns.find((candidate: any) => candidate.name === column.name);
                        return known ? { ...column, dataType: known.dataType || column.dataType,
                            isPK: known.isPK ?? column.isPK, isNullable: known.isNullable ?? column.isNullable } : column;
                    }) };
                });
            }
            // Declarations remain subject to exact validation during materialization.
            if (isConnector && (joinEdges || sourceSchema?.joinEdges)) {
                catalog.schema.joinEdges = joinEdges || sourceSchema.joinEdges;
            }
            subjectTable = e.data.subjectTable || catalog.subjects.find(s => s.kind === 'fact')?.table || relatedTables[0].name;
            subject = materializeSubject(relatedTables, catalog, subjectTable);
            data = subject.rows;
        }
        const result: any = subject && catalog
            ? {
                rows: subject.rows,
                columns: subject.columns.map(column => ({
                    ...column,
                    type: columnTypeOverrides?.[column.name] || column.type,
                })),
                logs: [
                { step: 'Relational subject', details: `Selected ${subjectTable}. ${catalog.subjects.length} source tables remain available in the subject selector.`, status: 'info', timestamp: Date.now() },
                ...relationalLogs,
                ],
                timeContext: subject.timeContext,
                dimDate: undefined,
              }
            : runAutomatedETL(data, fileName || file?.name || 'dataset', columnTypeOverrides);
        if (subject && catalog) {
            Object.assign(result, { relationalCatalog: catalog, subjectTable, fieldLineage: subject.lineage, fieldOrigins: subject.origins, sourceSchema: catalog.schema, relatedTables, timeContext: subject.timeContext, dimDate: undefined });
        } else if (sourceSchema) Object.assign(result, { sourceSchema });
        Object.assign(result, { rawRows: data, rawRelatedTables });
        self.postMessage({ type: 'SUCCESS', result });
    } catch (error: any) {
        self.postMessage({ type: 'ERROR', error: error.message || 'Unknown worker error' });
    }
};
