import { describe, expect, it } from 'vitest';
import { canonicalColumnName, compareResultSets } from '../services/benchmark';

describe('benchmark result comparator', () => {
  it('normalizes common aggregate aliases and numeric representations', () => {
    const result = compareResultSets(
      [{ region: 'North', total_sales: 100.5 }],
      [{ REGION: 'north', sum_sales: '100.500001' }],
      { orderMatters: false, relativeTolerance: 1e-4 },
    );
    expect(result.equal).toBe(true);
    expect(result.columnMapping).toEqual({ region: 'REGION', total_sales: 'sum_sales' });
  });

  it('ignores harmless extra evidence columns in semantic mode', () => {
    const result = compareResultSets(
      [{ product_name: 'Atlas', total_sales: 42 }],
      [{ product_name: 'Atlas', product_id: 'P-1', total_sales: 42 }],
      { orderMatters: false, strictColumns: false },
    );
    expect(result.equal).toBe(true);
  });

  it('maps expected identifiers to matching evidence instead of the first string column', () => {
    const result = compareResultSets(
      [
        { link_to_member: 'member-1', link_to_event: 'event-a' },
        { link_to_member: 'member-2', link_to_event: 'event-b' },
      ],
      [
        { member_first_name: 'Ada', member_last_name: 'Lovelace', event_link: 'event-a', member_id: 'member-1' },
        { member_first_name: 'Grace', member_last_name: 'Hopper', event_link: 'event-b', member_id: 'member-2' },
      ],
      { orderMatters: false, strictColumns: false },
    );

    expect(result.equal).toBe(true);
    expect(result.columnMapping).toEqual({
      link_to_member: 'member_id',
      link_to_event: 'event_link',
    });
  });

  it('honours order only when the gold case declares it significant', () => {
    const expected = [{ category: 'A', total: 10 }, { category: 'B', total: 5 }];
    const reversed = [...expected].reverse();
    expect(compareResultSets(expected, reversed, { orderMatters: false }).equal).toBe(true);
    expect(compareResultSets(expected, reversed, { orderMatters: true }).equal).toBe(false);
  });

  it('fails on wrong row counts and wrong values with an actionable reason', () => {
    const rowCount = compareResultSets([{ value: 1 }], [], { orderMatters: false });
    expect(rowCount.equal).toBe(false);
    expect(rowCount.reason).toContain('Expected 1 rows');

    const wrongValue = compareResultSets([{ value: 1 }], [{ value: 2 }], { orderMatters: false });
    expect(wrongValue.equal).toBe(false);
    expect(wrongValue.firstMismatch?.expected).toEqual({ value: 1 });
  });

  it('produces stable canonical aggregate names', () => {
    expect(canonicalColumnName('SUM Sales')).toBe('sales');
    expect(canonicalColumnName('total_sales')).toBe('sales');
    expect(canonicalColumnName('AverageResolutionHours')).toBe('resolution_hours');
  });

  it('unwraps one accidentally JSON-encoded scalar layer in imported fixtures', () => {
    const result = compareResultSets(
      [{ score: '"163"', delta: '"-12.5"' }],
      [{ score: 163, delta: -12.5 }],
      { orderMatters: false },
    );
    expect(result.equal).toBe(true);
  });
});
