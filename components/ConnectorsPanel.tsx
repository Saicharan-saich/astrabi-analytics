import React, { useState, useMemo } from 'react';
import {
    Database, ShoppingBag, Server, Loader2, X, AlertCircle, Shield, ShieldCheck,
    ChevronDown, ChevronRight, Key, Hash, Type, Calendar, CheckCircle2,
    GitMerge, ArrowRight, Table2, Columns3, Link2, Eye, Zap, Download, Radio
} from 'lucide-react';
import { Connector, Dataset, ConnectionMode, LiveConnectionInfo } from '../types';
import {
    getMockConnectorData, getMockDatabaseSchema, connectToDatabase,
    fetchTableColumns, fetchForeignKeys, buildJoinStrategy, autoJoinDatasets,
    TableInfo, ColumnInfo, ForeignKeyInfo, JoinEdge
} from '../services/analysisEngine';

interface ConnectorsPanelProps {
    onDataReady: (dataset: any, name: string, sourceSchema?: any, liveInfo?: LiveConnectionInfo) => void;
}

const AVAILABLE_CONNECTORS: Connector[] = [
    { id: 'shopify', name: 'Shopify', icon: 'shopping', status: 'disconnected' },
    { id: 'woocommerce', name: 'WooCommerce', icon: 'shopping', status: 'disconnected' },
    { id: 'postgres', name: 'PostgreSQL', icon: 'db', status: 'disconnected' },
    { id: 'mysql', name: 'MySQL', icon: 'db', status: 'disconnected' },
    { id: 'mssql', name: 'SQL Server', icon: 'db', status: 'disconnected' },
];

type ModalStep = 'credentials' | 'tables' | 'schema';

