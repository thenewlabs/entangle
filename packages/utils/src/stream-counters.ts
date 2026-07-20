/**
 * How many retired stream ids to remember. Retirement is what keeps a torn-down
 * stream from silently resurrecting at counter 0 (see `retire`), so the set has
 * to be bounded or a long-lived session leaks one entry per stream forever.
 * Streams are agent-minted 64-bit random ids and `maxStreams` is small (1 by
 * default, 32 for Locus), so remembering the last 256 covers every in-flight
 * frame of every recently-closed stream by a wide margin.
 */
const MAX_RETIRED_SIDS = 256;

/**
 * Per-stream counter management for multi-stream protocol
 */
export class StreamCounters {
  private streamCounters = new Map<string, { incoming: number; outgoing: number }>();
  /** Stream ids that have been torn down. Insertion-ordered for FIFO eviction. */
  private retired = new Set<string>();

  /**
   * Get counter for a stream, creating if needed
   */
  private getStreamCounter(sid: string): { incoming: number; outgoing: number } {
    let counter = this.streamCounters.get(sid);
    if (!counter) {
      counter = { incoming: 0, outgoing: 0 };
      this.streamCounters.set(sid, counter);
    }
    return counter;
  }

  /**
   * Get next expected counter value
   */
  getNext(sid: string, direction: 'incoming' | 'outgoing'): number {
    const counter = this.getStreamCounter(sid);
    return counter[direction];
  }

  /**
   * Increment counter after successful validation
   */
  increment(sid: string, direction: 'incoming' | 'outgoing'): number {
    const counter = this.getStreamCounter(sid);
    const value = counter[direction];
    counter[direction]++;
    return value;
  }

  /**
   * Remove counters for a stream.
   *
   * This FORGETS the stream: the next frame carrying this sid recreates the
   * counter at 0. That is fine for a receiver that merely drops out-of-order
   * frames, but a receiver that ENFORCES the counter as a replay defense must
   * use `retire()` instead — see the note there.
   */
  removeStream(sid: string): void {
    this.streamCounters.delete(sid);
  }

  /**
   * Retire a stream: drop its counters AND remember that the id is dead.
   *
   * Retirement (not `removeStream`) is what a counter-enforcing receiver must
   * do at teardown, for two reasons:
   *
   *  1. Correctness. Teardown is unilateral — the agent retires a sid the moment
   *     its process exits or its pipe peer vanishes, while the client may still
   *     have frames in flight on that sid. Under `removeStream` those late
   *     frames recreate the counter at 0, so a frame that is merely LATE reads
   *     as the FIRST frame of a new stream bearing an impossible counter
   *     ("expected=0, received=26") — indistinguishable from injection.
   *  2. Security. Forgetting a counter RESETS it. If a fault or a close could
   *     zero a stream's counter, an attacker holding a captured frame history
   *     could force the reset and then replay that history from the beginning.
   *     A retired sid is never accepted again, so the counter for that sid can
   *     never go backwards. Agent-minted sids are 64-bit random and never
   *     reissued, so retirement is permanent within a session and no legitimate
   *     stream can ever collide with a retired id.
   */
  retire(sid: string): void {
    this.streamCounters.delete(sid);
    this.retired.add(sid);
    while (this.retired.size > MAX_RETIRED_SIDS) {
      const oldest = this.retired.values().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }

  /** Whether this stream id has been torn down and must never be accepted again. */
  isRetired(sid: string): boolean {
    return this.retired.has(sid);
  }

  /**
   * Get all stream IDs
   */
  getStreamIds(): string[] {
    return Array.from(this.streamCounters.keys());
  }

  /**
   * Clear all counters
   */
  clear(): void {
    this.streamCounters.clear();
    this.retired.clear();
  }
}