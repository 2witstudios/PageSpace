/**
 * MCP Tool Converter for Web Package
 * Converts MCP tool schemas (JSON Schema) to Zod schemas for AI SDK
 * Adapted from desktop package for browser/server compatibility
 */

import { z } from 'zod';
import type { MCPTool } from '@/types/mcp';

/** Sanitize a value for safe logging - strips control characters and newlines */
function sanitizeLogValue(value: string): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\n\r]/g, '').slice(0, 200);
}

/**
 * Maximum allowed length for tool and server names
 * Prevents excessively long names that could cause issues
 */
const MAX_NAME_LENGTH = 64;

/**
 * Regular expression for valid tool/server names
 * Only allows alphanumeric characters, hyphens, and underscores
 * This prevents injection attacks via special characters
 */
const VALID_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a tool name for security and format compliance
 * @param toolName - The tool name to validate
 * @throws Error if the tool name is invalid
 */
export function validateToolName(toolName: string): void {
  if (!toolName || toolName.length === 0) {
    throw new Error('Tool name cannot be empty');
  }

  if (toolName.length > MAX_NAME_LENGTH) {
    throw new Error(`Tool name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }

  if (!VALID_NAME_REGEX.test(toolName)) {
    throw new Error(
      'Tool name contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.'
    );
  }
}

/**
 * Validates a server name for security and format compliance
 * @param serverName - The server name to validate
 * @throws Error if the server name is invalid
 */
export function validateServerName(serverName: string): void {
  if (!serverName || serverName.length === 0) {
    throw new Error('Server name cannot be empty');
  }

  if (serverName.length > MAX_NAME_LENGTH) {
    throw new Error(`Server name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }

  if (!VALID_NAME_REGEX.test(serverName)) {
    throw new Error(
      'Server name contains invalid characters. Only alphanumeric characters, hyphens, and underscores are allowed.'
    );
  }
}

/**
 * Creates a safe namespaced tool name after validating inputs
 * @param serverName - The MCP server name
 * @param toolName - The tool name
 * @returns Namespaced tool name in format: mcp:servername:toolname
 * @throws Error if either name is invalid
 */
export function createSafeToolName(serverName: string, toolName: string): string {
  validateServerName(serverName);
  validateToolName(toolName);
  return `mcp:${serverName}:${toolName}`;
}

/**
 * Converts a single JSON Schema property to a Zod schema
 * Handles common JSON Schema types: string, number, boolean, object, array
 */
function jsonSchemaToZod(
  schema: Record<string, unknown>,
  propertyName: string
): z.ZodTypeAny {
  const type = schema.type as string;
  const description = schema.description as string | undefined;

  let zodSchema: z.ZodTypeAny;

  switch (type) {
    case 'string':
      zodSchema = z.string();
      if (schema.enum && Array.isArray(schema.enum)) {
        // Handle string enums
        zodSchema = z.enum(schema.enum as [string, ...string[]]);
      }
      break;

    case 'number':
    case 'integer':
      zodSchema = z.number();
      if (typeof schema.minimum === 'number') {
        zodSchema = (zodSchema as z.ZodNumber).min(schema.minimum);
      }
      if (typeof schema.maximum === 'number') {
        zodSchema = (zodSchema as z.ZodNumber).max(schema.maximum);
      }
      if (type === 'integer') {
        // Integer validation must come after min/max for proper error messages
        zodSchema = zodSchema.refine((n) => Number.isInteger(n), {
          message: 'Must be an integer',
        });
      }
      break;

    case 'boolean':
      zodSchema = z.boolean();
      break;

    case 'object':
      // Recursively convert nested object properties
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) || [];

      if (properties) {
        const zodProperties: Record<string, z.ZodTypeAny> = {};
        for (const [propName, propSchema] of Object.entries(properties)) {
          // Prevent prototype pollution
          if (propName === '__proto__' || propName === 'constructor' || propName === 'prototype') {
            continue;
          }
          zodProperties[propName] = jsonSchemaToZod(propSchema, propName);
          // Make optional if not in required array
          if (!required.includes(propName)) {
            zodProperties[propName] = zodProperties[propName].optional();
          }
        }
        zodSchema = z.object(zodProperties);
      } else {
        // Fallback for objects without defined properties
        // z.record requires explicit key type (z.string())
        zodSchema = z.record(z.string(), z.unknown());
      }
      break;

    case 'array':
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        const itemSchema = jsonSchemaToZod(items, `${propertyName}Item`);
        zodSchema = z.array(itemSchema);
      } else {
        zodSchema = z.array(z.unknown());
      }
      break;

    default:
      // Fallback for unsupported types
      console.warn('Unsupported JSON Schema type %s for property %s, using z.unknown()', sanitizeLogValue(String(type)), sanitizeLogValue(propertyName));
      zodSchema = z.unknown();
  }

  // Add description if available
  if (description) {
    zodSchema = zodSchema.describe(description);
  }

  return zodSchema;
}

/**
 * Converts MCP tool input schema (JSON Schema) to Zod object schema
 */
