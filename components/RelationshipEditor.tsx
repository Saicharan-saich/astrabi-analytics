import React, { useState } from 'react';
import type { Dataset, SourceJoinEdge } from '../types';
import { buildRelationalCatalog, createSubjectDataset, validateRelationship, sourceColumns } from '../services/relationalCatalog';
import { buildSemanticModel } from '../services/semanticModel';
import { saveDatasetsAtomically } from '../services/datasetDB';
import { useAppStore } from '../store/useAppStore';
import { ROLE_PERMISSIONS, useAuthStore } from '../store/useAuthStore';

export function RelationshipEditor({ dataset }: { dataset: Dataset }) {
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [fromKeys, setFromKeys] = useState('');
    const [toKeys, setToKeys] = useState('');
    const [message, setMessage] = useState('');
    const [saving, setSaving] = useState(false);
    const user = useAuthStore(s => s.currentUser);
    const tables = dataset.sourceTables || dataset.relatedTables || [];
    if (!tables.length || !user || !ROLE_PERMISSIONS[user.role].canEditSchema || dataset.connectionMode === 'live') return null;
    const columns = (table: string) => { const source = tables.find(t => t.name === table); return source ? sourceColumns(source) : []; };
    const save = async (remove = false) => {
        if (saving) return;
        setSaving(true);
        try {
            const state = useAppStore.getState();
            const root = state.datasets.find(d => d.id === (dataset.sourceDatasetId || dataset.id)) || dataset;
            const catalog = structuredClone(root.relationalCatalog || buildRelationalCatalog(tables));
            const leftColumns = fromKeys.split(',').map(s => s.trim()).filter(Boolean);
            const rightColumns = toKeys.split(',').map(s => s.trim()).filter(Boolean);
            const edge: SourceJoinEdge = { leftTable: from, rightTable: to, leftColumn: leftColumns[0], rightColumn: rightColumns[0], leftColumns, rightColumns, type: 'fk', provenance: 'user' };
            if (!remove && catalog.subjects.find(s => s.table === to)?.kind === 'fact') {
                throw new Error('A fact table must be analyzed as a separate subject. Combining facts requires a compatible aggregation plan.');
            }
            const validation = remove ? { unmatched: 0 } : validateRelationship(tables, edge);
            if (!from || !leftColumns.length) throw new Error('Choose a source table and its key columns.');
            const signature = JSON.stringify(leftColumns);
            catalog.schema.joinEdges = catalog.schema.joinEdges.filter(e => !(e.leftTable === from && JSON.stringify(e.leftColumns || [e.leftColumn]) === signature));
            if (!remove) catalog.schema.joinEdges.push(edge);
            catalog.schema.joinLogs.push(`${remove ? 'Removed' : 'User-confirmed'} relationship for ${from}.${leftColumns.join(' + ')}. ${validation.unmatched} unmatched rows remain as empty lookup values.`);
            const updated = { ...root, relationalCatalog: catalog, sourceSchema: catalog.schema, sourceTables: tables, version: (root.version || 1) + 1 };
            if (root.subjectTable) {
                const rootView = createSubjectDataset(updated, root.subjectTable, !!root.standaloneSubject);
                Object.assign(updated, { rows: rootView.rows, columns: rootView.columns, totalRows: rootView.totalRows,
                    fieldLineage: rootView.fieldLineage, fieldOrigins: rootView.fieldOrigins, timeContext: rootView.timeContext,
                    aiSqlSemanticModel: undefined });
                updated.semanticModel = buildSemanticModel(updated);
            }
            const subject = createSubjectDataset(updated, dataset.subjectTable || from, !!dataset.standaloneSubject);
            subject.semanticModel = buildSemanticModel(subject);
            await saveDatasetsAtomically([updated, subject]);
            state.setDataset(updated);
            state.setDataset(subject);
            setMessage('Relationship model saved as a new version. Existing subject versions remain available.');
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save relationship'); }
        finally { setSaving(false); }
    };
    return <details className="rounded-xl border border-slate-600 p-4 text-slate-200">
        <summary className="cursor-pointer font-semibold">Review or change relationships</summary>
        <p className="text-xs my-3">Choose the reference columns and a unique lookup key. For a composite key, enter comma-separated columns in matching order. Lookup uniqueness is checked against every row.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label>Source table<select aria-label="Relationship source table" className="block bg-slate-900 w-full p-2" value={from} onChange={e => { setFrom(e.target.value); setFromKeys(''); }}><option value="">Select table</option>{tables.map(t => <option key={t.name}>{t.name}</option>)}</select></label>
            <label>Lookup table<select aria-label="Relationship lookup table" className="block bg-slate-900 w-full p-2" value={to} onChange={e => { setTo(e.target.value); setToKeys(''); }}><option value="">Select table</option>{tables.map(t => <option key={t.name}>{t.name}</option>)}</select></label>
            <label>Reference columns<input aria-label="Reference columns" className="block bg-slate-900 w-full p-2" value={fromKeys} onChange={e => setFromKeys(e.target.value)} /><span className="text-xs">{columns(from).join(', ')}</span></label>
            <label>Lookup key columns<input aria-label="Lookup key columns" className="block bg-slate-900 w-full p-2" value={toKeys} onChange={e => setToKeys(e.target.value)} /><span className="text-xs">{columns(to).join(', ')}</span></label>
        </div>
        <button disabled={saving} className="rounded bg-indigo-600 px-3 py-2 mt-3 disabled:opacity-50" onClick={() => save()}>Validate and save</button>
        <button disabled={saving} className="rounded border border-slate-500 px-3 py-2 ml-2 disabled:opacity-50" onClick={() => save(true)}>Remove relationship</button>
        {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    </details>;
}
