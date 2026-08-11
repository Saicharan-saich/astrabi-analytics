import { describe, expect, it } from 'vitest';
import { ALL_BENCHMARK_CASES, BENCHMARK_SUITES, compareResultSets } from '../services/benchmark';
import { createDuck } from './helpers/duckdbNode';

describe('AI SQL benchmark fixtures', () => {
  it('ships exactly three versioned suites with 50 cases each', () => {
    expect(BENCHMARK_SUITES).toHaveLength(3);
    expect(BENCHMARK_SUITES.map(suite => suite.cases.length)).toEqual([50, 50, 50]);
    expect(ALL_BENCHMARK_CASES).toHaveLength(150);
    expect(BENCHMARK_SUITES.every(suite => /^\d+\.\d+\.\d+$/.test(suite.version))).toBe(true);
  });

  it('has stable unique identifiers and questions inside every suite', () => {
    expect(new Set(ALL_BENCHMARK_CASES.map(testCase => testCase.id)).size).toBe(150);
    for (const suite of BENCHMARK_SUITES) {
      expect(new Set(suite.cases.map(testCase => testCase.question)).size).toBe(50);
      expect(suite.cases.every(testCase => testCase.suiteId === suite.id)).toBe(true);
    }
  });

  it('embeds read-only gold SQL, deterministic datasets, and frozen outputs', () => {
    const forbidden = /\b(insert|update|delete|drop|alter|create|truncate|attach|copy)\b/i;
    for (const testCase of ALL_BENCHMARK_CASES) {
      expect(testCase.goldSql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(forbidden.test(testCase.goldSql)).toBe(false);
      expect(testCase.dataset.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(testCase.expectedRows)).toBe(true);
      expect(testCase.dataset.domainProfile?.summary).toContain('Deterministic');
    }
  });

  it('labels compatibility packs honestly rather than claiming official scores', () => {
    for (const suite of BENCHMARK_SUITES) {
      expect(suite.name).toContain('Compatible');
      expect(suite.attribution.notice.toLowerCase()).toContain('not the official');
      expect(suite.attribution.notice.toLowerCase()).toContain('leaderboard');
    }
  });

  it('executes all 150 gold SQL queries and reproduces every frozen output', async () => {
    const duck = await createDuck();
    try {
      for (const suite of BENCHMARK_SUITES) {
        duck.loadTable('data', suite.cases[0].dataset.rows);
        for (const testCase of suite.cases) {
          const executed = duck.query(testCase.goldSql);
          const comparison = compareResultSets(testCase.expectedRows, executed, {
            ...testCase.comparison,
            strictColumns: true,
          });
          expect(comparison.equal, `${testCase.id}: ${comparison.reason}`).toBe(true);
        }
      }
    } finally {
      duck.close();
    }
  }, 60_000);
});
