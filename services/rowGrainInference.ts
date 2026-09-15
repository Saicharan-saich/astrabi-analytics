import { ColumnDefinition, ColumnSemantic, ColumnType } from '../types';

export interface RowGrainInference {
    label: string;
    confidence: number;
    source: 'unique_identifier' | 'composite_identifier' | 'table_name' | 'fallback';
    evidence: string[];
}

const REFERENCE_STEMS = new Set([
    'period', 'date', 'time', 'category', 'currency', 'source', 'status',
    'geo', 'geography', 'reporter_geo', 'partner_geo', 'country', 'region',
]);
const MAX_PROFILE_ROWS = 50_000;

function humanize(value: string): string {
    return value
        .replace(/\.[^.]+$/, '')
        .replace(/^(?:dim|fact|tbl|table)[_\s-]+/i, '')
        .replace(/(?:_id|_key|_code)$/i, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, char => char.toUpperCase());
}

function identifierStem(name: string): string {
    return name.toLowerCase().replace(/(?:_id|_key|_code)$/i, '').replace(/^id_/, '');
}

function isIdentifierLike(column: ColumnDefinition, semantic?: ColumnSemantic): boolean {
    return column.type === ColumnType.ID
        || semantic?.role === ColumnType.ID
        || semantic?.semanticRole === 'identifier'
        || /(^id$|(?:^|_)(?:id|key|code)$)/i.test(column.name);
}

function uniqueness(rows: Record<string, any>[], name: string): { ratio: number; nonNull: number } {
    if (!rows.length) return { ratio: 0, nonNull: 0 };
    const values = rows
        .map(row => row[name])
        .filter(value => value !== null && value !== undefined && value !== '');
    return {
        ratio: values.length ? new Set(values.map(value => `${typeof value}:${String(value)}`)).size / values.length : 0,
        nonNull: values.length,
    };
}

function tableSubject(fileName: string): string {
    const base = fileName.split(/[\\/]/).pop() || fileName;
    return humanize(base)
        .replace(/\b(?:Quick ?Insight|Dataset|Data|Relational|Workbook)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Infer what one physical row represents from local metadata and uniqueness.
 * Raw values never leave the browser; values are used only to compute ratios.
 */
export function inferRowGrain(
    rows: Record<string, any>[],
    columns: ColumnDefinition[],
    fileName: string,
    domain = 'Other',
    semantics: Record<string, ColumnSemantic> = {},
): RowGrainInference {
    const subject = tableSubject(fileName);
    const subjectTokens = subject.toLowerCase().split(/\s+/).filter(Boolean);
    const analysisRows = rows.length <= MAX_PROFILE_ROWS
        ? rows
        : Array.from({ length: MAX_PROFILE_ROWS }, (_, index) => rows[Math.floor(index * rows.length / MAX_PROFILE_ROWS)]);
    const candidates = columns
        .filter(column => isIdentifierLike(column, semantics[column.name]))
        .map((column, index) => {
            const stats = uniqueness(analysisRows, column.name);
            const stem = identifierStem(column.name);
            const matchesSubject = subjectTokens.some(token => token.length > 2 && stem.includes(token));
            const isReference = REFERENCE_STEMS.has(stem);
            let score = stats.ratio;
            if (/(?:_id|_key)$/i.test(column.name)) score += 0.18;
            if (semantics[column.name]?.semanticRole === 'identifier') score += 0.12;
            if (matchesSubject) score += 0.2;
            if (isReference && !matchesSubject) score -= 0.22;
            score -= index * 0.002;
            return { column, ...stats, stem, score, matchesSubject };
        })
        .filter(candidate => candidate.nonNull === 0 || candidate.nonNull >= Math.max(1, analysisRows.length * 0.8))
        .sort((left, right) => right.score - left.score);

    const unique = candidates.find(candidate => rows.length
        ? candidate.ratio >= 0.98
        : candidate.matchesSubject || !REFERENCE_STEMS.has(candidate.stem));
    if (unique) {
        const entity = (unique.matchesSubject ? subject : humanize(unique.stem)) || subject || 'Record';
        const confidence = rows.length
            ? Math.min(rows.length > analysisRows.length ? 0.9 : 0.98, Math.max(0.8, unique.score))
            : 0.72;
        return {
            label: entity,
            confidence,
            source: 'unique_identifier',
            evidence: rows.length
                ? [`${unique.column.name} identifies ${Math.round(unique.ratio * 100)}% unique non-empty rows${rows.length > analysisRows.length ? ' in a representative sample' : ''}`]
                : [`${unique.column.name} has identifier semantics`],
        };
    }

    // A fact row is often identified by a combination of repeated foreign keys.
    // Test small combinations only; this is bounded and runs during profiling.
    if (rows.length > 0 && candidates.length >= 2) {
        const usable = candidates.slice(0, 5);
        for (let size = 2; size <= Math.min(3, usable.length); size++) {
            const combo = usable.slice(0, size);
            const tuples = analysisRows.map(row => combo.map(candidate => String(row[candidate.column.name] ?? '')).join('\u001f'));
            const ratio = new Set(tuples).size / analysisRows.length;
            if (ratio >= 0.98) {
                const label = combo.map(candidate => humanize(candidate.stem)).join(' + ');
                return {
                    label: `${label} combination`,
                    confidence: 0.82,
                    source: 'composite_identifier',
                    evidence: [`${combo.map(candidate => candidate.column.name).join(' + ')} uniquely identifies rows together`],
                };
            }
        }
    }

    if (subject && subject.split(/\s+/).length <= 5) {
        return {
            label: /(?:record|entry|event|item|summary|transaction|order)$/i.test(subject) ? subject : `${subject} record`,
            confidence: 0.68,
            source: 'table_name',
            evidence: [`Inferred from the source table or file name: ${subject}`],
        };
    }

    return {
        label: `${humanize(domain) || 'Source'} record`,
        confidence: 0.55,
        source: 'fallback',
        evidence: ['No stable row identifier was found; using a neutral source-record grain'],
    };
}
