/**
 * MCP Tool to AI SDK Converter
 * Converts MCP tool definitions (JSON Schema) to Vercel AI SDK tool format (Zod schemas)
 */

import { z } from 'zod';
import type { MCPTool } from '../shared/mcp-types';
import { logger } from './logger';

/**
 * AI SDK Tool Definition (matches Vercel AI SDK format)
 */
export interface AISDKTool {
  description: string;
  parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
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
      logger.warn('Unsupported JSON Schema type, using z.unknown()', { type, propertyName });
      zodSchema = z.unknown();
  }

  // Add description if available
  if (description) {
    zodSchema = zodSchema.describe(description);
  }

  return zodSchema;
}

/**
 * Converts MCP tool definition to AI SDK tool format
 * @param mcpTool - MCP tool definition with JSON Schema
 * @returns AI SDK tool with Zod schema (without execute function)
 */
export function convertMCPToolToAISDK(
  mcpTool: MCPTool
): Omit<AISDKTool, 'execute'> {
  try {
    const { name, description, inputSchema, serverName } = mcpTool;

    // Validate names for security before using them
    validateServerName(serverName);
    validateToolName(name);

    // Generate namespaced tool name: mcp_{serverName}_{toolName}
    const namespacedName = createSafeToolName(serverName, name);

    // Convert JSON Schema properties to Zod schema
    const properties = inputSchema.properties || {};
    const required = inputSchema.required || [];

    const zodProperties: Record<string, z.ZodTypeAny> = {};

    for (const [propName, propSchema] of Object.entries(properties)) {
      try {
        zodProperties[propName] = jsonSchemaToZod(propSchema as Record<string, unknown>, propName);

        // Make optional if not in required array
        if (!required.includes(propName)) {
          zodProperties[propName] = zodProperties[propName].optional();
        }
      } catch (error) {
        logger.warn('Failed to convert property for tool', {
          propName,
          namespacedName,
          error,
        });
        // Skip problematic properties
        continue;
      }
    }

    const parameters = z.object(zodProperties);

    return {
      description: description || `Tool from MCP server: ${serverName}`,
      parameters,
    };
  } catch (error) {
    logger.error('Failed to convert MCP tool', {
      serverName: mcpTool.serverName,
      toolName: mcpTool.name,
      error,
    });
    throw error;
  }
}

/**
 * Converts an array of MCP tools to AI SDK format
 * Skips tools that fail conversion and logs warnings
 * @param mcpTools - Array of MCP tool definitions
 * @returns Map of tool name to AI SDK tool definition
 */
export function convertMCPToolsToAISDK(
  mcpTools: MCPTool[]
): Map<string, Omit<AISDKTool, 'execute'>> {
  const convertedTools = new Map<string, Omit<AISDKTool, 'execute'>>();

  for (const mcpTool of mcpTools) {
    try {
      // Validate and create safe tool name
      const namespacedName = createSafeToolName(mcpTool.serverName, mcpTool.name);
      const aiTool = convertMCPToolToAISDK(mcpTool);
      convertedTools.set(namespacedName, aiTool);
    } catch (error) {
      logger.warn('Skipping tool due to conversion error', {
        serverName: mcpTool.serverName,
        toolName: mcpTool.name,
        error,
      });
      // Continue with other tools
    }
  }

  logger.info('Successfully converted MCP tools to AI SDK format', {
    convertedCount: convertedTools.size,
    totalCount: mcpTools.length,
  });
  return convertedTools;
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
