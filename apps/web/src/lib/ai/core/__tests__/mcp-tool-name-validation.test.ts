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
  sanitizeToolName,
  sanitizeToolNamesForProvider,
  parseMCPToolName,
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

describe('MCP Tool Name Sanitization for Providers', () => {
  describe('sanitizeToolName', () => {
    it('should replace colons with double underscores', () => {
      expect(sanitizeToolName('mcp:server:tool')).toBe('mcp__server__tool');
    });

    it('should handle multiple colons (nested namespaces)', () => {
      expect(sanitizeToolName('mcp:server:namespace:tool:subcommand')).toBe('mcp__server__namespace__tool__subcommand');
    });

    it('should leave names without colons unchanged', () => {
      expect(sanitizeToolName('read_page')).toBe('read_page');
      expect(sanitizeToolName('mcp__server__tool')).toBe('mcp__server__tool');
    });

    it('should handle empty string', () => {
      expect(sanitizeToolName('')).toBe('');
    });
  });

  describe('sanitizeToolNamesForProvider', () => {
    it('should sanitize all tool names in an object', () => {
      const tools = {
        'mcp:filesystem:read_file': { description: 'Read a file' },
        'mcp:filesystem:write_file': { description: 'Write a file' },
        'read_page': { description: 'Read a page' },
      };

      const result = sanitizeToolNamesForProvider(tools);

      expect(result).toEqual({
        'mcp__filesystem__read_file': { description: 'Read a file' },
        'mcp__filesystem__write_file': { description: 'Write a file' },
        'read_page': { description: 'Read a page' },
      });
    });

    it('should preserve tool definitions', () => {
      const toolDef = {
        description: 'Test tool',
        parameters: { type: 'object' },
        execute: () => 'result',
      };
      const tools = { 'mcp:server:tool': toolDef };

      const result = sanitizeToolNamesForProvider(tools);

      expect(result['mcp__server__tool']).toBe(toolDef);
    });

    it('should handle empty object', () => {
      expect(sanitizeToolNamesForProvider({})).toEqual({});
    });
  });

  describe('Round-trip: sanitize then parse', () => {
    it('should correctly parse sanitized tool names', () => {
      // Create a tool name
      const original = createSafeToolName('my-server', 'read-file');
      expect(original).toBe('mcp:my-server:read-file');

      // Sanitize it for provider
      const sanitized = sanitizeToolName(original);
      expect(sanitized).toBe('mcp__my-server__read-file');

      // Parse the sanitized name - should still work
      const parsed = parseMCPToolName(sanitized);
      expect(parsed).toEqual({
        serverName: 'my-server',
        toolName: 'read-file',
      });
    });

    it('should handle nested namespaces in round-trip', () => {
      // Tool name with nested namespace
      const original = 'mcp:server:namespace:tool:subcommand';

      // Sanitize
      const sanitized = sanitizeToolName(original);
      expect(sanitized).toBe('mcp__server__namespace__tool__subcommand');

      // Parse - server is first part, rest is tool name
      const parsed = parseMCPToolName(sanitized);
      expect(parsed).toEqual({
        serverName: 'server',
        toolName: 'namespace__tool__subcommand',
      });
    });
  });
});
