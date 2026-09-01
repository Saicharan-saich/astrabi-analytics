import type {
  BenchmarkComparisonOptions,
  BenchmarkComparisonResult,
} from './types';

const DEFAULT_ABSOLUTE_TOLERANCE = 1e-6;
const DEFAULT_RELATIVE_TOLERANCE = 1e-4;

const AGGREGATION_WORDS = new Set([
  'sum', 'total', 'avg', 'average', 'mean', 'count', 'distinct', 'min', 'minimum',
  'max', 'maximum', 'value', 'amount', 'metric', 'result',
]);

const STRONG_AGGREGATION_WORDS = new Set([
  'sum', 'total', 'avg', 'average', 'mean', 'count', 'min', 'minimum', 'max', 'maximum',
]);

function tokenizeColumn(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .split('_')
    .filter(Boolean);
}

export function canonicalColumnName(name: string): string {
  const tokens = tokenizeColumn(name).filter(token => !AGGREGATION_WORDS.has(token));
  return tokens.join('_') || tokenizeColumn(name).join('_');
}

function firstDefinedValue(rows: Record<string, unknown>[], column: string): unknown {
  for (const row of rows) {
    const value = row[column];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** Some imported benchmark fixtures contain a scalar serialized one extra
 * time (for example `"163"` represented as the string `\"163\"`). Unwrap
 * exactly one JSON scalar layer so fixture transport formatting cannot turn a
 * correct execution into a fixture error. Objects and arrays stay untouched. */
function normalizeScalar(value: unknown): unknown {
  // DuckDB-WASM/Arrow may expose BIGINT aggregates as a one-value typed
  // array in Node even though the browser path yields a scalar. Treat that
  // transport wrapper as the numeric scalar it represents.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const serialized = String(value).trim();
    if (serialized !== '' && Number.isFinite(Number(serialized))) return Number(serialized);
  }
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function typeFamily(value: unknown): 'number' | 'boolean' | 'string' | 'null' {
  value = normalizeScalar(value);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return 'number';
  return 'string';
}

function comparableValue(value: unknown): string {
  value = normalizeScalar(value);
  if (value === null || value === undefined) return 'null:';
  const family = typeFamily(value);
  if (family === 'number') return `number:${Number(value).toPrecision(12)}`;
  if (family === 'boolean') return `boolean:${Boolean(value) ? '1' : '0'}`;
  return `string:${String(value).trim().toLocaleLowerCase()}`;
}

/**
 * Estimate whether two result columns contain the same evidence without
 * depending on row order. This is used only to choose an alias mapping; the
 * final comparison below still checks every row and value with the configured
 * numeric tolerances.
 */
function columnValueOverlap(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  expectedColumn: string,
  actualColumn: string,
): number {
  const expectedValues = expectedRows
    .map(row => comparableValue(row[expectedColumn]))
    .filter(value => value !== 'null:');
  const actualCounts = new Map<string, number>();
  for (const row of actualRows) {
    const value = comparableValue(row[actualColumn]);
    if (value === 'null:') continue;
    actualCounts.set(value, (actualCounts.get(value) || 0) + 1);
  }
  if (!expectedValues.length) return 0;
  let matched = 0;
  for (const value of expectedValues) {
    const available = actualCounts.get(value) || 0;
    if (!available) continue;
    matched += 1;
    actualCounts.set(value, available - 1);
  }
  return matched / expectedValues.length;
}

function columnNameSimilarity(expected: string, actual: string): number {
  if (expected.toLowerCase() === actual.toLowerCase()) return 1;
  if (canonicalColumnName(expected) === canonicalColumnName(actual)) return 0.95;
  const expectedTokens = new Set(tokenizeColumn(expected).filter(token => !AGGREGATION_WORDS.has(token)));
  const actualTokens = new Set(tokenizeColumn(actual).filter(token => !AGGREGATION_WORDS.has(token)));
  if (!expectedTokens.size || !actualTokens.size) return 0;
  const intersection = [...expectedTokens].filter(token => actualTokens.has(token)).length;
  const union = new Set([...expectedTokens, ...actualTokens]).size;
  return union ? intersection / union : 0;
}

function buildColumnMapping(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  strictColumns: boolean,
): { mapping: Record<string, string>; error?: string } {
  const expectedColumns = expectedRows[0] ? Object.keys(expectedRows[0]) : [];
  const actualColumns = actualRows[0] ? Object.keys(actualRows[0]) : [];

  if (strictColumns && expectedColumns.length !== actualColumns.length) {
    return {
      mapping: {},
      error: `Expected ${expectedColumns.length} columns but received ${actualColumns.length}.`,
    };
  }

  const mapping: Record<string, string> = {};
  const unused = new Set(actualColumns);

  // Build all compatible edges first, then assign the strongest evidence
  // globally. The previous first-compatible strategy could map an expected
  // member ID to `first_name` merely because both were strings, even when a
  // later `member_id` column contained every expected value.
  const edges: Array<{ expected: string; actual: string; score: number }> = [];
  for (const expectedColumn of expectedColumns) {
    const expectedType = typeFamily(firstDefinedValue(expectedRows, expectedColumn));
    for (let actualIndex = 0; actualIndex < actualColumns.length; actualIndex += 1) {
      const actualColumn = actualColumns[actualIndex];
      const actualType = typeFamily(firstDefinedValue(actualRows, actualColumn));
      if (expectedType !== 'null' && actualType !== 'null' && expectedType !== actualType) continue;

      const nameScore = columnNameSimilarity(expectedColumn, actualColumn);
      const valueScore = columnValueOverlap(expectedRows, actualRows, expectedColumn, actualColumn);
      // Exact/canonical names lead; matching result evidence resolves aliases
      // such as link_to_member -> member_id and link_to_event -> event_link.
      const score = (nameScore * 1_000) + (valueScore * 700) + 20 - (actualIndex / 1_000);
      edges.push({ expected: expectedColumn, actual: actualColumn, score });
    }
  }

  edges.sort((left, right) => right.score - left.score
    || left.expected.localeCompare(right.expected)
    || left.actual.localeCompare(right.actual));
  const assignedExpected = new Set<string>();
  for (const edge of edges) {
    if (assignedExpected.has(edge.expected) || !unused.has(edge.actual)) continue;
    mapping[edge.expected] = edge.actual;
    assignedExpected.add(edge.expected);
    unused.delete(edge.actual);
  }

  const missing = expectedColumns.find(column => !mapping[column]);
  if (missing) {
    return { mapping, error: `No compatible result column was found for "${missing}".` };
  }

  return { mapping };
}

function numbersEqual(a: number, b: number, absoluteTolerance: number, relativeTolerance: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Object.is(a, b);
  const difference = Math.abs(a - b);
  if (difference <= absoluteTolerance) return true;
  return difference <= relativeTolerance * Math.max(Math.abs(a), Math.abs(b), 1);
}

function valuesEqual(
  expected: unknown,
  actual: unknown,
  absoluteTolerance: number,
  relativeTolerance: number,
): boolean {
  expected = normalizeScalar(expected);
  actual = normalizeScalar(actual);
  if ((expected === null || expected === undefined) && (actual === null || actual === undefined)) return true;

  const expectedType = typeFamily(expected);
  const actualType = typeFamily(actual);
  if (expectedType === 'number' && actualType === 'number') {
    return numbersEqual(Number(expected), Number(actual), absoluteTolerance, relativeTolerance);
  }
  if (expectedType === 'boolean' && actualType === 'number') return Number(actual) === (expected ? 1 : 0);
  if (expectedType === 'number' && actualType === 'boolean') return Number(expected) === (actual ? 1 : 0);

  return String(expected ?? '').trim().toLocaleLowerCase() === String(actual ?? '').trim().toLocaleLowerCase();
}

function rowsEqual(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  mapping: Record<string, string>,
  absoluteTolerance: number,
  relativeTolerance: number,
): boolean {
  return Object.entries(mapping).every(([expectedColumn, actualColumn]) =>
    valuesEqual(expected[expectedColumn], actual[actualColumn], absoluteTolerance, relativeTolerance)
  );
}

function isAggregateEvidenceColumn(name: string): boolean {
  return tokenizeColumn(name).some(token => STRONG_AGGREGATION_WORDS.has(token));
}

function isNeutralAggregateValue(value: unknown): boolean {
  value = normalizeScalar(value);
  if (value === null || value === undefined) return true;
  return typeFamily(value) === 'number' && Number(value) === 0;
}

export function compareResultSets(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  options: BenchmarkComparisonOptions,
): BenchmarkComparisonResult {
  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const actual = Array.isArray(actualRows) ? actualRows : [];
  const resultBase = {
    expectedRowCount: expected.length,
    actualRowCount: actual.length,
    columnMapping: {} as Record<string, string>,
  };

  if (expected.length !== actual.length) {
    return {
      ...resultBase,
      equal: false,
      reason: `Expected ${expected.length} rows but received ${actual.length}.`,
      firstMismatch: { expected: expected[0] || {}, actual: actual[0] },
    };
  }

  if (expected.length === 0) {
    return { ...resultBase, equal: true, reason: 'Both result sets are empty.' };
  }

  const { mapping, error } = buildColumnMapping(expected, actual, Boolean(options.strictColumns));
  if (error) {
    return { ...resultBase, columnMapping: mapping, equal: false, reason: error };
  }

  const absoluteTolerance = options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE;
  const relativeTolerance = options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;

  if (options.orderMatters) {
    for (let index = 0; index < expected.length; index += 1) {
      if (!rowsEqual(expected[index], actual[index], mapping, absoluteTolerance, relativeTolerance)) {
        return {
          ...resultBase,
          columnMapping: mapping,
          equal: false,
          reason: `The ordered result differs at row ${index + 1}.`,
          firstMismatch: { expected: expected[index], actual: actual[index] },
        };
      }
    }
  } else {
    const unmatched = new Set(actual.map((_, index) => index));
    for (const expectedRow of expected) {
      const match = [...unmatched].find(index =>
        rowsEqual(expectedRow, actual[index], mapping, absoluteTolerance, relativeTolerance)
      );
      if (match === undefined) {
        return {
          ...resultBase,
          columnMapping: mapping,
          equal: false,
          reason: 'At least one expected row was not present in the candidate result.',
          firstMismatch: { expected: expectedRow },
        };
      }
      unmatched.delete(match);
    }
  }

  return {
    ...resultBase,
    columnMapping: mapping,
    equal: true,
    equivalenceRule: 'exact_result_set',
    reason: options.orderMatters
      ? 'Values and row order match the gold output.'
      : 'Values match the gold output (row order ignored).',
  };
}

/**
 * Compare the answer at the projection explicitly requested by the user.
 *
 * Public benchmark gold SQL often exposes an aggregate that is needed to
 * qualify or order entities even when the wording asks only for the entity
 * labels. For example, "Which industries have average satisfaction >= 70?"
 * is completely answered by the qualifying industries; AVG(...) is predicate
 * evidence, not a requested display column. The production query contract
 * already resolves that distinction from the question and physical schema.
 *
 * This is deliberately narrower than general subset matching:
 *  - every contract-requested field must exist in the frozen gold output;
 *  - the complete row set must match at that requested projection;
 *  - a missing field that the contract asks to display still fails; and
 *  - without grounded requested fields, ordinary strict comparison wins.
 */
export function compareResultSetsAtRequestedProjection(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  options: BenchmarkComparisonOptions,
  requestedOutputFields: readonly unknown[] = [],
): BenchmarkComparisonResult {
  const direct = compareResultSets(expectedRows, actualRows, options);
  if (direct.equal || !expectedRows.length || !actualRows.length || !requestedOutputFields.length) {
    return direct;
  }

  const expectedColumns = Object.keys(expectedRows[0]);
  const requested = [...new Set(requestedOutputFields.map(field => {
    if (typeof field === 'string') return field.trim();
    if (!field || typeof field !== 'object' || Array.isArray(field)) return '';
    const descriptor = field as Record<string, unknown>;
    const candidate = descriptor.field ?? descriptor.column ?? descriptor.name ?? descriptor.expression;
    return typeof candidate === 'string' ? candidate.trim() : '';
  }).filter(Boolean))];
  // An unusable runtime descriptor is not evidence for relaxed projection.
  // Fall back to the ordinary strict comparison instead of throwing or
  // silently accepting an incomplete answer.
  if (!requested.length) return direct;
  const projectedColumns: string[] = [];
  for (const field of requested) {
    const exact = expectedColumns.find(column => column.toLowerCase() === field.toLowerCase());
    const canonical = expectedColumns.find(column => canonicalColumnName(column) === canonicalColumnName(field));
    const match = exact || canonical;
    if (!match || projectedColumns.includes(match)) return direct;
    projectedColumns.push(match);
  }

  // There is no relaxed projection when the contract requires every gold
  // column. This keeps ordinary execution equivalence unchanged.
  if (projectedColumns.length >= expectedColumns.length) return direct;

  const projectedExpected = expectedRows.map(row => Object.fromEntries(
    projectedColumns.map(column => [column, row[column]]),
  ));
  const projected = compareResultSets(projectedExpected, actualRows, {
    ...options,
    strictColumns: false,
  });
  if (!projected.equal) return direct;

  return {
    ...projected,
    equivalenceRule: 'requested_projection',
    reason: `The complete requested projection matched (${projectedColumns.join(', ')}); ${expectedColumns.length - projectedColumns.length} gold helper column${expectedColumns.length - projectedColumns.length === 1 ? '' : 's'} was not requested for display.`,
  };
}

type AggregateHelper = {
  aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max';
  measureTokens: string[];
};

function aggregateHelperFromColumn(column: string): AggregateHelper | undefined {
  const tokens = tokenizeColumn(column);
  const aggregateToken = tokens.find(token => STRONG_AGGREGATION_WORDS.has(token));
  const aggregation = aggregateToken === 'average' || aggregateToken === 'mean' ? 'avg'
    : aggregateToken === 'total' ? 'sum'
      : aggregateToken === 'minimum' ? 'min'
        : aggregateToken === 'maximum' ? 'max'
          : aggregateToken as AggregateHelper['aggregation'] | undefined;
  if (!aggregation || !['avg', 'sum', 'count', 'min', 'max'].includes(aggregation)) return undefined;

  const functionArgument = column.match(/\b(?:avg|average|mean|sum|total|count|min|minimum|max|maximum)\s*\(([^)]*)\)/i)?.[1];
  const measureTokens = tokenizeColumn(functionArgument || column)
    .filter(token => !AGGREGATION_WORDS.has(token) && token !== 'star' && !/^t\d+$/.test(token));
  return { aggregation, measureTokens };
}

function sqlUsesAggregateHelper(sql: string, helper: AggregateHelper): boolean {
  const calls = [...sql.matchAll(/\b(avg|sum|count|min|max)\s*\(([^)]*)\)/gi)];
  return calls.some(match => {
    if (match[1].toLowerCase() !== helper.aggregation) return false;
    if (helper.aggregation === 'count' && helper.measureTokens.length === 0) return true;
    const argumentTokens = new Set(tokenizeColumn(match[2]));
    return helper.measureTokens.length > 0
      && helper.measureTokens.every(token => argumentTokens.has(token));
  });
}

