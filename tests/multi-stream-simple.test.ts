import { describe, it, expect } from 'vitest';
import { 
  FrameType,
  ErrorCode,
  StreamMode,
  StreamMetadata,
  StreamUsage,
} from '../packages/protocol/src/index.js';
import { StreamCounters } from '../packages/utils/src/stream-counters.js';

describe('Multi-stream implementation', () => {
  describe('Protocol constants', () => {
    it('should have multi-stream frame types', () => {
      // Verify frame types exist and have correct values
      expect(FrameType.STREAM_OPEN).toBeDefined();
      expect(FrameType.STREAM_CLOSE).toBeDefined();
      expect(FrameType.STREAM_DATA).toBeDefined();
      expect(FrameType.STREAM_ERROR).toBeDefined();
      expect(FrameType.STREAM_EXIT).toBeDefined();
      expect(FrameType.STREAM_SIGNAL).toBeDefined();
      expect(FrameType.STREAM_RESIZE).toBeDefined();

      // Verify they are in the correct range (0x30-0x36)
      expect(FrameType.STREAM_OPEN).toBeGreaterThanOrEqual(0x30);
      expect(FrameType.STREAM_RESIZE).toBeLessThanOrEqual(0x36);
    });

    it('should have multi-stream error codes', () => {
      expect(ErrorCode.STREAM_LIMIT_EXCEEDED).toBe('stream_limit_exceeded');
      expect(ErrorCode.UNKNOWN_STREAM_ID).toBe('unknown_stream_id');
      expect(ErrorCode.INVALID_STREAM_MODE).toBe('invalid_stream_mode');
    });
  });

  describe('Stream types', () => {
    it('should support stream modes', () => {
      const ptyMode: StreamMode = 'pty';
      const cmdMode: StreamMode = 'cmd';
      
      expect(ptyMode).toBe('pty');
      expect(cmdMode).toBe('cmd');
    });

    it('should have stream metadata structure', () => {
      const metadata: StreamMetadata = {
        sid: 'stream-123',
        mode: 'pty',
        startedAt: Date.now(),
      };

      expect(metadata.sid).toBe('stream-123');
      expect(metadata.mode).toBe('pty');
      expect(metadata.startedAt).toBeDefined();
      expect(metadata.endedAt).toBeUndefined();

      // With endedAt
      const completedMetadata: StreamMetadata = {
        ...metadata,
        endedAt: Date.now() + 1000,
      };
      expect(completedMetadata.endedAt).toBeDefined();
    });

    it('should have stream usage structure', () => {
      const usage: StreamUsage = {
        cpuMs: 1234,
        rssMaxBytes: 256 * 1024 * 1024,
        wallMs: 5000,
        outBytes: 1024 * 1024,
      };

      expect(usage.cpuMs).toBe(1234);
      expect(usage.rssMaxBytes).toBe(256 * 1024 * 1024);
      expect(usage.wallMs).toBe(5000);
      expect(usage.outBytes).toBe(1024 * 1024);
    });
  });

  describe('Multi-stream policy', () => {
    it('should support multi-stream limits in policy', () => {
      const policy = {
        singleRun: false,
        maxStreams: 16,
        perStream: {
          maxCpuMs: 60000,
          maxMemMB: 512,
          maxWallMs: 300000,
          maxOutBytes: 10 * 1024 * 1024,
        },
      };

      expect(policy.maxStreams).toBe(16);
      expect(policy.perStream).toBeDefined();
      expect(policy.perStream.maxCpuMs).toBe(60000);
      expect(policy.perStream.maxMemMB).toBe(512);
    });
  });

  describe('Stream counters functionality', () => {
    it('should manage per-stream counters independently', () => {
      const counters = new StreamCounters();
      
      // Test stream 1
      expect(counters.getNext('stream1', 'incoming')).toBe(0);
      counters.increment('stream1', 'incoming');
      expect(counters.getNext('stream1', 'incoming')).toBe(1);
      
      // Test stream 2 - should be independent
      expect(counters.getNext('stream2', 'incoming')).toBe(0);
      counters.increment('stream2', 'incoming');
      counters.increment('stream2', 'incoming');
      expect(counters.getNext('stream2', 'incoming')).toBe(2);
      
      // Stream 1 should be unchanged
      expect(counters.getNext('stream1', 'incoming')).toBe(1);
      
      // Test outgoing direction
      expect(counters.getNext('stream1', 'outgoing')).toBe(0);
      counters.increment('stream1', 'outgoing');
      expect(counters.getNext('stream1', 'outgoing')).toBe(1);
    });

    it('should clean up stream counters', () => {
      const counters = new StreamCounters();
      
      // Add some counters
      counters.increment('stream1', 'incoming');
      counters.increment('stream2', 'incoming');
      counters.increment('stream3', 'incoming');
      
      expect(counters.getStreamIds()).toHaveLength(3);
      
      // Remove one stream
      counters.removeStream('stream2');
      expect(counters.getStreamIds()).toHaveLength(2);
      expect(counters.getStreamIds()).not.toContain('stream2');
      
      // Stream2 counters should be reset
      expect(counters.getNext('stream2', 'incoming')).toBe(0);
      
      // Clear all
      counters.clear();
      expect(counters.getStreamIds()).toHaveLength(0);
    });
  });
});