import { describe, expect, it } from 'vitest';
import {
  canonicalColumnName,
  compareResultSets,
  compareResultSetsAsUserAnswer,
  compareResultSetsAtRequestedProjection,
  compareWithheldResultSets,
} from '../services/benchmark';

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

  it('normalizes DuckDB Arrow typed-array wrappers for integer aggregates', () => {
    const result = compareResultSets(
      [{ total_quantity: 108 }],
      [{ total_quantity: new Uint32Array([108]) }],
      { orderMatters: false, strictColumns: true },
    );
    expect(result.equal).toBe(true);
  });

  it('accepts only neutral aggregate rows in the withheld semantic re-check', () => {
    const expected = [
      { teacher_name: 'Anne', course_count: 2 },
      { teacher_name: 'Gustaaf', course_count: 1 },
    ];
    const withZeroEntity = [
      ...expected,
      { teacher_name: 'Joseph', course_count: 0 },
    ];
    const withNonNeutralEntity = [
      ...expected,
      { teacher_name: 'Joseph', course_count: 1 },
    ];

    const accepted = compareWithheldResultSets(expected, withZeroEntity, { orderMatters: false });
    expect(accepted.equal).toBe(true);
    expect(accepted.equivalenceRule).toBe('neutral_extra_rows');
    expect(compareWithheldResultSets(expected, withNonNeutralEntity, { orderMatters: false }).equal).toBe(false);
  });

  it('does not hide duplicate-grain errors during the withheld re-check', () => {
    const expected = [{ grade: 9 }, { grade: 10 }];
    const duplicated = [{ grade: 9 }, { grade: 9 }, { grade: 10 }, { grade: 10 }];
    expect(compareWithheldResultSets(expected, duplicated, { orderMatters: false }).equal).toBe(false);
  });

  it('accepts a complete entity answer when gold includes an unrequested HAVING helper', () => {
    const expected = [
      { industry: 'Healthcare', average_satisfaction_score: 70 },
      { industry: 'Finance', average_satisfaction_score: 77 },
      { industry: 'Education', average_satisfaction_score: 74.833333 },
    ];
    const actual = [
      { industry: 'Healthcare' },
      { industry: 'Finance' },
      { industry: 'Education' },
    ];

    const result = compareResultSetsAtRequestedProjection(
      expected,
      actual,
      { orderMatters: false },
      ['industry'],
    );
    expect(result.equal).toBe(true);
    expect(result.equivalenceRule).toBe('requested_projection');
  });

  it('still requires an aggregate when the answer contract asks to display it', () => {
    const expected = [{ industry: 'Finance', average_satisfaction_score: 77 }];
    const actual = [{ industry: 'Finance' }];
    const result = compareResultSetsAtRequestedProjection(
      expected,
      actual,
      { orderMatters: false },
      ['industry', 'satisfaction_score'],
    );
    expect(result.equal).toBe(false);
    expect(result.reason).toContain('average_satisfaction_score');
  });

  it('does not accept an incomplete entity set at the requested projection', () => {
    const expected = [
      { industry: 'Healthcare', average_satisfaction_score: 70 },
      { industry: 'Finance', average_satisfaction_score: 77 },
    ];
    const actual = [{ industry: 'Finance' }];
    const result = compareResultSetsAtRequestedProjection(
      expected,
      actual,
      { orderMatters: false },
      ['industry'],
    );
    expect(result.equal).toBe(false);
    expect(result.reason).toContain('Expected 2 rows');
  });

  it('accepts a complete ranking answer when an unrequested gold metric is proven in candidate SQL', () => {
    const expected = [
      { product_name: 'Atlas Laptop', average_delivery_days: 4 },
      { product_name: 'Delta Printer', average_delivery_days: 4 },
      { product_name: 'Beacon Desk', average_delivery_days: 5 },
      { product_name: 'Echo Binder', average_delivery_days: 5 },
      { product_name: 'Cedar Chair', average_delivery_days: 6 },
    ];
    const actual = [
      { product_name: 'Delta Printer' },
      { product_name: 'Atlas Laptop' },
      { product_name: 'Echo Binder' },
      { product_name: 'Beacon Desk' },
      { product_name: 'Cedar Chair' },
    ];
    const result = compareResultSetsAsUserAnswer(
      expected,
      actual,
      { orderMatters: false },
      [],
      {
        question: 'Which 5 products have the shortest average delivery time?',
        candidateSql: 'SELECT product_name FROM data GROUP BY product_name ORDER BY AVG(delivery_days) ASC LIMIT 5',
      },
    );

    expect(result.equal).toBe(true);
    expect(result.equivalenceRule).toBe('verified_helper_projection');
  });

  it('accepts qualifying entities when the unrequested gold metric is proven in HAVING', () => {
    const result = compareResultSetsAsUserAnswer(
      [
        { industry: 'Healthcare', average_satisfaction_score: 70 },
        { industry: 'Finance', average_satisfaction_score: 77 },
        { industry: 'Education', average_satisfaction_score: 74.833333 },
      ],
      [
        { industry: 'Healthcare' },
        { industry: 'Finance' },
        { industry: 'Education' },
      ],
      { orderMatters: false },
      [],
      {
        question: 'Which industries have average satisfaction score at least 70?',
        candidateSql: 'SELECT industry FROM data GROUP BY industry HAVING AVG(satisfaction_score) >= 70',
      },
    );

    expect(result.equal).toBe(true);
    expect(result.equivalenceRule).toBe('verified_helper_projection');
  });

  it('does not forgive an omitted aggregate that the question explicitly asks to display', () => {
    const result = compareResultSetsAsUserAnswer(
      [{ country: 'Italy', channel_count: 12 }],
      [{ country: 'Italy' }],
      { orderMatters: false },
      [],
      {
        question: 'Which country has the most TV channels and how many does it have?',
        candidateSql: 'SELECT country FROM data GROUP BY country ORDER BY COUNT(*) DESC LIMIT 1',
      },
    );

    expect(result.equal).toBe(false);
  });

  it('does not forgive an omitted aggregate when it is the primary requested answer', () => {
    const result = compareResultSetsAsUserAnswer(
      [{ pet_type: 'cat', average_weight: 12 }],
      [{ pet_type: 'cat' }],
      { orderMatters: false },
      [],
      {
        question: 'What is the average weight for each type of pet?',
        candidateSql: 'SELECT pet_type FROM data GROUP BY pet_type ORDER BY AVG(weight)',
      },
    );

    expect(result.equal).toBe(false);
  });

  it('does not forgive a missing helper unless candidate SQL proves the calculation', () => {
    const result = compareResultSetsAsUserAnswer(
      [{ product_name: 'Atlas Laptop', average_delivery_days: 4 }],
      [{ product_name: 'Atlas Laptop' }],
      { orderMatters: false },
      [],
      {
        question: 'Which product has the shortest average delivery time?',
        candidateSql: 'SELECT product_name FROM data LIMIT 1',
      },
    );

    expect(result.equal).toBe(false);
  });

  it('does not forgive duplicate entity rows while omitting a gold helper', () => {
    const result = compareResultSetsAsUserAnswer(
      [{ event_name: 'Football game', event_count: 2 }],
      [{ event_name: 'Football game' }, { event_name: 'Football game' }],
      { orderMatters: false },
      [],
      {
        question: 'Which event appears most often?',
        candidateSql: 'SELECT event_name FROM data ORDER BY COUNT(*) DESC',
      },
    );

    expect(result.equal).toBe(false);
  });
});
