import { runAutomatedETL, parseCSV, parseExcelMultiSheet } from '../services/analysisEngine';
import { buildRelationalCatalog, materializeSubject } from '../services/relationalCatalog';

self.onmessage = async (e: MessageEvent) => {
    const { type, file, fileName, rawData, isConnector, columnTypeOverrides, sourceSchema, joinEdges } = e.data;
    if (type !== 'PROCESS_FILE') return;
    try {
        let data: any[] = [];
        let relatedTables: { name: string; rows: any[]; columns?: string[] }[] | undefined;
        if (rawData) {
            if (isConnector && typeof rawData === 'object' && !Array.isArray(rawData)) {
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
        const result = runAutomatedETL(data, fileName || file?.name || 'dataset', columnTypeOverrides);
        if (subject && catalog) {
            // Preserve source multiplicity and field identity through legacy ETL.
            result.rows = subject.rows;
            result.columns = subject.columns.map(c => ({ ...c, type: columnTypeOverrides?.[c.name] || c.type }));
            result.logs = [{ step: 'Relational subject', details: `Selected ${subjectTable}. ${catalog.subjects.length} source tables remain available in the subject selector.`, status: 'info', timestamp: Date.now() }];
            Object.assign(result, { relationalCatalog: catalog, subjectTable, fieldLineage: subject.lineage, fieldOrigins: subject.origins, sourceSchema: catalog.schema, relatedTables, timeContext: subject.timeContext, dimDate: undefined });
        } else if (sourceSchema) Object.assign(result, { sourceSchema });
        Object.assign(result, { rawRows: data });
        self.postMessage({ type: 'SUCCESS', result });
    } catch (error: any) {
        self.postMessage({ type: 'ERROR', error: error.message || 'Unknown worker error' });
    }
};
