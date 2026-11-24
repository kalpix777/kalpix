export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialises calls and guarantees at least `minIntervalMs` between the START of consecutive calls
 * (Nominatim: 1 req/s; Overpass: one request at a time). In-process only: run one worker per
 * provider, which is how apps/worker is designed.
 */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    if (!(minIntervalMs >= 0)) throw new Error("minIntervalMs must be >= 0");
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return fn();
    };
    const result = this.chain.then(run, run);
    // Keep the chain alive even if fn rejects.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
