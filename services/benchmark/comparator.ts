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
    reason: options.orderMatters
      ? 'Values and row order match the gold output.'
      : 'Values match the gold output (row order ignored).',
  };
}
