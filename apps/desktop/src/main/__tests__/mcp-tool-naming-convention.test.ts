/**
 * MCP Tool Naming Convention Tests
 * Tests for new colon-separated format and backward compatibility with legacy format
 */

import { describe, it, expect } from 'vitest';
import {
  createSafeToolName,
  parseMCPToolName,
} from '../mcp-tool-converter';

describe('MCP Tool Naming Convention', () => {
  describe('createSafeToolName - New Format', () => {
    it('should create tool names with colon separator', () => {
      expect(createSafeToolName('my-server', 'read-file')).toBe('mcp:my-server:read-file');
      expect(createSafeToolName('server-1', 'tool-1')).toBe('mcp:server-1:tool-1');
    });

    it('should handle names with underscores', () => {
      expect(createSafeToolName('my_server', 'read_file')).toBe('mcp:my_server:read_file');
    });

    it('should handle names with hyphens and underscores', () => {
      expect(createSafeToolName('my-server_v1', 'tool_name-v2')).toBe('mcp:my-server_v1:tool_name-v2');
    });
  });

  describe('parseMCPToolName - New Format', () => {
    it('should parse new colon-separated format', () => {
      const result = parseMCPToolName('mcp:my-server:read-file');
      expect(result).toEqual({
        serverName: 'my-server',
        toolName: 'read-file',
      });
    });

    it('should handle tool names with underscores in new format', () => {
      const result = parseMCPToolName('mcp:server:my_tool_name');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'my_tool_name',
      });
    });

    it('should handle tool names with colons (nested namespaces)', () => {
      const result = parseMCPToolName('mcp:server:namespace:tool:subcommand');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'namespace:tool:subcommand',
      });
    });

    it('should return null for malformed new format', () => {
      expect(parseMCPToolName('mcp:only-server')).toBeNull();
      expect(parseMCPToolName('mcp:')).toBeNull();
    });
  });

  describe('parseMCPToolName - Legacy Format (Backward Compatibility)', () => {
    it('should still parse legacy double-underscore format', () => {
      const result = parseMCPToolName('mcp__my-server__read-file');
      expect(result).toEqual({
        serverName: 'my-server',
        toolName: 'read-file',
      });
    });

    it('should handle legacy tool names with underscores', () => {
      const result = parseMCPToolName('mcp__server__my_tool_name');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'my_tool_name',
      });
    });

    it('should handle legacy tool names with double underscores in tool name', () => {
      const result = parseMCPToolName('mcp__server__tool__with__underscores');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'tool__with__underscores',
      });
    });

    it('should return null for malformed legacy format', () => {
      expect(parseMCPToolName('mcp__only-server')).toBeNull();
      expect(parseMCPToolName('mcp__')).toBeNull();
    });
  });

  describe('parseMCPToolName - Invalid Formats', () => {
    it('should return null for non-MCP tool names', () => {
      expect(parseMCPToolName('regular-tool-name')).toBeNull();
      expect(parseMCPToolName('tool:name')).toBeNull();
      expect(parseMCPToolName('tool__name')).toBeNull();
    });

    it('should return null for invalid prefixes', () => {
      expect(parseMCPToolName('mcp_server_tool')).toBeNull(); // Single underscore
      expect(parseMCPToolName('mcptool')).toBeNull(); // No separator
      expect(parseMCPToolName('mcp-server-tool')).toBeNull(); // Hyphen separator
    });

    it('should return null for empty or incomplete names', () => {
      expect(parseMCPToolName('')).toBeNull();
      expect(parseMCPToolName('mcp:')).toBeNull();
      expect(parseMCPToolName('mcp__')).toBeNull();
    });
  });

  describe('Format Consistency', () => {
    it('should create and parse consistently (round trip)', () => {
      const created = createSafeToolName('my-server', 'read-file');
      const parsed = parseMCPToolName(created);

      expect(parsed).toEqual({
        serverName: 'my-server',
        toolName: 'read-file',
      });
    });

    it('should handle complex names in round trip', () => {
      const created = createSafeToolName('complex_server-v1', 'tool_name-v2');
      const parsed = parseMCPToolName(created);

      expect(parsed).toEqual({
        serverName: 'complex_server-v1',
        toolName: 'tool_name-v2',
      });
    });
  });

  describe('Migration Path', () => {
    it('should allow parsing both old and new formats in same codebase', () => {
      const newFormat = parseMCPToolName('mcp:server:tool');
      const oldFormat = parseMCPToolName('mcp__server__tool');

      expect(newFormat).toEqual({
        serverName: 'server',
        toolName: 'tool',
      });

      expect(oldFormat).toEqual({
        serverName: 'server',
        toolName: 'tool',
      });
    });

    it('should distinguish between formats', () => {
      // These are different tool names that should be parsed correctly
      const colonFormat = parseMCPToolName('mcp:server:read__file'); // Underscores in tool name
      const underscoreFormat = parseMCPToolName('mcp__server__read:file'); // Colon in tool name (legacy)

      expect(colonFormat).toEqual({
        serverName: 'server',
        toolName: 'read__file',
      });

      expect(underscoreFormat).toEqual({
        serverName: 'server',
        toolName: 'read:file',
      });
    });
  });
});