export function convertMCPToolSchemaToZod(
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  }
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const properties = inputSchema.properties || {};
  const required = inputSchema.required || [];

  const zodProperties: Record<string, z.ZodTypeAny> = {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    // Prevent prototype pollution: skip dangerous property names
    if (propName === '__proto__' || propName === 'constructor' || propName === 'prototype') {
      continue;
    }
    try {
      zodProperties[propName] = jsonSchemaToZod(propSchema as Record<string, unknown>, propName);

      // Make optional if not in required array
      if (!required.includes(propName)) {
        zodProperties[propName] = zodProperties[propName].optional();
      }
    } catch (error) {
      console.warn(
        'Failed to convert property %s in MCP tool schema:',
        sanitizeLogValue(propName),
        error
      );
      // Skip problematic properties
      continue;
    }
  }

  return z.object(zodProperties);
}

/**
 * Converts an array of MCP tools to AI SDK tool format (schema only, no execute)
 * Returns a map of tool name to tool definition
 */
export function convertMCPToolsToAISDKSchemas(
  mcpTools: MCPTool[]
): Record<string, { description: string; parameters: z.ZodObject<Record<string, z.ZodTypeAny>> }> {
  const toolSchemas: Record<string, { description: string; parameters: z.ZodObject<Record<string, z.ZodTypeAny>> }> = {};

  for (const mcpTool of mcpTools) {
    try {
      // Validate and create safe tool name
      const toolName = createSafeToolName(mcpTool.serverName, mcpTool.name);

      toolSchemas[toolName] = {
        description: mcpTool.description || `Tool from MCP server: ${mcpTool.serverName}`,
        parameters: convertMCPToolSchemaToZod(mcpTool.inputSchema),
      };

      console.log('Converted MCP tool: %s', sanitizeLogValue(toolName));
    } catch (error) {
      console.warn(
        'Skipping MCP tool %s.%s due to conversion error:',
        sanitizeLogValue(mcpTool.serverName),
        sanitizeLogValue(mcpTool.name),
        error
      );
    }
  }

  console.log('Successfully converted %d/%d MCP tools', Object.keys(toolSchemas).length, mcpTools.length);
  return toolSchemas;
}

/**
 * Parses a namespaced MCP tool name back to server and tool name
 * Supports both new format (mcp:servername:toolname) and legacy format (mcp__servername__toolname)
 *
 * @param namespacedName - Tool name in format: mcp:servername:toolname or mcp__servername__toolname (legacy)
 * @returns Object with serverName and toolName, or null if invalid format
 */
export function parseMCPToolName(namespacedName: string): {
  serverName: string;
  toolName: string;
} | null {
  // New format: mcp:servername:toolname
  const newPrefix = 'mcp:';
  if (namespacedName.startsWith(newPrefix)) {
    const parts = namespacedName.slice(newPrefix.length).split(':');
    if (parts.length < 2) {
      return null;
    }

    // Server name is first part, tool name is everything after first separator
    const serverName = parts[0];
    const toolName = parts.slice(1).join(':');

    return { serverName, toolName };
  }

  // Legacy format: mcp__servername__toolname (for backward compatibility)
  const legacyPrefix = 'mcp__';
  if (namespacedName.startsWith(legacyPrefix)) {
    const parts = namespacedName.slice(legacyPrefix.length).split('__');
    if (parts.length < 2) {
      return null;
    }

    const serverName = parts[0];
    const toolName = parts.slice(1).join('__');

    return { serverName, toolName };
  }

  return null;
}

/**
 * Checks if a tool name is an MCP tool (client-side execution required)
 * Supports both new format (mcp:) and legacy format (mcp__)
 */
export function isMCPTool(toolName: string): boolean {
  return toolName.startsWith('mcp:') || toolName.startsWith('mcp__');
}

/**
 * Sanitizes a single tool name for AI provider compatibility.
 * Replaces colons with double underscores.
 *
 * Many AI providers (Google Gemini, Azure, OpenAI) require tool names to match
 * the pattern ^[a-zA-Z0-9_.-]+$ (no colons allowed).
 *
 * Internal format: mcp:server:tool (supports nested namespaces in tool names)
 * Provider format: mcp__server__tool (universally compatible)
 *
 * The parseMCPToolName function handles both formats, so tool execution
 * still works correctly after sanitization.
 *
 * @param toolName - The tool name to sanitize
 * @returns Sanitized tool name with colons replaced by double underscores
 */
export function sanitizeToolName(toolName: string): string {
  return toolName.replace(/:/g, '__');
}

/**
 * Sanitizes all tool names in a tools object for AI provider compatibility.
 * Creates a new object with sanitized keys while preserving the tool definitions.
 *
 * This should be called before sending tools to any AI provider to ensure
 * compatibility across all providers (Google, Azure, OpenAI, Anthropic, etc.).
 *
 * @param tools - Object mapping tool names to tool definitions
 * @returns New object with sanitized tool names as keys
 *
 * @example
 * const tools = { 'mcp:filesystem:read_file': { ... } };
 * const sanitized = sanitizeToolNamesForProvider(tools);
 * // Result: { 'mcp__filesystem__read_file': { ... } }
 */
export function sanitizeToolNamesForProvider<T>(
  tools: Record<string, T>
): Record<string, T> {
  const sanitized: Record<string, T> = {};
  for (const [name, definition] of Object.entries(tools)) {
    sanitized[sanitizeToolName(name)] = definition;
  }
  return sanitized;
}
