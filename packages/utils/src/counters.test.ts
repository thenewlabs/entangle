import { describe, it, expect } from 'vitest';
import { MonotonicCounter, BidirectionalCounters } from './counters.js';

describe('Counters', () => {
  describe('MonotonicCounter', () => {
    it('should start at -1', () => {
      const counter = new MonotonicCounter();
      expect(counter.current()).toBe(-1);
    });

    it('should increment with next()', () => {
      const counter = new MonotonicCounter();
      
      expect(counter.next()).toBe(0);
      expect(counter.next()).toBe(1);
      expect(counter.next()).toBe(2);
      expect(counter.current()).toBe(2);
    });

    it('should validate strictly increasing values', () => {
      const counter = new MonotonicCounter();
      
      expect(() => counter.validate(0)).not.toThrow();
      expect(() => counter.validate(1)).not.toThrow();
      expect(() => counter.validate(2)).not.toThrow();
    });

    it('should reject non-increasing values', () => {
      const counter = new MonotonicCounter();
      
      counter.validate(5);
      
      expect(() => counter.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 5');
      
      expect(() => counter.validate(4))
        .toThrow('Counter not strictly increasing: 4 <= 5');
    });

    it('should reject zero after positive value', () => {
      const counter = new MonotonicCounter();
      
      counter.validate(10);
      
      expect(() => counter.validate(0))
        .toThrow('Counter not strictly increasing: 0 <= 10');
    });

    it('should handle large values', () => {
      const counter = new MonotonicCounter();
      
      counter.validate(1000000);
      expect(() => counter.validate(1000001)).not.toThrow();
      expect(counter.current()).toBe(1000001);
    });
  });

  describe('BidirectionalCounters', () => {
    it('should maintain separate incoming and outgoing counters', () => {
      const counters = new BidirectionalCounters();
      
      expect(counters.incoming.current()).toBe(-1);
      expect(counters.outgoing.current()).toBe(-1);
    });

    it('should increment counters independently', () => {
      const counters = new BidirectionalCounters();
      
      expect(counters.incoming.next()).toBe(0);
      expect(counters.incoming.next()).toBe(1);
      
      expect(counters.outgoing.next()).toBe(0);
      expect(counters.outgoing.next()).toBe(1);
      expect(counters.outgoing.next()).toBe(2);
      
      expect(counters.incoming.current()).toBe(1);
      expect(counters.outgoing.current()).toBe(2);
    });

    it('should validate counters independently', () => {
      const counters = new BidirectionalCounters();
      
      counters.incoming.validate(5);
      counters.outgoing.validate(10);
      
      expect(() => counters.incoming.validate(6)).not.toThrow();
      expect(() => counters.outgoing.validate(11)).not.toThrow();
      
      expect(() => counters.incoming.validate(5))
        .toThrow('Counter not strictly increasing: 5 <= 6');
      
      expect(() => counters.outgoing.validate(10))
        .toThrow('Counter not strictly increasing: 10 <= 11');
    });
  });
});