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