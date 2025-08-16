/**
 * Per-stream counter management for multi-stream protocol
 */
export class StreamCounters {
  private streamCounters = new Map<string, { incoming: number; outgoing: number }>();

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
   * Remove counters for a stream
   */
  removeStream(sid: string): void {
    this.streamCounters.delete(sid);
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
  }
}