function questionExplicitlyRequestsHelper(question: string, helper: AggregateHelper): boolean {
  const aggregateWords = helper.aggregation === 'avg' ? '(?:average|avg|mean)'
    : helper.aggregation === 'sum' ? '(?:total|sum)'
      : helper.aggregation === 'count' ? '(?:count|number|how many)'
        : helper.aggregation === 'min' ? '(?:minimum|min)'
          : '(?:maximum|max)';
  return new RegExp(`\\b(?:and|along with|together with)\\s+(?:(?:its|their|the|corresponding)\\s+)?${aggregateWords}\\b`, 'i').test(question)
    || new RegExp(`^\\s*(?:(?:what|which)\\s+(?:is|are)|calculate|compute|find|show|list|return|display|give(?:\\s+me)?)\\s+(?:the\\s+)?${aggregateWords}\\b`, 'i').test(question)
    || new RegExp(`\\b${aggregateWords}\\b[\\s\\S]*?\\b(?:for|by|per)\\s+(?:each|every)\\b`, 'i').test(question)
    || new RegExp(`^\\s*(?:show|list|return|display|give(?:\\s+me)?)\\b[\\s\\S]*?\\bwith\\s+(?:(?:its|their|the|corresponding)\\s+)?${aggregateWords}\\b`, 'i').test(question);
}

