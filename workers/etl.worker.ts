import { runAutomatedETL, parseCSV, parseExcel, parseExcelMultiSheet, autoJoinDatasets, buildJoinStrategy } from '../services/analysisEngine';
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
                        // Multiple sheets detected → treat each as a table
                        // Build column info from actual data for join detection
                        const tableColumns: Record<string, ColumnInfo[]> = {};
                        const sourceTables: any[] = [];

                        for (const name of sheetNames) {
                            const rows = sheets[name];
                            if (rows.length === 0) continue;

                            const cols = Object.keys(rows[0]);
                            const colInfos: ColumnInfo[] = cols.map(c => {
                                // Infer data type from first non-null value
                                const sampleVal = rows.find(r => r[c] !== null && r[c] !== undefined && r[c] !== '')?.[c];
                                let dataType = 'varchar';
                                if (typeof sampleVal === 'number') dataType = 'numeric';
                                else if (sampleVal instanceof Date) dataType = 'datetime';
                                else if (typeof sampleVal === 'string') {
                                    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(sampleVal)) dataType = 'datetime';
                                    else if (!isNaN(Number(sampleVal)) && sampleVal.trim() !== '') dataType = 'numeric';
                                }

                                const isId = c.toLowerCase().endsWith('id') || c.toLowerCase().endsWith('_id') || c.toLowerCase() === 'id';
                                return {
                                    name: c,
                                    dataType,
                                    isNullable: rows.some(r => r[c] === null || r[c] === undefined || r[c] === ''),
                                    isPK: isId && cols.indexOf(c) === 0,
                                    maxLength: 0
                                };
                            });

                            tableColumns[name] = colInfos;
                            sourceTables.push({
                                name,
                                rows: rows.length,
                                columns: colInfos.map(c => ({
                                    name: c.name,
                                    dataType: c.dataType,
                                    isPK: c.isPK,
                                    isNullable: c.isNullable
                                }))
                            });
                        }

                        // Build join strategy (no FK metadata for Excel, only name matching)
                        const detectedEdges = buildJoinStrategy(sheetNames, tableColumns, []);

                        // Auto-join all sheets into master table
                        const { mergedRows, joinLogs } = autoJoinDatasets(sheets, detectedEdges);

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
