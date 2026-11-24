import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter";

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

describe("RateLimiter", () => {
  it("spaces call starts by at least the interval (Nominatim 1 req/s)", async () => {
    const c = fakeClock();
    const rl = new RateLimiter(1000, c.now, c.sleep);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => rl.schedule(async () => starts.push(c.now()))));
    expect(starts).toEqual([0, 1000, 2000]);
  });
  it("does not wait when enough time has passed", async () => {
    const c = fakeClock();
    const rl = new RateLimiter(1000, c.now, c.sleep);
    await rl.schedule(async () => 1);
    c.advance(5000);
    await rl.schedule(async () => 2);
    expect(c.sleeps).toEqual([]);
  });
  it("serialises calls (never concurrent) and survives a rejected call", async () => {
    const c = fakeClock();
    const rl = new RateLimiter(10, c.now, c.sleep);
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    };
    const failing = rl.schedule(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await Promise.all([rl.schedule(task), rl.schedule(task), rl.schedule(task)]);
    expect(maxActive).toBe(1);
  });
  it("rejects a negative interval", () => {
    expect(() => new RateLimiter(-1)).toThrow();
  });
});