export const ConnectorsPanel: React.FC<ConnectorsPanelProps> = ({ onDataReady }) => {
    const [selectedConnectorId, setSelectedConnectorId] = useState<string>(AVAILABLE_CONNECTORS[0].id);
    const [configuringId, setConfiguringId] = useState<string | null>(null);
    const [step, setStep] = useState<ModalStep>('credentials');
    const [isLoading, setIsLoading] = useState(false);
    const [useWindowsAuth, setUseWindowsAuth] = useState(false);
    const [connectionId, setConnectionId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Table & Schema State
    const [availableTables, setAvailableTables] = useState<TableInfo[]>([]);
    const [selectedTables, setSelectedTables] = useState<string[]>([]);
    const [expandedTable, setExpandedTable] = useState<string | null>(null);
    const [tableColumns, setTableColumns] = useState<Record<string, ColumnInfo[]>>({});
    const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
    const [joinEdges, setJoinEdges] = useState<JoinEdge[]>([]);
    const [loadingColumns, setLoadingColumns] = useState<string | null>(null);
    const [connectionMode, setConnectionMode] = useState<ConnectionMode>('import');
    const [connConfig, setConnConfig] = useState<{ host: string; port: string; database: string; username: string; ssl: boolean; password?: string } | null>(null);

    const handleConnect = () => {
        setConfiguringId(selectedConnectorId);
        setStep('credentials');
        setUseWindowsAuth(false);
        setAvailableTables([]);
        setSelectedTables([]);
        setTableColumns({});
        setForeignKeys([]);
        setJoinEdges([]);
        setError(null);
    };

    const handleCredentialsSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);

        const active = AVAILABLE_CONNECTORS.find(c => c.id === configuringId);

        // Simple connectors (Shopify, etc.) → skip schema browser
        if (active?.icon === 'shopping') {
            setTimeout(async () => {
                const rows = await getMockConnectorData();
                const name = `${active.name} Data`;
                setIsLoading(false);
                setConfiguringId(null);
                onDataReady(rows, name);
            }, 1500);
            return;
        }

        // RDBMS — connect to database
        const formData = new FormData(e.target as HTMLFormElement);
        const isPostgres = configuringId === 'postgres';
        const config = {
            host: formData.get('host') as string,
            port: formData.get('port') as string || (isPostgres ? '5432' : '1433'),
            database: formData.get('database') as string,
            username: formData.get('username') as string,
            password: formData.get('password') as string,
            useWindowsAuth: isPostgres ? false : useWindowsAuth,
            dbType: (isPostgres ? 'postgres' : 'mssql') as 'mssql' | 'postgres',
            ssl: formData.get('ssl') === 'on',
        };

        const result = await connectToDatabase(config);

        if (!result.success) {
            setError(result.error || 'Connection failed');
            setIsLoading(false);
            return;
        }

        setConnectionId(result.connectionId!);
        // Store config (including password for session caching) for reconnection
        setConnConfig({ host: config.host, port: config.port, database: config.database, username: config.username, ssl: config.ssl, password: config.password });

        // Fetch tables + FK relationships in parallel
        const [tables, fks] = await Promise.all([
            getMockDatabaseSchema(result.connectionId!),
            fetchForeignKeys(result.connectionId!)
        ]);

        setAvailableTables(tables);
        setForeignKeys(fks);
        setStep('tables');
        setIsLoading(false);
    };

    // Load columns when a table is expanded
    const handleExpandTable = async (tableName: string) => {
        if (expandedTable === tableName) {
            setExpandedTable(null);
            return;
        }
        setExpandedTable(tableName);

        if (!tableColumns[tableName] && connectionId) {
            setLoadingColumns(tableName);
            const cols = await fetchTableColumns(connectionId, tableName);
            setTableColumns(prev => ({ ...prev, [tableName]: cols }));
            setLoadingColumns(null);
        }
    };

    const toggleTable = (name: string) => {
        setSelectedTables(prev =>
            prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
        );
    };

    const toggleAll = () => {
        if (selectedTables.length === availableTables.length) setSelectedTables([]);
        else setSelectedTables(availableTables.map(t => t.name));
    };

    // Proceed to schema view — auto-fetch columns for all selected tables + build join strategy
    const handleProceedToSchema = async () => {
        if (selectedTables.length === 0 || !connectionId) return;
        setIsLoading(true);

        // Fetch columns for any tables we haven't loaded yet
        const needed = selectedTables.filter(t => !tableColumns[t]);
        const newCols: Record<string, ColumnInfo[]> = { ...tableColumns };

        await Promise.all(needed.map(async (t) => {
            const cols = await fetchTableColumns(connectionId, t);
            newCols[t] = cols;
        }));

        setTableColumns(newCols);

        // Build join strategy
        const edges = buildJoinStrategy(selectedTables, newCols, foreignKeys);
        setJoinEdges(edges);

        setStep('schema');
        setIsLoading(false);
    };

    // Final import
    const handleImport = async () => {
        if (selectedTables.length === 0 || !connectionId) return;
        setIsLoading(true);

        const active = AVAILABLE_CONNECTORS.find(c => c.id === configuringId);
        const isPostgres = configuringId === 'postgres';
        const dbType: 'mssql' | 'pg' = isPostgres ? 'pg' : 'mssql';
        const data = await getMockConnectorData(connectionId, selectedTables);

        // Always build connection info so user can switch modes later
        const liveInfo: LiveConnectionInfo & { connectionMode: 'import' | 'live' } = {
            connectionId,
            dbType,
            tables: [...selectedTables],
            joinEdges: joinEdges.map(e => ({ leftTable: e.leftTable, rightTable: e.rightTable, leftColumn: e.leftColumn, rightColumn: e.rightColumn, type: e.type })),
            connectionMode,
            // Non-sensitive metadata for reconnection
            host: connConfig?.host,
            port: connConfig?.port,
            database: connConfig?.database,
            username: connConfig?.username,
            ssl: connConfig?.ssl,
            _sessionPassword: connConfig?.password, // Ephemeral — for session caching only, never persisted
        };

        if (selectedTables.length === 1) {
            // Single table — direct import (still build basic schema info)
            const rows = Array.isArray(data) ? data : data[selectedTables[0]] || [];
            const name = `${active?.name} · ${selectedTables[0]}`;
            const singleSchema = {
                tables: [{
                    name: selectedTables[0],
                    rows: rows.length,
                    columns: (tableColumns[selectedTables[0]] || []).map(c => ({
                        name: c.name, dataType: c.dataType, isPK: c.isPK, isNullable: c.isNullable
                    }))
                }],
                joinEdges: [],
                joinLogs: [`Single table: ${selectedTables[0]} (${rows.length} rows)`]
            };
            setIsLoading(false);
            setConfiguringId(null);
            // In live mode, keep connectionId alive; in import mode, clear it
            if (connectionMode !== 'live') setConnectionId(null);
            onDataReady(rows, name, singleSchema, liveInfo);
        } else {
            // Multiple tables — auto-join into master table
            const tableData = typeof data === 'object' && !Array.isArray(data) ? data : {};
            const { mergedRows, joinLogs } = autoJoinDatasets(tableData, joinEdges);
            const name = `${active?.name} · Master (${selectedTables.length} tables)`;

            // Build source schema for the Schema tab
            const multiSchema = {
                tables: selectedTables.map(t => {
                    const tbl = availableTables.find(at => at.name === t);
                    return {
                        name: t,
                        rows: tbl?.rows || (tableData[t]?.length || 0),
                        columns: (tableColumns[t] || []).map(c => ({
                            name: c.name, dataType: c.dataType, isPK: c.isPK, isNullable: c.isNullable
                        }))
                    };
                }),
                joinEdges: joinEdges.map(e => ({
                    leftTable: e.leftTable, rightTable: e.rightTable,
                    leftColumn: e.leftColumn, rightColumn: e.rightColumn,
                    type: e.type
                })),
                joinLogs
            };

            setIsLoading(false);
            setConfiguringId(null);
            // In live mode, keep connectionId alive; in import mode, clear it
            if (connectionMode !== 'live') setConnectionId(null);
            onDataReady(mergedRows, name, multiSchema, liveInfo);
        }
    };

    const activeConnector = AVAILABLE_CONNECTORS.find(c => c.id === configuringId);
    const isRDBMS = activeConnector && ['postgres', 'mysql', 'mssql'].includes(activeConnector.id);

    const getDataTypeIcon = (dt: string) => {
        const lower = dt.toLowerCase();
        if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money'].some(t => lower.includes(t)))
            return <Hash className="w-3.5 h-3.5 text-emerald-500" />;
        if (['date', 'time', 'datetime', 'datetime2', 'timestamp'].some(t => lower.includes(t)))
            return <Calendar className="w-3.5 h-3.5 text-amber-500" />;
        return <Type className="w-3.5 h-3.5 text-blue-500" />;
    };

    // Build the step indicator
    const stepLabels: { key: ModalStep; label: string }[] = [
        { key: 'credentials', label: 'Connect' },
        { key: 'tables', label: 'Tables' },
        { key: 'schema', label: 'Schema' },
    ];

    const stepIndex = stepLabels.findIndex(s => s.key === step);

    return (
        <div className="p-4 w-full animate-fade-in relative">
            <div className="flex flex-col gap-4">
                <div className="bg-gradient-to-br from-violet-50 to-indigo-50 dark:bg-slate-700/50 rounded-xl p-5 border border-violet-200 dark:border-slate-600 flex flex-col gap-4 shadow-sm">
                    <label className="text-base text-gray-800 dark:text-slate-200 font-bold">Select Data Source</label>
                    <div className="flex gap-3">
                        <select
                            value={selectedConnectorId}
                            onChange={(e) => setSelectedConnectorId(e.target.value)}
                            className="flex-1 bg-white dark:bg-slate-800 border-2 border-gray-300 dark:border-slate-600 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-violet-500 outline-none font-semibold text-sm shadow-sm"
                        >
                            {AVAILABLE_CONNECTORS.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                            <option value="custom" disabled style={{ color: '#94a3b8' }}>Custom REST (Coming Soon)</option>
                        </select>
                        <button
                            onClick={handleConnect}
                            className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-lg shadow-violet-200 hover:shadow-xl hover:shadow-violet-300 active:scale-95"
                        >
                            Connect
                        </button>
                    </div>
                </div>
            </div>

            {/* CONFIGURATION MODAL */}
            {configuringId && activeConnector && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col border border-indigo-100">

                        {/* HEADER + STEP INDICATOR */}
                        <div className="p-5 border-b border-slate-200 bg-gradient-to-r from-indigo-50 to-white flex-shrink-0">
                            <div className="flex justify-between items-center mb-4">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg shadow-indigo-200">
                                        {activeConnector.icon === 'shopping' ? <ShoppingBag className="w-5 h-5 text-white" /> : <Database className="w-5 h-5 text-white" />}
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-slate-900">Connect {activeConnector.name}</h3>
                                        <p className="text-sm text-slate-600 font-medium">
                                            {step === 'credentials' ? 'Authentication' : step === 'tables' ? 'Select Tables' : 'Review Schema & Import'}
                                        </p>
                                    </div>
                                </div>
                                <button onClick={() => { setConfiguringId(null); setConnectionId(null); }} className="text-slate-400 hover:text-slate-600 transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {/* Step Progress */}
                            {isRDBMS && (
                                <div className="flex items-center gap-1">
                                    {stepLabels.map((s, i) => (
                                        <React.Fragment key={s.key}>
                                            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${i <= stepIndex
                                                ? 'bg-indigo-100 text-indigo-700'
                                                : 'bg-slate-100 text-slate-400'
                                                }`}>
                                                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${i < stepIndex ? 'bg-indigo-600 text-white' :
                                                    i === stepIndex ? 'bg-indigo-600 text-white' :
                                                        'bg-slate-300 text-white'
                                                    }`}>{i < stepIndex ? '✓' : i + 1}</span>
                                                {s.label}
                                            </div>
                                            {i < stepLabels.length - 1 && (
                                                <ArrowRight className={`w-3 h-3 flex-shrink-0 ${i < stepIndex ? 'text-indigo-400' : 'text-slate-300'}`} />
                                            )}
                                        </React.Fragment>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* ERROR ALERT */}
                        {error && (
                            <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 text-red-700 text-xs flex-shrink-0">
                                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                <div className="leading-relaxed font-medium">{error}</div>
                            </div>
                        )}

                        {/* SCROLLABLE BODY */}
                        <div className="flex-1 overflow-y-auto">

                            {/* ─── STEP 1: CREDENTIALS ──────────────────────── */}
                            {step === 'credentials' && (
                                <form onSubmit={handleCredentialsSubmit} className="p-5 space-y-4">
                                    {isRDBMS && configuringId !== 'postgres' && (
                                        <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 flex items-center justify-between">
                                            <div className="flex items-center space-x-2">
                                                {useWindowsAuth ? <ShieldCheck className="w-5 h-5 text-green-600" /> : <Shield className="w-5 h-5 text-slate-400" />}
                                                <span className="text-sm font-medium text-slate-700">Integrated Auth (Windows/Kerberos)</span>
                                            </div>
                                            <label className="relative inline-flex items-center cursor-pointer">
                                                <input type="checkbox" className="sr-only peer" checked={useWindowsAuth} onChange={() => setUseWindowsAuth(!useWindowsAuth)} />
                                                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                                            </label>
                                        </div>
                                    )}

                                    {activeConnector.icon === 'shopping' ? (
                                        <>
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Store URL</label>
                                                <input required type="url" placeholder="https://your-store.myshopify.com" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">API Access Token</label>
                                                <input required type="password" placeholder="shpat_xxxxxxxxxxxx" className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none" />
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="grid grid-cols-2 gap-4">
                                                <div>
                                                    <label className="block text-sm font-medium text-slate-700 mb-1">Host</label>
                                                    <input name="host" required type="text" defaultValue="localhost" placeholder="localhost" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                                </div>
                                                <div>
                                                    <label className="block text-sm font-medium text-slate-700 mb-1">Port</label>
                                                    <input name="port" required type="text" defaultValue={configuringId === 'postgres' ? '5432' : '1433'} placeholder={configuringId === 'postgres' ? '5432' : '1433'} className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-sm font-medium text-slate-700 mb-1">Database Name</label>
                                                <input name="database" required type="text" placeholder="analytics_db" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                            </div>

                                            {(!useWindowsAuth || configuringId === 'postgres') && (
                                                <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2">
                                                    <div>
                                                        <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                                                        <input name="username" required type="text" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                                    </div>
                                                    <div>
                                                        <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                                                        <input name="password" required type="password" className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 bg-white focus:ring-2 focus:ring-indigo-500 outline-none" />
                                                    </div>
                                                </div>
                                            )}

                                            {configuringId === 'postgres' && (
                                                <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
                                                    <input name="ssl" type="checkbox" id="ssl-toggle" className="w-4 h-4 text-indigo-600 bg-gray-100 border-gray-300 rounded focus:ring-indigo-500" />
                                                    <label htmlFor="ssl-toggle" className="text-sm font-medium text-slate-700">Use SSL (required for cloud-hosted databases)</label>
                                                </div>
                                            )}
                                        </>
                                    )}

                                    <div className="pt-4 flex items-center justify-end space-x-3">
                                        <button type="button" onClick={() => { setConfiguringId(null); setConnectionId(null); }} className="text-slate-600 font-medium text-sm px-4 py-2 hover:bg-slate-100 rounded-lg">Cancel</button>
                                        <button
                                            type="submit"
                                            disabled={isLoading}
                                            className="bg-indigo-600 text-white font-medium text-sm px-6 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-70 flex items-center"
                                        >
                                            {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                            {isLoading ? 'Connecting...' : 'Connect'}
                                        </button>
                                    </div>
                                </form>
                            )}

                            {/* ─── STEP 2: TABLE SELECTION ──────────────────── */}
                            {step === 'tables' && (
                                <div className="flex flex-col" style={{ maxHeight: 'calc(90vh - 140px)' }}>
                                    {/* Header area */}
                                    <div className="px-5 pt-5 pb-2 flex-shrink-0">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <Table2 className="w-4 h-4 text-indigo-500" />
                                                <h4 className="text-sm font-bold text-slate-900">Select Tables to Import</h4>
                                            </div>
                                            <button onClick={toggleAll} className="text-xs text-indigo-600 hover:underline font-medium">
                                                {selectedTables.length === availableTables.length ? 'Deselect All' : 'Select All'}
                                            </button>
                                        </div>
                                        <p className="text-xs text-slate-600 font-medium">
                                            Click a table to preview its columns. Select multiple tables for automatic join.
                                        </p>
                                    </div>

                                    {/* Scrollable table list */}
                                    <div className="flex-1 overflow-y-auto px-5 py-2">
                                        <div className="border border-slate-200 rounded-xl bg-white shadow-sm">
                                            {availableTables.map((table) => {
                                                const isExpanded = expandedTable === table.name;
                                                const cols = tableColumns[table.name];
                                                const isSelected = selectedTables.includes(table.name);

                                                return (
                                                    <div key={table.name} className={`border-b border-slate-100 last:border-0 transition-all ${isSelected ? 'bg-indigo-50' : 'bg-white hover:bg-slate-50'}`}>
                                                        <div className="flex items-center justify-between px-4 py-3 cursor-pointer">
                                                            <div className="flex items-center gap-3 flex-1 min-w-0" onClick={() => handleExpandTable(table.name)}>
                                                                {isExpanded ? <ChevronDown className="w-4 h-4 text-indigo-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                                                                <Database className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-indigo-600' : 'text-slate-400'}`} />
                                                                <div className="min-w-0">
                                                                    <div className="text-sm font-bold text-slate-900 truncate">{table.name}</div>
                                                                    <div className="text-xs text-slate-600 font-semibold">{table.rows.toLocaleString()} rows · <span className="text-slate-500">{table.category}</span></div>
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                                {cols && (
                                                                    <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-md font-mono">
                                                                        {cols.length} cols
                                                                    </span>
                                                                )}
                                                                <label className="cursor-pointer flex items-center" onClick={(e) => e.stopPropagation()}>
                                                                    <input
                                                                        type="checkbox"
                                                                        className="rounded text-indigo-600 focus:ring-indigo-500 w-5 h-5 border-2 border-slate-300"
                                                                        checked={isSelected}
                                                                        onChange={() => toggleTable(table.name)}
                                                                    />
                                                                </label>
                                                            </div>
                                                        </div>

                                                        {/* Column Preview Panel */}
                                                        {isExpanded && (
                                                            <div className="px-4 pb-3 pl-12">
                                                                {loadingColumns === table.name ? (
                                                                    <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                                                                        <Loader2 className="w-3 h-3 animate-spin" /> Loading columns...
                                                                    </div>
                                                                ) : cols && cols.length > 0 ? (
                                                                    <div className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                                                                        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-2 bg-indigo-50 text-[11px] font-bold text-indigo-700 uppercase tracking-wider rounded-t-lg">
                                                                            <span>Column</span>
                                                                            <span>Type</span>
                                                                            <span>Key</span>
                                                                        </div>
                                                                        {cols.map((col, i) => (
                                                                            <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-2 text-sm border-t border-slate-100 items-center">
                                                                                <span className="font-mono text-slate-800 font-semibold truncate flex items-center gap-1.5">
                                                                                    {getDataTypeIcon(col.dataType)}
                                                                                    {col.name}
                                                                                </span>
                                                                                <span className="text-slate-600 font-mono text-xs font-medium">{col.dataType}</span>
                                                                                <span>
                                                                                    {col.isPK && <Key className="w-3 h-3 text-amber-500" />}
                                                                                </span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                ) : (
                                                                    <div className="text-xs text-slate-400 py-2">No column info available</div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Sticky action bar — always visible at bottom */}
                                    <div className="flex-shrink-0 px-5 py-4 border-t border-slate-200 bg-gradient-to-t from-slate-50 to-white">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-slate-500 flex items-center gap-1.5">
                                                <CheckCircle2 className={`w-3.5 h-3.5 ${selectedTables.length > 0 ? 'text-indigo-500' : 'text-slate-300'}`} />
                                                {selectedTables.length} table{selectedTables.length !== 1 ? 's' : ''} selected
                                                {selectedTables.length > 1 && (
                                                    <span className="text-indigo-600 font-medium ml-1">→ auto-join</span>
                                                )}
                                            </span>
                                            <div className="flex items-center gap-3">
                                                <button type="button" onClick={() => setStep('credentials')} className="text-slate-600 font-medium text-sm px-4 py-2 hover:bg-slate-100 rounded-lg transition-colors">Back</button>
                                                {selectedTables.length === 1 ? (
                                                    <button
                                                        onClick={handleImport}
                                                        disabled={isLoading}
                                                        className="bg-gradient-to-r from-indigo-600 to-indigo-700 text-white font-semibold text-sm px-6 py-2.5 rounded-xl hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-70 flex items-center gap-2 shadow-lg shadow-indigo-200 transition-all"
                                                    >
                                                        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                                                        Import Table
                                                    </button>
                                                ) : selectedTables.length > 1 ? (
                                                    <button
                                                        onClick={handleProceedToSchema}
                                                        disabled={isLoading}
                                                        className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold text-sm px-6 py-2.5 rounded-xl hover:from-indigo-700 hover:to-purple-700 disabled:opacity-70 flex items-center gap-2 shadow-lg shadow-indigo-200 transition-all"
                                                    >
                                                        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                                                        {isLoading ? 'Analyzing...' : 'Review Schema →'}
                                                    </button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* ─── STEP 3: STAR SCHEMA / JOIN PREVIEW ────────── */}
                            {step === 'schema' && (
                                <div className="p-5 space-y-5">

                                    {/* Schema Diagram */}
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <GitMerge className="w-4 h-4 text-indigo-500" />
                                            <h4 className="text-sm font-bold text-slate-800">Relationship Map</h4>
                                            <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                                                {joinEdges.length} join{joinEdges.length !== 1 ? 's' : ''} detected
                                            </span>
                                        </div>

                                        {/* Visual star schema */}
                                        <div className="bg-gradient-to-br from-slate-50 to-indigo-50/30 rounded-xl border border-slate-200 p-5 overflow-x-auto">
                                            {joinEdges.length === 0 ? (
                                                <div className="text-center py-6">
                                                    <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
                                                    <p className="text-sm text-slate-600 font-medium">No relationships detected</p>
                                                    <p className="text-xs text-slate-400 mt-1">Tables will be imported separately. No matching columns found.</p>
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {joinEdges.map((edge, i) => (
                                                        <div key={i} className="flex items-center gap-3 group">
                                                            {/* Left table */}
                                                            <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-slate-200 shadow-sm min-w-[140px]">
                                                                <Database className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                                                                <div>
                                                                    <div className="text-xs font-bold text-slate-800">{edge.leftTable}</div>
                                                                    <div className="text-[10px] font-mono text-indigo-600">{edge.leftColumn}</div>
                                                                </div>
                                                            </div>

                                                            {/* Join arrow */}
                                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                                <div className="w-8 h-0.5 bg-slate-300 group-hover:bg-indigo-400 transition-colors" />
                                                                <div className={`px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${edge.type === 'fk'
                                                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                                    : 'bg-amber-50 text-amber-700 border-amber-200'
                                                                    }`}>
                                                                    {edge.type === 'fk' ? 'FK' : 'NAME'}
                                                                </div>
                                                                <div className="w-8 h-0.5 bg-slate-300 group-hover:bg-indigo-400 transition-colors" />
                                                                <ArrowRight className="w-3 h-3 text-slate-400 group-hover:text-indigo-500 transition-colors" />
                                                            </div>

                                                            {/* Right table */}
                                                            <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-slate-200 shadow-sm min-w-[140px]">
                                                                <Database className="w-4 h-4 text-purple-500 flex-shrink-0" />
                                                                <div>
                                                                    <div className="text-xs font-bold text-slate-800">{edge.rightTable}</div>
                                                                    <div className="text-[10px] font-mono text-purple-600">{edge.rightColumn}</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Table column summary grid */}
                                    <div>
                                        <div className="flex items-center gap-2 mb-3">
                                            <Columns3 className="w-4 h-4 text-indigo-500" />
                                            <h4 className="text-sm font-bold text-slate-800">Columns per Table</h4>
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            {selectedTables.map(tbl => {
                                                const cols = tableColumns[tbl] || [];
                                                const pkCols = cols.filter(c => c.isPK);
                                                return (
                                                    <div key={tbl} className="bg-white rounded-lg border border-slate-200 p-3">
                                                        <div className="flex items-center justify-between mb-2">
                                                            <div className="flex items-center gap-2">
                                                                <Database className="w-3.5 h-3.5 text-indigo-500" />
                                                                <span className="text-xs font-bold text-slate-800">{tbl}</span>
                                                            </div>
                                                            <span className="text-[10px] text-slate-400">{cols.length} cols</span>
                                                        </div>
                                                        <div className="flex flex-wrap gap-1">
                                                            {cols.slice(0, 8).map((col, i) => (
                                                                <span key={i} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${col.isPK ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'
                                                                    }`}>
                                                                    {col.isPK && <Key className="w-2.5 h-2.5" />}
                                                                    {col.name}
                                                                </span>
                                                            ))}
                                                            {cols.length > 8 && (
                                                                <span className="text-[10px] text-slate-400 px-1">+{cols.length - 8} more</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    {/* Master Table Preview */}
                                    <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-100 p-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Zap className="w-4 h-4 text-indigo-600" />
                                            <h4 className="text-sm font-bold text-indigo-900">Master Table Strategy</h4>
                                        </div>
                                        <div className="text-xs text-indigo-700 space-y-1">
                                            <p>
                                                <strong>{selectedTables.length}</strong> tables will be joined into a single master table using <strong>LEFT JOIN</strong> cascade.
                                            </p>
                                            {joinEdges.length > 0 && (
                                                <div className="mt-2 space-y-1">
                                                    {joinEdges.map((e, i) => (
                                                        <div key={i} className="flex items-center gap-1 text-[11px]">
                                                            <span className="font-mono font-bold">{e.leftTable}.{e.leftColumn}</span>
                                                            <ArrowRight className="w-3 h-3" />
                                                            <span className="font-mono font-bold">{e.rightTable}.{e.rightColumn}</span>
                                                            <span className={`ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold ${e.type === 'fk' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                                                                }`}>{e.type.toUpperCase()}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* ── CONNECTION MODE TOGGLE ── */}
                                    <div className="mt-1">
                                        <div className="flex items-center gap-2 mb-3">
                                            <Radio className="w-4 h-4 text-indigo-500" />
                                            <h4 className="text-sm font-bold text-slate-800">Connection Mode</h4>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <button
                                                onClick={() => setConnectionMode('import')}
                                                className={`relative p-3.5 rounded-xl border-2 text-left transition-all ${
                                                    connectionMode === 'import'
                                                        ? 'border-indigo-500 bg-indigo-50 shadow-md shadow-indigo-100'
                                                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                                                }`}
                                            >
                                                {connectionMode === 'import' && (
                                                    <div className="absolute top-2 right-2">
                                                        <CheckCircle2 className="w-4 h-4 text-indigo-600" />
                                                    </div>
                                                )}
                                                <Download className={`w-5 h-5 mb-1.5 ${connectionMode === 'import' ? 'text-indigo-600' : 'text-slate-400'}`} />
                                                <div className={`text-xs font-bold ${connectionMode === 'import' ? 'text-indigo-900' : 'text-slate-700'}`}>Import (Snapshot)</div>
                                                <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">Copies data into browser for fast offline analysis</div>
                                            </button>
                                            <button
                                                onClick={() => setConnectionMode('live')}
                                                className={`relative p-3.5 rounded-xl border-2 text-left transition-all ${
                                                    connectionMode === 'live'
                                                        ? 'border-emerald-500 bg-emerald-50 shadow-md shadow-emerald-100'
                                                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                                                }`}
                                            >
                                                {connectionMode === 'live' && (
                                                    <div className="absolute top-2 right-2">
                                                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                                    </div>
                                                )}
                                                <Zap className={`w-5 h-5 mb-1.5 ${connectionMode === 'live' ? 'text-emerald-600' : 'text-slate-400'}`} />
                                                <div className={`text-xs font-bold ${connectionMode === 'live' ? 'text-emerald-900' : 'text-slate-700'}`}>Live Connection</div>
                                                <div className="text-[10px] text-slate-500 mt-0.5 leading-snug">Queries run against live database — refresh fetches latest data</div>
                                            </button>
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="pt-2 flex items-center justify-between">
                                        <span className="text-xs text-slate-500">
                                            {selectedTables.length} table{selectedTables.length !== 1 ? 's' : ''} → 1 master table
                                            {connectionMode === 'live' && <span className="ml-1 text-emerald-600 font-semibold">⚡ Live</span>}
                                        </span>
                                        <div className="flex space-x-3">
                                            <button type="button" onClick={() => setStep('tables')} className="text-slate-600 font-medium text-sm px-4 py-2 hover:bg-slate-100 rounded-lg">Back</button>
                                            <button
                                                onClick={handleImport}
                                                disabled={isLoading}
                                                className={`text-white font-medium text-sm px-6 py-2.5 rounded-lg disabled:opacity-70 flex items-center shadow-lg ${
                                                    connectionMode === 'live'
                                                        ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 shadow-emerald-200'
                                                        : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-indigo-200'
                                                }`}
                                            >
                                                {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                                                {isLoading
                                                    ? (connectionMode === 'live' ? 'Connecting Live...' : 'Importing & Joining...')
                                                    : (connectionMode === 'live' ? '⚡ Connect Live' : 'Import & Join Master Table')
                                                }
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                        </div>
                    </div>
                </div>
            )
            }
        </div >
    );
};