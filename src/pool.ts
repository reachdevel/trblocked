/** Counting semaphore: at most `permits` concurrent `run` callbacks. */
export class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (permits < 1) throw new RangeError("Semaphore needs at least one permit");
    this.free = permits;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve)); // permit is handed over directly
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** Map with bounded concurrency; results keep input order. `fn` must not throw (wrap it) or the pool rejects. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}
