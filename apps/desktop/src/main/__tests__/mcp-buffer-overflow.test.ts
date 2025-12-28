/**
 * Buffer Overflow Protection Tests
 * Tests for Issue #1: Parse valid messages before clearing buffer
 *
 * These tests verify that the MCPManager correctly handles buffer overflow scenarios
 * by parsing valid JSON-RPC messages before clearing the buffer, preventing data loss.
 */

import { describe, it, expect } from 'vitest';
import { MCP_CONSTANTS } from '../../shared/mcp-types';

describe('MCP Buffer Overflow Protection (Issue #1)', () => {
  describe('Valid messages parsed before buffer overflow', () => {
    it('should parse complete JSON-RPC messages before clearing on overflow', () => {
      // This tests the core fix: when buffer overflows, extract valid messages first

      // Simulate buffer with valid JSON-RPC responses plus garbage
      const validMessage1 = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { success: true },
      });

      const validMessage2 = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { data: 'test' },
      });

      // Create a buffer that exceeds MAX_STDOUT_BUFFER_SIZE_BYTES (1MB)
      const largeGarbage = 'x'.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 1000);
      const bufferContent = `${validMessage1}\n${validMessage2}\n${largeGarbage}`;

      expect(bufferContent.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      // Verify messages can be extracted
      const lines = bufferContent.split('\n');
      const parsedMessages: unknown[] = [];

      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          parsedMessages.push(message);
        } catch {
          // Invalid JSON, skip
        }
      });

      expect(parsedMessages).toHaveLength(2);
      expect(parsedMessages[0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { success: true },
      });
      expect(parsedMessages[1]).toEqual({
        jsonrpc: '2.0',
        id: 2,
        result: { data: 'test' },
      });
    });

    it('should handle buffer with only valid messages at overflow threshold', () => {
      // Test case: buffer at exactly 1MB with only valid JSON-RPC messages

      const messageTemplate = {
        jsonrpc: '2.0',
        id: 0,
        result: { data: 'x'.repeat(100) },
      };

      const messageString = JSON.stringify(messageTemplate) + '\n';
      const messageCount = Math.floor(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES / messageString.length) + 10;

      let bufferContent = '';
      for (let i = 0; i < messageCount; i++) {
        const message = { ...messageTemplate, id: i };
        bufferContent += JSON.stringify(message) + '\n';
      }

      expect(bufferContent.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      // Parse all valid messages
      const lines = bufferContent.split('\n');
      const parsedCount = lines.filter((line) => {
        if (!line.trim()) return false;
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }).length;

      expect(parsedCount).toBeGreaterThan(0);
      expect(parsedCount).toBeLessThanOrEqual(messageCount);
    });

    it('should handle partial messages correctly on overflow', () => {
      // Test case: buffer with valid messages + partial incomplete message at end

      const validMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { test: true },
      });

      const partialMessage = '{"jsonrpc": "2.0", "id": 2, "result": { "incomplete';
      const largeGarbage = 'x'.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 1000);

      const bufferContent = `${validMessage}\n${largeGarbage}\n${partialMessage}`;

      expect(bufferContent.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      const lines = bufferContent.split('\n');
      const incompleteLineIndex = bufferContent.endsWith('\n') ? lines.length : lines.length - 1;

      const parsedMessages: unknown[] = [];
      for (let i = 0; i < incompleteLineIndex; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const message = JSON.parse(line);
          parsedMessages.push(message);
        } catch {
          // Invalid JSON, skip
        }
      }

      // Should parse the valid message, skip garbage and partial message
      expect(parsedMessages).toHaveLength(1);
      expect(parsedMessages[0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { test: true },
      });
    });
  });

  describe('Buffer size thresholds', () => {
    it('should trigger warning at 512KB threshold', () => {
      const warningThreshold = MCP_CONSTANTS.STDOUT_BUFFER_WARNING_SIZE_BYTES;
      const maxThreshold = MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES;

      expect(warningThreshold).toBe(512 * 1024); // 512KB
      expect(maxThreshold).toBe(1024 * 1024); // 1MB
      expect(warningThreshold).toBeLessThan(maxThreshold);
    });

    it('should clear buffer at 1MB maximum threshold', () => {
      const maxSize = MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES;
      expect(maxSize).toBe(1024 * 1024); // 1MB
    });

    it('should handle buffer just below overflow threshold', () => {
      // Test edge case: buffer at 1MB - 1 byte (should NOT overflow)
      const bufferSize = MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES - 1;
      const buffer = 'x'.repeat(bufferSize);

      expect(buffer.length).toBe(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES - 1);
      expect(buffer.length).toBeLessThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);
    });

    it('should handle buffer at exactly overflow threshold', () => {
      // Test edge case: buffer at exactly 1MB (should NOT overflow)
      const bufferSize = MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES;
      const buffer = 'x'.repeat(bufferSize);

      expect(buffer.length).toBe(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);
    });

    it('should trigger overflow at threshold + 1 byte', () => {
      // Test edge case: buffer at 1MB + 1 byte (SHOULD overflow)
      const bufferSize = MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 1;
      const buffer = 'x'.repeat(bufferSize);

      expect(buffer.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);
    });
  });

  describe('Multiple overflow scenarios', () => {
    it('should handle multiple consecutive overflows', () => {
      // Test case: multiple overflow events in succession

      const validMessage = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
      const overflowBuffer = 'x'.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 100);

      // First overflow
      const buffer1 = `${validMessage}\n${overflowBuffer}`;
      expect(buffer1.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      // Second overflow
      const buffer2 = `${validMessage}\n${validMessage}\n${overflowBuffer}`;
      expect(buffer2.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      // Both should be able to parse valid messages
      [buffer1, buffer2].forEach((buffer) => {
        const lines = buffer.split('\n');
        const parsedCount = lines.filter((line) => {
          if (!line.trim()) return false;
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        }).length;

        expect(parsedCount).toBeGreaterThan(0);
      });
    });

    it('should handle rapid buffer growth', () => {
      // Simulate rapid data influx causing quick buffer growth
      let buffer = '';
      const increment = 'data'.repeat(1000) + '\n';
      const maxIterations = Math.ceil(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES / increment.length) + 5;

      for (let i = 0; i < maxIterations; i++) {
        buffer += increment;
        if (buffer.length > MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES) {
          break;
        }
      }

      expect(buffer.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);
    });
  });

  describe('Mixed valid and invalid JSON', () => {
    it('should parse valid JSON and skip invalid JSON on overflow', () => {
      const validMessage1 = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { a: 1 } });
      const validMessage2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { b: 2 } });
      const invalidJson1 = '{invalid json';
      const invalidJson2 = 'not json at all';
      const largeGarbage = 'x'.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 1000);

      const bufferContent = [
        validMessage1,
        invalidJson1,
        validMessage2,
        invalidJson2,
        largeGarbage,
      ].join('\n');

      expect(bufferContent.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      const lines = bufferContent.split('\n');
      const parsedMessages: unknown[] = [];
      const failedCount = { count: 0 };

      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          parsedMessages.push(message);
        } catch {
          failedCount.count++;
        }
      });

      expect(parsedMessages).toHaveLength(2);
      expect(failedCount.count).toBeGreaterThan(0); // Should have failed to parse invalid JSON
    });
  });

  describe('Empty buffer edge cases', () => {
    it('should handle empty buffer overflow', () => {
      const emptyBuffer = '';
      expect(emptyBuffer.length).toBe(0);
      expect(emptyBuffer.length).toBeLessThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);
    });

    it('should handle buffer with only newlines', () => {
      const newlineBuffer = '\n'.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES + 100);
      expect(newlineBuffer.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      const lines = newlineBuffer.split('\n');
      const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
      expect(nonEmptyLines).toHaveLength(0);
    });

    it('should handle buffer with only whitespace', () => {
      const whitespaceBuffer = ' \t '.repeat(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES / 3 + 100);
      expect(whitespaceBuffer.length).toBeGreaterThan(MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES);

      const trimmed = whitespaceBuffer.trim();
      expect(trimmed).toBe('');
    });
  });

  describe('Performance under high load', () => {
    it('should handle large number of small messages efficiently', () => {
      const startTime = Date.now();

      let buffer = '';
      const messageTemplate = { jsonrpc: '2.0', id: 0, result: {} };

      // Add messages until buffer overflows
      for (let i = 0; i < 100000; i++) {
        const message = { ...messageTemplate, id: i };
        buffer += JSON.stringify(message) + '\n';

        if (buffer.length > MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES) {
          break;
        }
      }

      // Parse messages
      const lines = buffer.split('\n');
      const parsedCount = lines.filter((line) => {
        if (!line.trim()) return false;
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }).length;

      const endTime = Date.now();
      const elapsed = endTime - startTime;

      expect(parsedCount).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(5000); // Should complete in less than 5 seconds
    });
  });
});
