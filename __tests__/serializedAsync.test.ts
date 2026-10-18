import { describe, expect, it } from 'vitest';
import { createSerializedAsyncQueue } from '../utils/serializedAsync';

describe('shared DuckDB operation queue', () => {
  it('does not let a second table load run before the first query finishes', async () => {
    const exclusive = createSerializedAsyncQueue();
    const order: string[] = [];
    let finishFirst!: () => void;
    const gate = new Promise<void>(resolve => { finishFirst = resolve; });
    const first = exclusive(async () => { order.push('load first'); await gate; order.push('query first'); });
    const second = exclusive(async () => { order.push('load second'); order.push('query second'); });
    await Promise.resolve();
    expect(order).toEqual(['load first']);
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['load first', 'query first', 'load second', 'query second']);
  });

  it('releases the queue after a failed operation', async () => {
    const exclusive = createSerializedAsyncQueue();
    await expect(exclusive(async () => { throw new Error('failed load'); })).rejects.toThrow('failed load');
    await expect(exclusive(async () => 42)).resolves.toBe(42);
  });
});
