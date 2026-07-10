import { getConfig, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

interface Bucket {
  tokens: number;
  lastRefill: number;
  strikes: number;
  cooldownUntil?: number;
  lastRejection?: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterMs?: number;
}

// Hard cap on tracked IPs so a flood of distinct source IPs can't grow the map
// without bound. When exceeded, the oldest-touched buckets are evicted.
const MAX_BUCKETS = 50_000;

export class PerIpRateLimiter {
  private buckets = new Map<string, Bucket>();

  check(ip: string): RateDecision {
    const { relayRateRps, relayBurst } = getConfig();
    const now = Date.now();

    this.evictIfNeeded(now);

    const bucket = this.buckets.get(ip) || {
      tokens: relayBurst,
      lastRefill: now,
      strikes: 0,
    } as Bucket;

    // Refill tokens
    const elapsed = Math.max(0, now - bucket.lastRefill);
    const refill = (relayRateRps * elapsed) / 1000;
    bucket.tokens = Math.min(relayBurst, bucket.tokens + refill);
    bucket.lastRefill = now;

    // Respect cooldown (exponential backoff)
    if (bucket.cooldownUntil && now < bucket.cooldownUntil) {
      const decision = { allowed: false, retryAfterMs: bucket.cooldownUntil - now } as RateDecision;
      this.buckets.set(ip, bucket);
      return decision;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;

      // Decay strikes if enough time passed since last rejection
      if (bucket.lastRejection && now - bucket.lastRejection > 60_000 && bucket.strikes > 0) {
        bucket.strikes = Math.max(0, bucket.strikes - 1);
      }

      this.buckets.set(ip, bucket);
      return { allowed: true };
    }

    // Out of tokens: apply strike and cooldown
    bucket.strikes += 1;
    bucket.lastRejection = now;
    // Backoff grows exponentially up to 60s
    const backoffMs = Math.min(60_000, Math.pow(2, Math.min(10, bucket.strikes)) * 100);
    bucket.cooldownUntil = now + backoffMs;
    this.buckets.set(ip, bucket);

    output.warn(`WS upgrade rate-limited for IP ${ip}: strikes=${bucket.strikes}, backoff=${backoffMs}ms`);
    return { allowed: false, retryAfterMs: backoffMs };
  }

  /**
   * Keep the bucket map bounded. Only acts once the map reaches the hard cap,
   * then evicts oldest-inserted, non-cooldown buckets down to a low-water mark.
   * A Map iterates in insertion order, so this is amortized O(1) per check
   * (each bucket is created once and evicted at most once) — no per-call scan.
   * Buckets in active cooldown are retained so eviction can't reset a
   * misbehaving IP's backoff.
   */
  private evictIfNeeded(now: number): void {
    if (this.buckets.size < MAX_BUCKETS) return;

    const target = Math.floor(MAX_BUCKETS * 0.9);
    for (const [ip, b] of this.buckets) {
      if (this.buckets.size <= target) break;
      const inCooldown = b.cooldownUntil && now < b.cooldownUntil;
      if (!inCooldown && now - b.lastRefill > 0) this.buckets.delete(ip);
    }
  }
}

export const wsRateLimiter = new PerIpRateLimiter();

