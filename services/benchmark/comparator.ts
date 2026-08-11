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

function typeFamily(value: unknown): 'number' | 'boolean' | 'string' | 'null' {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return 'number';
  return 'string';
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

  for (const expectedColumn of expectedColumns) {
    const expectedCanonical = canonicalColumnName(expectedColumn);
    const exact = actualColumns.find(column => unused.has(column) && column.toLowerCase() === expectedColumn.toLowerCase());
    if (exact) {
      mapping[expectedColumn] = exact;
      unused.delete(exact);
      continue;
    }

    const canonical = actualColumns.find(column => unused.has(column) && canonicalColumnName(column) === expectedCanonical);
    if (canonical) {
      mapping[expectedColumn] = canonical;
      unused.delete(canonical);
      continue;
    }

    const expectedType = typeFamily(firstDefinedValue(expectedRows, expectedColumn));
    const compatible = actualColumns.find(column => {
      if (!unused.has(column)) return false;
      const actualType = typeFamily(firstDefinedValue(actualRows, column));
      return expectedType === 'null' || actualType === 'null' || expectedType === actualType;
    });

    if (!compatible) {
      return { mapping, error: `No compatible result column was found for "${expectedColumn}".` };
    }

    mapping[expectedColumn] = compatible;
    unused.delete(compatible);
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
