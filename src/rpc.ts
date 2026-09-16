import { createPublicClient, http, type Chain, type PublicClient } from 'viem';

/**
 * Rate-limited RPC client factory.
 *
 * All clients created here share ONE limiter, because a single Alchemy key has a single
 * compute-units-per-second budget regardless of how many chains are being queried.
 *
 *   RPC_MAX_RPS        max requests per second across all chains (default 10)
 *   RPC_MAX_CONCURRENCY max in-flight requests across all chains (default 5)
 *   RPC_TIMEOUT_MS     per-request timeout (default 30000)
 *
 * On top of that, 429/5xx responses are retried with exponential backoff (1s, 2s, 4s, ... 7 tries).
 */
const MAX_RPS = Number(process.env.RPC_MAX_RPS ?? 10);
const MAX_CONCURRENCY = Number(process.env.RPC_MAX_CONCURRENCY ?? 5);
const TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 30_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window RPS limiter + concurrency cap. */
class Limiter {
  private stamps: number[] = [];
  private inFlight = 0;
  private waiting: (() => void)[] = [];

  async acquire(): Promise<void> {
    // Concurrency gate
    if (this.inFlight >= MAX_CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
    // RPS gate
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 1000);
      if (this.stamps.length < MAX_RPS) break;
      await sleep(this.stamps[0] + 1000 - now + 1);
    }
    this.stamps.push(Date.now());
  }

  release(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }
}

const limiter = new Limiter();

const limitedFetch: typeof fetch = async (input, init) => {
  await limiter.acquire();
  try {
    return await fetch(input, init);
  } finally {
    limiter.release();
  }
};

export function makeClient(chain: Chain, url: string): PublicClient {
  return createPublicClient({
    chain,
    transport: http(url, { fetchFn: limitedFetch, timeout: TIMEOUT_MS, retryCount: 7, retryDelay: 1000 }),
  });
}
