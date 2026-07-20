import { describe, it, expect } from 'vitest';
import { StreamCounters } from '../packages/utils/src/stream-counters.js';

describe('StreamCounters', () => {
  it('should track counters per stream independently', () => {
    const counters = new StreamCounters();
    
    // Stream 1
    expect(counters.getNext('stream1', 'incoming')).toBe(0);
    expect(counters.increment('stream1', 'incoming')).toBe(0);
    expect(counters.getNext('stream1', 'incoming')).toBe(1);
    expect(counters.increment('stream1', 'incoming')).toBe(1);
    expect(counters.getNext('stream1', 'incoming')).toBe(2);
    
    // Stream 2 - independent counters
    expect(counters.getNext('stream2', 'incoming')).toBe(0);
    expect(counters.increment('stream2', 'incoming')).toBe(0);
    expect(counters.increment('stream2', 'incoming')).toBe(1);
    expect(counters.getNext('stream2', 'incoming')).toBe(2);
    
    // Stream 1 remains unchanged
    expect(counters.getNext('stream1', 'incoming')).toBe(2);
    
    // Outgoing counters are separate
    expect(counters.getNext('stream1', 'outgoing')).toBe(0);
    expect(counters.increment('stream1', 'outgoing')).toBe(0);
    expect(counters.getNext('stream1', 'outgoing')).toBe(1);
  });

  it('should remove stream counters', () => {
    const counters = new StreamCounters();
    
    // Set up some counters
    counters.increment('stream1', 'incoming');
    counters.increment('stream1', 'incoming');
    counters.increment('stream1', 'outgoing');
    
    expect(counters.getNext('stream1', 'incoming')).toBe(2);
    expect(counters.getNext('stream1', 'outgoing')).toBe(1);
    
    // Remove the stream
    counters.removeStream('stream1');
    
    // Counters should be reset
    expect(counters.getNext('stream1', 'incoming')).toBe(0);
    expect(counters.getNext('stream1', 'outgoing')).toBe(0);
  });

  describe('retirement (replay defense)', () => {
    it('retire() does NOT reset the counter the way removeStream() does', () => {
      const counters = new StreamCounters();
      counters.increment('stream1', 'incoming');
      counters.increment('stream1', 'incoming');
      expect(counters.getNext('stream1', 'incoming')).toBe(2);

      counters.retire('stream1');

      // The security property: a retired stream is marked dead, so a caller that
      // checks isRetired() first never reads the recreated-at-0 counter. If
      // teardown could zero a counter, a captured frame history could be
      // replayed from the beginning after forcing a teardown.
      expect(counters.isRetired('stream1')).toBe(true);
    });

    it('does not report live or never-seen streams as retired', () => {
      const counters = new StreamCounters();
      counters.increment('live', 'incoming');
      expect(counters.isRetired('live')).toBe(false);
      expect(counters.isRetired('never-existed')).toBe(false);
    });

    it('bounds the retired set, evicting oldest first', () => {
      const counters = new StreamCounters();
      // 300 > MAX_RETIRED_SIDS (256): a long-lived session must not leak an
      // entry per stream forever.
      for (let i = 0; i < 300; i++) counters.retire(`sid-${i}`);

      expect(counters.isRetired('sid-299')).toBe(true); // newest kept
      expect(counters.isRetired('sid-0')).toBe(false); // oldest evicted
      expect(counters.isRetired('sid-299')).toBe(true);
      // Exactly the newest 256 survive.
      let kept = 0;
      for (let i = 0; i < 300; i++) if (counters.isRetired(`sid-${i}`)) kept++;
      expect(kept).toBe(256);
    });

    it('clear() also clears retirement', () => {
      const counters = new StreamCounters();
      counters.retire('stream1');
      expect(counters.isRetired('stream1')).toBe(true);
      counters.clear();
      expect(counters.isRetired('stream1')).toBe(false);
    });
  });

  it('should list all stream IDs', () => {
    const counters = new StreamCounters();
    
    expect(counters.getStreamIds()).toEqual([]);
    
    counters.increment('stream1', 'incoming');
    counters.increment('stream2', 'outgoing');
    counters.increment('stream3', 'incoming');
    
    const ids = counters.getStreamIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('stream1');
    expect(ids).toContain('stream2');
    expect(ids).toContain('stream3');
  });

  it('should clear all counters', () => {
    const counters = new StreamCounters();
    
    // Set up multiple streams
    counters.increment('stream1', 'incoming');
    counters.increment('stream2', 'incoming');
    counters.increment('stream3', 'outgoing');
    
    expect(counters.getStreamIds()).toHaveLength(3);
    
    // Clear all
    counters.clear();
    
    expect(counters.getStreamIds()).toHaveLength(0);
    expect(counters.getNext('stream1', 'incoming')).toBe(0);
    expect(counters.getNext('stream2', 'incoming')).toBe(0);
    expect(counters.getNext('stream3', 'outgoing')).toBe(0);
  });

  it('should handle many concurrent streams', () => {
    const counters = new StreamCounters();
    const numStreams = 100;
    
    // Create many streams
    for (let i = 0; i < numStreams; i++) {
      const sid = `stream-${i}`;
      for (let j = 0; j < 10; j++) {
        expect(counters.increment(sid, 'incoming')).toBe(j);
        expect(counters.increment(sid, 'outgoing')).toBe(j);
      }
    }
    
    expect(counters.getStreamIds()).toHaveLength(numStreams);
    
    // Verify all counters
    for (let i = 0; i < numStreams; i++) {
      const sid = `stream-${i}`;
      expect(counters.getNext(sid, 'incoming')).toBe(10);
      expect(counters.getNext(sid, 'outgoing')).toBe(10);
    }
  });
});