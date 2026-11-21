/**
 * cleaningSetups.ts — saved cleaning setups for files that come back.
 *
 * Clean a client's file once (with them, on a call), save the choices as a
 * setup, and every later file with the same columns is cleaned the same way,
 * in the browser, with no one looking at the rows. The setup also remembers the
 * columns and their kinds, so a file that has changed shape is reported before
 * anyone trusts its numbers.
 *
 * Pure and dynamic: setups are recognised by their columns, never by a file
 * name or a known column name.
 */

import { ColumnType, type AppliedSetup, type CleaningSetup, type Dataset, type ETLLog, type EtlOptions, type SetupChange } from '../types';

/** "Order Date " / "order-date" / "ORDER_DATE" → "order_date". */
export function headerKey(header: string): string {
    return String(header ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The headers of a file's rows (first rows are enough; internal columns left out). */
export function headersOf(rows: Record<string, any>[] | undefined): string[] {
    const seen = new Set<string>();
    for (const row of (rows || []).slice(0, 50)) {
        for (const key of Object.keys(row || {})) if (!key.startsWith('__')) seen.add(key);
    }
    return [...seen];
}

/** Column kinds the person set by hand (kept through every re-clean). */
export function handSetKinds(dataset: Pick<Dataset, 'etlLogs' | 'columns'>): Record<string, ColumnType> {
    const out: Record<string, ColumnType> = {};
    for (const entry of dataset.etlLogs || []) {
        if (entry.step !== 'User Override') continue;
        for (const name of entry.affectedColumns || []) {
            const column = dataset.columns.find(c => c.name === name);
            if (column) out[name] = column.type;
        }
    }
    return out;
}

const newId = () => `setup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** A setup from a cleaned dataset (or an update of an existing one). */
export function buildSetup(dataset: Dataset, name: string, existing?: CleaningSetup, now = Date.now()): CleaningSetup {
    const columnTypes = handSetKinds(dataset);
    return {
        id: existing?.id || newId(),
        name: name.trim() || existing?.name || dataset.name,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        headers: headersOf(dataset.rawRows?.length ? dataset.rawRows : dataset.rows),
        columns: dataset.columns.filter(c => !c.name.startsWith('__')).map(c => ({ name: c.name, type: c.type })),
        etlOptions: JSON.parse(JSON.stringify(dataset.etlOptions || {})),
        ...(Object.keys(columnTypes).length ? { columnTypes } : {}),
        ...(existing?.notes ? { notes: existing.notes } : {}),
        timesUsed: existing?.timesUsed || 0,
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
}

/** How closely a file's headers match a setup: 1 = the same columns. */
export function matchScore(headers: string[], setup: Pick<CleaningSetup, 'headers'>): number {
    const a = new Set(headers.map(headerKey).filter(Boolean));
    const b = new Set(setup.headers.map(headerKey).filter(Boolean));
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const key of a) if (b.has(key)) shared++;
    return shared / (a.size + b.size - shared);
}

/** Below this, a file is a different kind of file and no setup is applied. */
export const CLOSE_MATCH = 0.75;

/** The setup for a file: the closest match above the bar, the most recently used on a tie. */
export function pickSetup(headers: string[], setups: CleaningSetup[] | undefined): { setup: CleaningSetup; match: 'exact' | 'close'; score: number } | null {
    let best: { setup: CleaningSetup; score: number } | null = null;
    for (const setup of setups || []) {
        const score = matchScore(headers, setup);
        if (score < CLOSE_MATCH) continue;
        if (!best || score > best.score || (score === best.score && (setup.lastUsedAt || setup.updatedAt) > (best.setup.lastUsedAt || best.setup.updatedAt))) {
            best = { setup, score };
        }
    }
    return best ? { setup: best.setup, match: best.score === 1 ? 'exact' : 'close', score: best.score } : null;
}

/** Hand-set kinds for the columns this file has (a setup never invents columns). */
export function overridesFor(setup: CleaningSetup, headers: string[]): Record<string, ColumnType> | undefined {
    if (!setup.columnTypes) return undefined;
    const present = new Set(headers.map(headerKey));
    const out: Record<string, ColumnType> = {};
    for (const [name, type] of Object.entries(setup.columnTypes)) if (present.has(headerKey(name))) out[name] = type;
    return Object.keys(out).length ? out : undefined;
}

/** Every column a setup's choices are about. */
export function columnsInChoices(options: EtlOptions): string[] {
    const out = new Set<string>();
    for (const map of [options.outlierDecisions, options.typoDecisions, options.blankDecisions]) for (const column of Object.keys(map || {})) out.add(column);
    for (const rule of options.customRules || []) if (rule.column) out.add(rule.column);
    for (const key of Object.keys(options.flagDecisions || {})) {
        const at = key.indexOf(':');
        if (at < 0) continue;
        const rest = key.slice(at + 1);
        if (key.startsWith('rule:')) continue; // covered by the rule itself
        for (const column of rest.split('->')) if (column) out.add(column);
    }
    return [...out];
}

const label = (column: string) => column.replace(/_/g, ' ');
const KIND_WORD: Record<string, string> = { METRIC: 'a number', DIMENSION: 'a category', DATE: 'a date', ID: 'an identifier', BOOLEAN: 'yes/no' };

/** How a cleaned file compares with the setup that cleaned it. Serious changes first. */
export function compareWithSetup(setup: CleaningSetup, columns: { name: string; type: ColumnType }[]): SetupChange[] {
    const now = new Map(columns.filter(c => !c.name.startsWith('__')).map(c => [headerKey(c.name), c] as const));
    const before = new Map(setup.columns.map(c => [headerKey(c.name), c] as const));
    const changes: SetupChange[] = [];
    const used = new Set(columnsInChoices(setup.etlOptions).map(headerKey));

    for (const [key, column] of before) {
        const current = now.get(key);
        if (!current) {
            const counts = column.type === ColumnType.METRIC || column.type === ColumnType.DATE;
            changes.push({
                kind: 'missing_column', column: column.name, serious: counts || used.has(key),
                text: `'${label(column.name)}' is missing from this file${used.has(key) ? ', so the setup\'s choices for it were skipped' : ''}${counts ? '. Answers that use it will be missing.' : '.'}`,
            });
            continue;
        }
        if (current.type !== column.type) {
            const numbersAtRisk = column.type === ColumnType.METRIC || current.type === ColumnType.METRIC || column.type === ColumnType.DATE;
            changes.push({
                kind: 'kind_changed', column: column.name, serious: numbersAtRisk,
                text: `'${label(column.name)}' was ${KIND_WORD[column.type] || column.type.toLowerCase()} and now reads as ${KIND_WORD[current.type] || current.type.toLowerCase()}${column.type === ColumnType.METRIC ? '. Some values may no longer be numbers, so its totals could be wrong.' : '.'}`,
            });
        }
    }
    for (const [key, column] of now) {
        if (!before.has(key)) changes.push({ kind: 'new_column', column: column.name, serious: false, text: `'${label(column.name)}' is new: the setup has no choices for it, so it was cleaned automatically.` });
    }
    // A choice about a column that is in neither list (renamed before cleaning).
    for (const key of used) {
        if (!now.has(key) && !before.has(key)) changes.push({ kind: 'choice_skipped', column: key, serious: true, text: `A choice for '${label(key)}' was skipped: this file has no such column.` });
    }
    return changes.sort((a, b) => Number(b.serious) - Number(a.serious));
}

/** The record a dataset keeps of the setup that cleaned it (with any of its steps this file could not run). */
export function appliedSetup(setup: CleaningSetup, match: 'exact' | 'close', columns: { name: string; type: ColumnType }[], now = Date.now(), logs: ETLLog[] = []): AppliedSetup {
    const skipped: SetupChange[] = logs
        .filter(l => l.step === 'Your Step' && l.status === 'info')
        .map(l => {
            const m = /^Step (\d+), "(.+)": (.+?)\.?$/.exec(l.details);
            return { kind: 'choice_skipped' as const, column: l.affectedColumns?.[0] || '', serious: true,
                text: m ? `Step ${m[1]} ("${m[2]}") was skipped: this file has no column ${list(l.affectedColumns)}.` : l.details };
        });
    return { id: setup.id, name: setup.name, match, appliedAt: now, changes: [...skipped, ...compareWithSetup(setup, columns)].sort((a, b) => Number(b.serious) - Number(a.serious)) };
}
const list = (columns: string[] = []) => columns.map(c => `'${c.replace(/_/g, ' ')}'`).join(', ');

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** Has the person made choices since the setup was saved? */
export function choicesDiffer(dataset: Dataset, setup: CleaningSetup): boolean {
    return stable(dataset.etlOptions || {}) !== stable(setup.etlOptions || {})
        || stable(handSetKinds(dataset)) !== stable(setup.columnTypes || {});
}

/** "4 checks · 2 blank-cell choices · 1 column kind" — what a setup holds. */
export function describeSetup(setup: Pick<CleaningSetup, 'etlOptions' | 'columnTypes'>): string {
    const o = setup.etlOptions || {};
    const n = (count: number, one: string, many = `${one}s`) => (count ? `${count} ${count === 1 ? one : many}` : '');
    const decisions = Object.keys(o.outlierDecisions || {}).length + Object.keys(o.typoDecisions || {}).length + Object.keys(o.flagDecisions || {}).length;
    const undone = (['keepDuplicateRows', 'keepTotalRows', 'keepWideLayout', 'keepNameColumns', 'keepPlaceholders', 'keepCategorySpellings', 'skipAllocation', 'skipLineCost', 'keepMixedUnits'] as const).filter(k => o[k]).length;
    const steps = (o.manualSteps || []).filter(step => !step.off).length;
    const parts = [
        n(steps, 'step'),
        n((o.customRules || []).length, 'check'),
        n(Object.keys(o.blankDecisions || {}).length, 'blank-cell choice'),
        n(decisions, 'review decision'),
        n(undone, 'step left as uploaded', 'steps left as uploaded'),
        o.dateOrder ? 'a date order' : '',
        n(Object.keys(setup.columnTypes || {}).length, 'column kind'),
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'The automatic cleaning, with no extra choices';
}

/* ── Setup files: to move setups between computers, or hand them to a client ── */

const FORMAT = 'quickinsight-cleaning-setups';

export function setupFile(setups: CleaningSetup[]): string {
    return JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), setups }, null, 2);
}

const isSetup = (value: any): value is CleaningSetup => value && typeof value === 'object'
    && typeof value.id === 'string' && typeof value.name === 'string'
    && Array.isArray(value.headers) && value.headers.every((h: unknown) => typeof h === 'string')
    && Array.isArray(value.columns) && value.columns.every((c: any) => c && typeof c.name === 'string' && typeof c.type === 'string')
    && value.etlOptions && typeof value.etlOptions === 'object' && !Array.isArray(value.etlOptions);

/** Setups from a setup file; anything not a setup is left out. */
export function readSetupFile(text: string): { setups: CleaningSetup[]; error?: string } {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return { setups: [], error: 'This is not a QuickInsight setup file.' }; }
    const list = parsed?.format === FORMAT && Array.isArray(parsed.setups) ? parsed.setups : Array.isArray(parsed) ? parsed : isSetup(parsed) ? [parsed] : null;
    if (!list) return { setups: [], error: 'This is not a QuickInsight setup file.' };
    const setups = list.filter(isSetup).map((s: CleaningSetup) => ({ ...s, createdAt: Number(s.createdAt) || Date.now(), updatedAt: Number(s.updatedAt) || Date.now() }));
    return setups.length ? { setups } : { setups: [], error: 'The file has no setups in it.' };
}

/** Add loaded setups: one with the same id replaces the older copy. */
export function mergeSetups(current: CleaningSetup[], incoming: CleaningSetup[]): CleaningSetup[] {
    const byId = new Map(current.map(s => [s.id, s] as const));
    for (const setup of incoming) {
        const have = byId.get(setup.id);
        if (!have || setup.updatedAt >= have.updatedAt) byId.set(setup.id, setup);
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ── keeping setups with the account ── */

export interface AccountSetups { setups: CleaningSetup[]; deleted: { id: string; at: number }[] }

export interface SyncPlan {
    /** What this browser should hold afterwards. */
    keep: CleaningSetup[];
    /** Setups the account lacks or holds an older version of. */
    push: CleaningSetup[];
    /** Deletions made here that the account should make too. */
    remove: { id: string; at: number }[];
}

/** Pure: how to bring this browser and the account into line. */
export function planSync(local: CleaningSetup[], localDeleted: Record<string, number>, account: AccountSetups): SyncPlan {
    const accountDeleted = new Map(account.deleted.map(d => [d.id, d.at] as const));
    const accountById = new Map(account.setups.map(s => [s.id, s] as const));
    // A deletion wins over any version it is newer than, wherever it was made.
    const liveHere = local.filter(s => !((accountDeleted.get(s.id) ?? -1) >= s.updatedAt));
    const liveThere = account.setups.filter(s => !((localDeleted[s.id] ?? -1) >= s.updatedAt));
    // Newest version wins; on the same version, the one used more often (usage counts travel too).
    const byId = new Map<string, CleaningSetup>();
    for (const s of [...liveThere, ...liveHere]) {
        const have = byId.get(s.id);
        if (!have || s.updatedAt > have.updatedAt || (s.updatedAt === have.updatedAt && (s.timesUsed || 0) > (have.timesUsed || 0))) byId.set(s.id, s);
    }
    const keep = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const push = keep.filter(s => {
        const there = accountById.get(s.id);
        return !there || s.updatedAt > there.updatedAt || (s.updatedAt === there.updatedAt && (s.timesUsed || 0) > (there.timesUsed || 0));
    });
    const remove = Object.entries(localDeleted)
        .filter(([id, at]) => !((accountDeleted.get(id) ?? -1) >= at))
        .map(([id, at]) => ({ id, at }));
    return { keep, push, remove };
}