/**
 * Benchmark-only semantic comparison for a complete user-facing answer whose
 * frozen gold output also exposes an aggregate used solely to rank or qualify
 * the returned entities. This is deliberately evidence-bound: the candidate
 * SQL must contain the omitted aggregate over the matching measure, every
 * entity row must match, duplicates still fail, and explicitly requested
 * aggregate values may not be omitted.
 */
export function compareResultSetsAsUserAnswer(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  options: BenchmarkComparisonOptions,
  requestedOutputFields: readonly unknown[] = [],
  context: { question: string; candidateSql: string } = { question: '', candidateSql: '' },
): BenchmarkComparisonResult {
  const grounded = compareResultSetsAtRequestedProjection(
    expectedRows,
    actualRows,
    options,
    requestedOutputFields,
  );
  if (grounded.equal || !expectedRows.length || !actualRows.length || !context.candidateSql.trim()) return grounded;

  const expectedColumns = Object.keys(expectedRows[0]);
  const { mapping } = buildColumnMapping(expectedRows, actualRows, false);
  const mappedExpectedColumns = Object.keys(mapping);
  const missingExpectedColumns = expectedColumns.filter(column => !mapping[column]);
  if (!mappedExpectedColumns.length || !missingExpectedColumns.length) return grounded;

  // At least one non-aggregate answer field must remain visible. A candidate
  // returning only a helper metric cannot stand in for a missing entity label.
  if (!mappedExpectedColumns.some(column => !aggregateHelperFromColumn(column))) return grounded;

  const omittedHelpers = missingExpectedColumns.map(column => ({
    column,
    helper: aggregateHelperFromColumn(column),
  }));
  if (omittedHelpers.some(item => !item.helper
    || questionExplicitlyRequestsHelper(context.question, item.helper)
    || !sqlUsesAggregateHelper(context.candidateSql, item.helper))) {
    return grounded;
  }

  const projectedExpected = expectedRows.map(row => Object.fromEntries(
    mappedExpectedColumns.map(column => [column, row[column]]),
  ));
  const projected = compareResultSets(projectedExpected, actualRows, {
    ...options,
    orderMatters: false,
    strictColumns: false,
  });
  if (!projected.equal) return grounded;

  return {
    ...projected,
    equivalenceRule: 'verified_helper_projection',
    reason: `The complete requested answer matched (${mappedExpectedColumns.join(', ')}); omitted gold helper column(s) ${missingExpectedColumns.join(', ')} were verified in candidate SQL and were not explicitly requested for display.`,
  };
}

