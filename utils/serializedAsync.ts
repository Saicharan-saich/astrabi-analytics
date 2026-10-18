/** Keep async operations on a shared mutable resource from interleaving. */
export function createSerializedAsyncQueue() {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}
