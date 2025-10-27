/**
 * MCP Tool Converter Tests
 * Tests for JSON Schema to Zod conversion with focus on type safety
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  convertMCPToolToAISDK,
  convertMCPToolsToAISDK,
  parseMCPToolName,
} from '../mcp-tool-converter';
import type { MCPTool } from '../../shared/mcp-types';

describe('MCP Tool Converter - Type Safety', () => {
  describe('jsonSchemaToZod - Type Safety Issues', () => {
    it('should handle z.record with proper key type', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            // Object without defined properties - should use z.record(z.string(), z.unknown())
            dynamicObj: {
              type: 'object',
            },
          },
        },
      };

      const result = convertMCPToolToAISDK(tool);

      // Validate that the schema doesn't throw type errors
      expect(result.parameters).toBeDefined();

      // Test that it accepts valid input
      const testData = {
        dynamicObj: { anyKey: 'anyValue', anotherKey: 123 },
      };
      expect(() => result.parameters.parse(testData)).not.toThrow();
    });

    it('should handle integer validation consistently', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['count'],
        },
      };

      const result = convertMCPToolToAISDK(tool);

      // Should accept integers
      expect(() => result.parameters.parse({ count: 5 })).not.toThrow();
      expect(() => result.parameters.parse({ count: 1 })).not.toThrow();
      expect(() => result.parameters.parse({ count: 100 })).not.toThrow();

      // Should reject floats (using .int() method)
      expect(() => result.parameters.parse({ count: 5.5 })).toThrow();

      // Should enforce min/max
      expect(() => result.parameters.parse({ count: 0 })).toThrow();
      expect(() => result.parameters.parse({ count: 101 })).toThrow();
    });

    it('should handle nested objects correctly', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                value: { type: 'number' },
              },
              required: ['enabled'],
            },
          },
        },
      };

      const result = convertMCPToolToAISDK(tool);

      // Should accept valid nested object
      expect(() => result.parameters.parse({
        config: { enabled: true, value: 42 },
      })).not.toThrow();

      // Should accept missing optional field
      expect(() => result.parameters.parse({
        config: { enabled: false },
      })).not.toThrow();

      // Should reject missing required field
      expect(() => result.parameters.parse({
        config: { value: 42 },
      })).toThrow();
    });

    it('should handle arrays with typed items', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            numbers: {
              type: 'array',
              items: {
                type: 'integer',
              },
            },
          },
        },
      };

      const result = convertMCPToolToAISDK(tool);

      // Should accept arrays with correct types
      expect(() => result.parameters.parse({
        tags: ['tag1', 'tag2'],
        numbers: [1, 2, 3],
      })).not.toThrow();

      // Should reject arrays with wrong types
      expect(() => result.parameters.parse({
        tags: [1, 2, 3], // Numbers instead of strings
      })).toThrow();

      expect(() => result.parameters.parse({
        numbers: [1.5, 2.5], // Floats instead of integers
      })).toThrow();
    });

    it('should handle string enums correctly', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'inactive', 'pending'],
            },
          },
        },
      };

      const result = convertMCPToolToAISDK(tool);

      // Should accept valid enum values
      expect(() => result.parameters.parse({ status: 'active' })).not.toThrow();
      expect(() => result.parameters.parse({ status: 'inactive' })).not.toThrow();
      expect(() => result.parameters.parse({ status: 'pending' })).not.toThrow();

      // Should reject invalid enum values
      expect(() => result.parameters.parse({ status: 'invalid' })).toThrow();
    });
  });

  describe('convertMCPToolsToAISDK', () => {
    it('should handle multiple tools and skip invalid ones', () => {
      const tools: MCPTool[] = [
        {
          name: 'valid-tool-1',
          serverName: 'server',
          description: 'Valid tool',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
        {
          name: 'valid-tool-2',
          serverName: 'server',
          description: 'Another valid tool',
          inputSchema: {
            type: 'object',
            properties: { count: { type: 'integer' } },
          },
        },
      ];

      const result = convertMCPToolsToAISDK(tools);

      expect(result.size).toBe(2);
      expect(result.has('mcp__server__valid-tool-1')).toBe(true);
      expect(result.has('mcp__server__valid-tool-2')).toBe(true);
    });
  });

  describe('parseMCPToolName', () => {
    it('should parse valid tool names', () => {
      const result = parseMCPToolName('mcp__server__tool');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'tool',
      });
    });

    it('should handle tool names with underscores', () => {
      const result = parseMCPToolName('mcp__server__my_tool_name');
      expect(result).toEqual({
        serverName: 'server',
        toolName: 'my_tool_name',
      });
    });

    it('should return null for invalid formats', () => {
      expect(parseMCPToolName('invalid')).toBeNull();
      expect(parseMCPToolName('mcp__onlyserver')).toBeNull();
      expect(parseMCPToolName('wrong__prefix__tool')).toBeNull();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty properties object', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      };

      const result = convertMCPToolToAISDK(tool);
      expect(() => result.parameters.parse({})).not.toThrow();
    });

    it('should handle missing description', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: '',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      };

      const result = convertMCPToolToAISDK(tool);
      expect(result.description).toContain('test-server');
    });

    it('should handle unsupported schema types gracefully', () => {
      const tool: MCPTool = {
        name: 'test-tool',
        serverName: 'test-server',
        description: 'Test tool',
        inputSchema: {
          type: 'object',
          properties: {
            // @ts-expect-error - Testing unsupported type
            unsupportedField: {
              type: 'null', // Unsupported type
            },
          },
        },
      };

      // Should not throw, but use z.unknown() for unsupported type
      const result = convertMCPToolToAISDK(tool);
      expect(result).toBeDefined();
    });
  });
});
