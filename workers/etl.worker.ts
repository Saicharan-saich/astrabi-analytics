import { runAutomatedETL, parseCSV, parseExcel, parseExcelMultiSheet, autoJoinDatasets } from '../services/analysisEngine';
import { discoverRelationships, detectCandidateKeys } from '../services/ai-sql/relationshipDiscovery';
import type { ColumnInfo, JoinEdge } from '../services/analysisEngine';

// We need to define the listener
self.onmessage = async (e: MessageEvent) => {
    const { type, file, fileName, rawData, isConnector, columnTypeOverrides, joinEdges, sourceSchema } = e.data;

    try {
        if (type === 'PROCESS_FILE') {
            let data: any[] = [];
            let builtSourceSchema: any = null;

            // If rawData is already provided (e.g. from Connector or Sample), use it
            if (rawData) {
                data = typeof rawData === 'string' ? parseCSV(rawData) : rawData;
            }
            // Otherwise parse the File object
            else if (file) {
                if (file.name.endsWith('.csv')) {
                    const text = await file.text();
                    data = parseCSV(text);
                } else if (file.name.match(/\.xlsx?$/)) {
                    // ─── Multi-Sheet Excel Detection ───────────────
                    const { sheetCount, sheets } = await parseExcelMultiSheet(file);
                    const sheetNames = Object.keys(sheets);

                    if (sheetNames.length > 1) {
                        // Multiple sheets → each is a table. Keys and relationships
                        // are inferred from the VALUES, not from column names: a
                        // workbook carries no foreign keys, and "both sheets have
                        // an id column" is not evidence of a relationship.
                        const discoveryTables = sheetNames
                            .filter(n => (sheets[n] || []).length > 0)
                            .map(n => ({ name: n, rows: sheets[n] }));

                        const { relationships, rejected } = discoverRelationships(discoveryTables);

                        const sourceTables: any[] = [];
                        for (const { name, rows } of discoveryTables) {
                            const keyInfo = new Map(detectCandidateKeys({ name, rows }).map(k => [k.column, k]));
                            const cols = Object.keys(rows[0]);
                            sourceTables.push({
                                name,
                                rows: rows.length,
                                columns: cols.map(c => {
                                    const sampleVal = rows.find(r => r[c] !== null && r[c] !== undefined && r[c] !== '')?.[c];
                                    let dataType = 'varchar';
                                    if (typeof sampleVal === 'number') dataType = 'numeric';
                                    else if (sampleVal instanceof Date) dataType = 'datetime';
                                    else if (typeof sampleVal === 'string') {
                                        if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(sampleVal)) dataType = 'datetime';
                                        else if (!isNaN(Number(sampleVal)) && sampleVal.trim() !== '') dataType = 'numeric';
                                    }
                                    return {
                                        name: c,
                                        dataType,
                                        // A real key: unique and non-null in the data.
                                        isPK: !!keyInfo.get(c)?.isKey,
                                        isNullable: (keyInfo.get(c)?.nullCount || 0) > 0,
                                    };
                                }),
                            });
                        }

                        // Only evidence-backed relationships become join edges.
                        const detectedEdges = relationships.map(r => ({
                            leftTable: r.fromTable,
                            leftColumn: r.fromColumn,
                            rightTable: r.toTable,
                            rightColumn: r.toColumn,
                            type: 'fk' as const,
                        }));

                        const { mergedRows, joinLogs } = autoJoinDatasets(sheets, detectedEdges as any);

                        // Record what was joined and — just as important — what was
                        // deliberately not, so a surprising result is explainable.
                        for (const r of relationships) {
                            joinLogs.push(`JOIN ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} (${Math.round(r.coverage * 100)}% of values matched, ${r.cardinality}, confidence ${(r.confidence * 100).toFixed(0)}%)`);
                        }
                        for (const r of rejected.slice(0, 10)) {
                            joinLogs.push(`NOT JOINED ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} — ${r.reason}`);
                        }
                        if (relationships.length === 0) {
                            joinLogs.push('No reliable relationships found between sheets — they were stacked rather than joined, to avoid inventing a link.');
                        }

                        data = mergedRows;

                        builtSourceSchema = {
                            tables: sourceTables,
                            joinEdges: detectedEdges.map(e => ({
                                leftTable: e.leftTable,
                                rightTable: e.rightTable,
                                leftColumn: e.leftColumn,
                                rightColumn: e.rightColumn,
                                type: e.type
                            })),
                            joinLogs
                        };
                    } else {
                        // Single sheet → normal behavior
                        data = sheets[sheetNames[0]] || [];
                    }
                } else {
                    throw new Error("Unsupported file format");
                }
            }

            // Handle Connector Auto-Join Logic inside worker if needed
            let rowsToProcess = data;
            let extraLogs: any[] = [];

            if (isConnector && !Array.isArray(data)) {
                const { mergedRows, joinLogs: jl } = autoJoinDatasets(data, joinEdges);
                rowsToProcess = mergedRows;
                extraLogs = jl.map(log => ({
                    step: 'Auto-Join Strategy',
                    details: log,
                    status: 'info',
                    timestamp: Date.now()
                }));
            } else if (isConnector && Array.isArray(data)) {
                rowsToProcess = data;
            }

            // Run Main ETL
            const result = runAutomatedETL(rowsToProcess, fileName || file?.name || 'dataset', columnTypeOverrides);

            // If we had extra logs from join, prepend them
            if (extraLogs.length > 0) {
                result.logs = [...extraLogs, ...result.logs];
            }

            // Attach sourceSchema if we built one (multi-sheet Excel or connector)
            if (builtSourceSchema) {
                (result as any).sourceSchema = builtSourceSchema;
            }
            // Also carry through any sourceSchema passed from the connector
            if (sourceSchema) {
                (result as any).sourceSchema = sourceSchema;
            }

            // Attach raw (pre-ETL) rows for Raw vs Clean comparison
            (result as any).rawRows = rowsToProcess;

            self.postMessage({ type: 'SUCCESS', result });
        }
    } catch (error: any) {
        self.postMessage({ type: 'ERROR', error: error.message || "Unknown Worker Error" });
    }
};
