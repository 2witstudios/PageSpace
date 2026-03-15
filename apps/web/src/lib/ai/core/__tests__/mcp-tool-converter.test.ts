import { describe, it, expect, vi } from 'vitest';

import {
  validateToolName,
  validateServerName,
  createSafeToolName,
  convertMCPToolSchemaToZod,
  convertMCPToolsToAISDKSchemas,
  parseMCPToolName,
  isMCPTool,
  sanitizeToolName,
  sanitizeToolNamesForProvider,
} from '../mcp-tool-converter';

import type { MCPTool } from '@/types/mcp';

describe('mcp-tool-converter', () => {
  describe('validateToolName', () => {
    it('should accept valid tool names', () => {
      expect(() => validateToolName('my_tool')).not.toThrow();
      expect(() => validateToolName('tool-name')).not.toThrow();
      expect(() => validateToolName('ToolName123')).not.toThrow();
    });

    it('should throw for empty tool name', () => {
      expect(() => validateToolName('')).toThrow('Tool name cannot be empty');
    });

    it('should throw for tool name exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => validateToolName(longName)).toThrow('exceeds maximum length of 64');
    });

    it('should accept tool name exactly at max length', () => {
      const maxName = 'a'.repeat(64);
      expect(() => validateToolName(maxName)).not.toThrow();
    });

    it('should throw for tool name with invalid characters', () => {
      expect(() => validateToolName('tool name')).toThrow('invalid characters');
      expect(() => validateToolName('tool:name')).toThrow('invalid characters');
      expect(() => validateToolName('tool.name')).toThrow('invalid characters');
    });
  });

  describe('validateServerName', () => {
    it('should accept valid server names', () => {
      expect(() => validateServerName('my-server')).not.toThrow();
      expect(() => validateServerName('server_name')).not.toThrow();
      expect(() => validateServerName('Server123')).not.toThrow();
    });

    it('should throw for empty server name', () => {
      expect(() => validateServerName('')).toThrow('Server name cannot be empty');
    });

    it('should throw for server name exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => validateServerName(longName)).toThrow('exceeds maximum length of 64');
    });

    it('should throw for server name with invalid characters', () => {
      expect(() => validateServerName('server name')).toThrow('invalid characters');
      expect(() => validateServerName('server:name')).toThrow('invalid characters');
    });
  });

  describe('createSafeToolName', () => {
    it('should create namespaced tool name in mcp:server:tool format', () => {
      const result = createSafeToolName('my-server', 'my-tool');
      expect(result).toBe('mcp:my-server:my-tool');
    });

    it('should throw when server name is invalid', () => {
      expect(() => createSafeToolName('invalid server', 'tool')).toThrow();
    });

    it('should throw when tool name is invalid', () => {
      expect(() => createSafeToolName('server', 'invalid tool')).toThrow();
    });

    it('should throw when either name is empty', () => {
      expect(() => createSafeToolName('', 'tool')).toThrow();
      expect(() => createSafeToolName('server', '')).toThrow();
    });
  });

  describe('convertMCPToolSchemaToZod', () => {
    it('should convert a simple string schema', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'A name' },
        },
        required: ['name'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      expect(result).toBeDefined();
      // Verify parsing succeeds with valid data
      const parsed = result.safeParse({ name: 'test' });
      expect(parsed.success).toBe(true);
    });

    it('should make properties optional when not in required array', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          required_field: { type: 'string' },
          optional_field: { type: 'string' },
        },
        required: ['required_field'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      // required_field missing => fail
      const withMissing = result.safeParse({ optional_field: 'val' });
      expect(withMissing.success).toBe(false);
      // optional_field missing => success
      const withOptional = result.safeParse({ required_field: 'val' });
      expect(withOptional.success).toBe(true);
    });

    it('should convert number type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          count: { type: 'number' },
        },
        required: ['count'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const parsed = result.safeParse({ count: 42 });
      expect(parsed.success).toBe(true);
    });

    it('should convert integer type with validation', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['page'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const validParsed = result.safeParse({ page: 5 });
      expect(validParsed.success).toBe(true);

      const floatParsed = result.safeParse({ page: 5.5 });
      expect(floatParsed.success).toBe(false);
    });

    it('should convert boolean type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          enabled: { type: 'boolean' },
        },
        required: ['enabled'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const parsed = result.safeParse({ enabled: true });
      expect(parsed.success).toBe(true);
    });

    it('should convert array type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['tags'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const parsed = result.safeParse({ tags: ['a', 'b'] });
      expect(parsed.success).toBe(true);
    });

    it('should convert nested object type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          nested: {
            type: 'object',
            properties: {
              inner: { type: 'string' },
            },
            required: ['inner'],
          },
        },
        required: ['nested'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const parsed = result.safeParse({ nested: { inner: 'value' } });
      expect(parsed.success).toBe(true);
    });

    it('should handle string enum type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['active', 'inactive'] },
        },
        required: ['status'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const validParsed = result.safeParse({ status: 'active' });
      expect(validParsed.success).toBe(true);

      const invalidParsed = result.safeParse({ status: 'unknown' });
      expect(invalidParsed.success).toBe(false);
    });

    it('should skip dangerous property names to prevent prototype pollution', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          __proto__: { type: 'string' },
          constructor: { type: 'string' },
          prototype: { type: 'string' },
          safe_field: { type: 'string' },
        },
        required: [],
      };

      expect(() => convertMCPToolSchemaToZod(schema)).not.toThrow();
      const result = convertMCPToolSchemaToZod(schema);
      const parsed = result.safeParse({ safe_field: 'value' });
      expect(parsed.success).toBe(true);
    });

    it('should handle empty properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {},
        required: [],
      };

      const result = convertMCPToolSchemaToZod(schema);
      expect(result).toBeDefined();
    });

    it('should use z.unknown() for unsupported types', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const schema = {
        type: 'object' as const,
        properties: {
          weird: { type: 'null' },
        },
        required: [],
      };

      expect(() => convertMCPToolSchemaToZod(schema)).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('should handle minimum/maximum constraints for number type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['score'],
      };

      const result = convertMCPToolSchemaToZod(schema);
      const valid = result.safeParse({ score: 50 });
      expect(valid.success).toBe(true);

      const tooLow = result.safeParse({ score: -1 });
      expect(tooLow.success).toBe(false);

      const tooHigh = result.safeParse({ score: 101 });
      expect(tooHigh.success).toBe(false);
    });
  });

  describe('convertMCPToolsToAISDKSchemas', () => {
    it('should convert a valid MCP tool', () => {
      const mcpTools: MCPTool[] = [
        {
          name: 'read-file',
          description: 'Read a file',
          serverName: 'filesystem',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
            },
            required: ['path'],
          },
        },
      ];

      const result = convertMCPToolsToAISDKSchemas(mcpTools);
      expect(result).toHaveProperty('mcp:filesystem:read-file');
    });

    it('should skip tools with invalid names', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mcpTools: MCPTool[] = [
        {
          name: 'invalid tool name',
          description: 'Bad tool',
          serverName: 'server',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const result = convertMCPToolsToAISDKSchemas(mcpTools);
      expect(Object.keys(result)).toHaveLength(0);
      consoleSpy.mockRestore();
    });

    it('should use default description when none provided', () => {
      const mcpTools: MCPTool[] = [
        {
          name: 'my-tool',
          description: '',
          serverName: 'my-server',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const result = convertMCPToolsToAISDKSchemas(mcpTools);
      const tool = result['mcp:my-server:my-tool'];
      expect(tool.description).toContain('my-server');
    });

    it('should handle multiple tools', () => {
      const mcpTools: MCPTool[] = [
        {
          name: 'tool-a',
          description: 'Tool A',
          serverName: 'server',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'tool-b',
          description: 'Tool B',
          serverName: 'server',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const result = convertMCPToolsToAISDKSchemas(mcpTools);
      expect(Object.keys(result)).toHaveLength(2);
    });

    it('should return empty object for empty tool list', () => {
      const result = convertMCPToolsToAISDKSchemas([]);
      expect(result).toEqual({});
    });
  });

  describe('parseMCPToolName', () => {
    it('should parse new format mcp:server:tool', () => {
      const result = parseMCPToolName('mcp:my-server:my-tool');
      expect(result).toEqual({ serverName: 'my-server', toolName: 'my-tool' });
    });

    it('should parse legacy format mcp__server__tool', () => {
      const result = parseMCPToolName('mcp__my-server__my-tool');
      expect(result).toEqual({ serverName: 'my-server', toolName: 'my-tool' });
    });

    it('should return null for non-MCP tool names', () => {
      expect(parseMCPToolName('regular_tool')).toBeNull();
      expect(parseMCPToolName('some_other_tool')).toBeNull();
    });

    it('should return null for malformed new format (missing tool name)', () => {
      expect(parseMCPToolName('mcp:server-only')).toBeNull();
    });

    it('should return null for malformed legacy format (missing tool name)', () => {
      expect(parseMCPToolName('mcp__server-only')).toBeNull();
    });

    it('should handle tool names with colons (nested namespaces)', () => {
      const result = parseMCPToolName('mcp:server:tool:with:colons');
      expect(result).toEqual({ serverName: 'server', toolName: 'tool:with:colons' });
    });

    it('should handle tool names with underscores in legacy format', () => {
      const result = parseMCPToolName('mcp__server__tool__name');
      expect(result).toEqual({ serverName: 'server', toolName: 'tool__name' });
    });
  });

  describe('isMCPTool', () => {
    it('should return true for mcp: prefix', () => {
      expect(isMCPTool('mcp:server:tool')).toBe(true);
    });

    it('should return true for mcp__ prefix (legacy)', () => {
      expect(isMCPTool('mcp__server__tool')).toBe(true);
    });

    it('should return false for regular tool names', () => {
      expect(isMCPTool('read_page')).toBe(false);
      expect(isMCPTool('create_page')).toBe(false);
      expect(isMCPTool('web_search')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isMCPTool('')).toBe(false);
    });
  });

  describe('sanitizeToolName', () => {
    it('should replace colons with double underscores', () => {
      expect(sanitizeToolName('mcp:server:tool')).toBe('mcp__server__tool');
    });

    it('should handle multiple colons', () => {
      expect(sanitizeToolName('mcp:server:tool:extra')).toBe('mcp__server__tool__extra');
    });

    it('should leave names without colons unchanged', () => {
      expect(sanitizeToolName('regular_tool')).toBe('regular_tool');
    });

    it('should handle empty string', () => {
      expect(sanitizeToolName('')).toBe('');
    });
  });

  describe('sanitizeToolNamesForProvider', () => {
    it('should sanitize all keys in tools object', () => {
      const tools = {
        'mcp:server:tool-a': { description: 'Tool A' },
        'mcp:server:tool-b': { description: 'Tool B' },
        regular_tool: { description: 'Regular' },
      };

      const result = sanitizeToolNamesForProvider(tools);
      expect(result).toHaveProperty('mcp__server__tool-a');
      expect(result).toHaveProperty('mcp__server__tool-b');
      expect(result).toHaveProperty('regular_tool');
    });

    it('should preserve tool definitions', () => {
      const toolDef = { description: 'My tool' };
      const tools = { 'mcp:server:tool': toolDef };

      const result = sanitizeToolNamesForProvider(tools);
      expect(result['mcp__server__tool']).toBe(toolDef);
    });

    it('should return empty object for empty input', () => {
      expect(sanitizeToolNamesForProvider({})).toEqual({});
    });
  });
});
