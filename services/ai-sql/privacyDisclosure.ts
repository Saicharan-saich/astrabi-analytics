/**
 * Privacy disclosure — what "Better answers" would actually send, for THIS
 * dataset.
 * ─────────────────────────────────────────────────────────────────────
 * A generic notice ("we send some category values") is not informed consent.
 * This builds the real list from the user's loaded data: every column whose
 * values would be shared, with the actual values, and every column that is
 * held back with the reason it was held back.
 *
 * The shared list is taken from `collectSafeDomains` — the same function the
 * pipeline calls — so the dialog cannot show less than what is sent. A test
 * asserts the two agree.
 */

import type { SemanticModel, SemanticField } from './types';
import { collectSafeDomains, isSensitiveColumn, looksLikePersonalData } from './schemaSerializer';

export type WithheldReason =
    | 'identifier'
    | 'personal'
    | 'sensitive'
    | 'value-shape'
    | 'too-many-values'
    | 'date'
    | 'measure';

export interface SharedColumn {
    name: string;
    /** The exact values that would be sent. */
    values: string[];
    /** True distinct count; when it exceeds values.length the list is a sample. */
    totalDistinct: number;
    truncated: boolean;
}

export interface WithheldColumn {
    name: string;
    reason: WithheldReason;
    /** Plain-English explanation shown to the user. */
    explanation: string;
}

export interface PrivacyDisclosure {
    datasetName: string;
    rowCount: number;
    columnCount: number;
    /** Columns whose values would be sent, with those values. */
    shared: SharedColumn[];
    /** Columns whose values are held back, and why. */
    withheld: WithheldColumn[];
    /** Total number of individual values that would leave the device. */
    totalValuesShared: number;
}

const EXPLANATIONS: Record<WithheldReason, string> = {
    identifier: 'Looks like an ID or reference number',
    personal: 'Looks like personal information from the column name',
    sensitive: 'Sensitive subject (health, personal characteristics, or money)',
    'value-shape': 'The values themselves look like personal information',
    'too-many-values': 'Too many different values to be a useful category',
    date: 'A date column — only the overall date range is shared',
    measure: 'A number column — only its lowest and highest value are shared',
};

/** Mirrors the exclusion order inside collectSafeDomains, for explanation only. */
function reasonFor(field: SemanticField, model: SemanticModel, sampleValues: string[]): WithheldReason {
    if (field.role === 'metric') return 'measure';
    if (field.physicalType === 'date' || field.semanticType === 'date') return 'date';
    if (field.semanticType === 'identifier') return 'identifier';
    if (isSensitiveColumn(field)) {
        const n = field.name.toLowerCase();
        const personal = /(name|e[_ ]?mail|phone|mobile|address|postcode|postal|zip|ssn|passport|licen|dob|birth|card|account|iban)/;
        return personal.test(n) ? 'personal' : 'sensitive';
    }
    if (model.rowCount > 0 && field.distinctCount >= model.rowCount * 0.9) return 'too-many-values';
    if (sampleValues.length && looksLikePersonalData(sampleValues)) return 'value-shape';
    return 'too-many-values';
}

/** First few distinct values of a column — used only to explain a rejection. */
function peek(rows: Record<string, any>[], column: string, limit = 12): string[] {
    const seen = new Set<string>();
    for (const row of rows) {
        const raw = row[column];
        if (raw === null || raw === undefined || raw === '') continue;
        const val = String(raw).trim();
        if (!val || seen.has(val)) continue;
        seen.add(val);
        if (seen.size >= limit) break;
    }
    return [...seen];
}

export function buildPrivacyDisclosure(
    rows: Record<string, any>[],
    model: SemanticModel,
): PrivacyDisclosure {
    // Authoritative: exactly what the pipeline would send.
    const domains = collectSafeDomains(rows, model);

    const shared: SharedColumn[] = [];
    const withheld: WithheldColumn[] = [];

    for (const field of model.fields) {
        const domain = domains.get(field.name);
        if (domain) {
            shared.push({
                name: field.name,
                values: domain.values,
                totalDistinct: domain.total,
                truncated: domain.total > domain.values.length,
            });
        } else {
            const reason = reasonFor(field, model, peek(rows, field.name));
            withheld.push({ name: field.name, reason, explanation: EXPLANATIONS[reason] });
        }
    }

    shared.sort((a, b) => a.name.localeCompare(b.name));
    withheld.sort((a, b) => a.name.localeCompare(b.name));

    return {
        datasetName: model.datasetName,
        rowCount: model.rowCount,
        columnCount: model.fields.length,
        shared,
        withheld,
        totalValuesShared: shared.reduce((n, c) => n + c.values.length, 0),
    };
}

/**
 * What is sent in BOTH modes, and what is never sent in either. Fixed text —
 * it describes the architecture, not the dataset.
 */
export const ALWAYS_SENT = [
    'Column names (for example "Product", "Region", "TotalPrice")',
    'What type each column is — text, number or date',
    'Whether a column is something to group by or something to add up',
    'Totals about each column: how many different values, the lowest and highest number',
    'The first and last date in your data',
] as const;

export const NEVER_SENT = [
    'Any row of your data — not one, not a sample, not ever',
    'Names, email addresses, phone numbers, postal addresses',
    'ID and reference numbers',
    'Anything about health, personal characteristics, pay or legal history',
    'Your file itself — it is read in your browser and never uploaded',
] as const;
