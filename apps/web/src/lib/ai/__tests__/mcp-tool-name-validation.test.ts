/**
 * Tool Name Validation Tests (Web Package)
 * Tests for MCP tool/server name validation and sanitization
 * Security focus: Prevent injection attacks via malicious names
 */

import { describe, it, expect } from 'vitest';
import {
  validateToolName,
  validateServerName,
  createSafeToolName,
} from '../mcp-tool-converter';

describe('MCP Tool Name Validation - Security (Web)', () => {
  describe('validateToolName', () => {
    it('should accept valid tool names', () => {
      expect(() => validateToolName('read-file')).not.toThrow();
      expect(() => validateToolName('get_user')).not.toThrow();
      expect(() => validateToolName('tool123')).not.toThrow();
    });

    it('should reject empty tool names', () => {
      expect(() => validateToolName('')).toThrow('Tool name cannot be empty');
    });

    it('should reject tool names with invalid characters', () => {
      expect(() => validateToolName('tool/../etc')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool;rm -rf')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool$(whoami)')).toThrow('Tool name contains invalid characters');
    });

    it('should reject tool names exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => validateToolName(longName)).toThrow('Tool name exceeds maximum length of 64 characters');
    });
  });

  describe('validateServerName', () => {
    it('should accept valid server names', () => {
      expect(() => validateServerName('my-server')).not.toThrow();
      expect(() => validateServerName('server_123')).not.toThrow();
    });

    it('should reject invalid server names', () => {
      expect(() => validateServerName('')).toThrow('Server name cannot be empty');
      expect(() => validateServerName('server/../etc')).toThrow('Server name contains invalid characters');
    });
  });

  describe('createSafeToolName', () => {
    it('should create valid namespaced tool names with new format', () => {
      const result = createSafeToolName('my-server', 'read-file');
      expect(result).toBe('mcp:my-server:read-file');
    });

    it('should throw on invalid names', () => {
      expect(() => createSafeToolName('server/../etc', 'tool')).toThrow();
      expect(() => createSafeToolName('server', 'tool;rm')).toThrow();
    });
  });

  describe('Real-world injection attack scenarios', () => {
    it('should prevent command injection via tool names', () => {
      const maliciousNames = [
        'tool`whoami`',
        'tool$(ls)',
        'tool;cat /etc/passwd',
        'tool|grep secret',
        'tool&& rm -rf /',
      ];

      maliciousNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent path traversal attacks', () => {
      const pathTraversalNames = [
        '../../../etc/passwd',
        './tool/../../../secret',
        'tool/../../config',
      ];

      pathTraversalNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent null byte injection', () => {
      expect(() => validateToolName('tool\x00.txt')).toThrow('Tool name contains invalid characters');
      expect(() => validateServerName('server\x00.conf')).toThrow('Server name contains invalid characters');
    });
  });
});