/**
 * Conservative second-pass comparator for answers withheld by the product
 * safety contract. It accepts all normal result-set equivalences and one
 * additional, explainable case: the candidate contains every gold row plus
 * only zero/null aggregate rows for additional entities (for example a LEFT
 * JOIN that includes teachers with zero courses).
 *
 * It deliberately does not accept duplicate grain, partial containment,
 * scalar roll-ups, or non-neutral extra rows. Those remain genuine failures.
 */
export function compareWithheldResultSets(
  expectedRows: Record<string, unknown>[],
  actualRows: Record<string, unknown>[],
  options: BenchmarkComparisonOptions,
): BenchmarkComparisonResult {
  const direct = compareResultSets(expectedRows, actualRows, {
    ...options,
    orderMatters: false,
    strictColumns: false,
  });
  if (direct.equal) return direct;

  const expected = Array.isArray(expectedRows) ? expectedRows : [];
  const actual = Array.isArray(actualRows) ? actualRows : [];
  const resultBase = {
    expectedRowCount: expected.length,
    actualRowCount: actual.length,
    columnMapping: {} as Record<string, string>,
  };
  if (!expected.length || actual.length <= expected.length) return direct;

  const { mapping, error } = buildColumnMapping(expected, actual, false);
  if (error) return { ...resultBase, equal: false, reason: error, columnMapping: mapping };

  const aggregateColumns = Object.keys(mapping).filter(isAggregateEvidenceColumn);
  if (!aggregateColumns.length) return direct;

  const absoluteTolerance = options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE;
  const relativeTolerance = options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  const unmatched = new Set(actual.map((_, index) => index));
  for (const expectedRow of expected) {
    const match = [...unmatched].find(index =>
      rowsEqual(expectedRow, actual[index], mapping, absoluteTolerance, relativeTolerance)
    );
    if (match === undefined) return direct;
    unmatched.delete(match);
  }

  const neutralExtras = [...unmatched].every(index =>
    aggregateColumns.every(expectedColumn =>
      isNeutralAggregateValue(actual[index][mapping[expectedColumn]])
    )
  );
  if (!neutralExtras) return direct;

  return {
    ...resultBase,
    equal: true,
    columnMapping: mapping,
    equivalenceRule: 'neutral_extra_rows',
    reason: `All gold rows matched; ${unmatched.size} additional candidate row${unmatched.size === 1 ? '' : 's'} contained only zero/null aggregate evidence.`,
  };
}
