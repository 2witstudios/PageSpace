/**
 * AI SDK Tool Converter
 *
 * Converts integration ToolDefinitions into Vercel AI SDK tool objects
 * that route execution through the sandbox executor.
 *
 * Tool naming convention mirrors MCP: int__{providerSlug}__{connectionShortId}__{toolId}
 * This is AI-provider-safe (no colons, only alphanumeric + underscores + hyphens).
 */

import { z } from 'zod';
import type {
  ToolDefinition,
  IntegrationProviderConfig,
  ToolCallRequest,
  ToolCallResult,
  ToolGrant,
} from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface GrantWithConnectionAndProvider {
  id: string;
  agentId: string;
  connectionId: string;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  readOnly: boolean;
  rateLimitOverride: { requestsPerMinute?: number } | null;
  connection: {
    id: string;
    name: string;
    status: string;
    providerId: string;
    provider: {
      id: string;
      slug: string;
      name: string;
      config: IntegrationProviderConfig;
    } | null;
  } | null;
}

export interface ExecutorContext {
  userId: string;
  agentId: string | null;
  driveId: string | null;
}

export interface CoreTool {
  description: string;
  parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL NAME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const INT_TOOL_PREFIX = 'int__';

/**
 * Build a namespaced integration tool name.
 * Format: int__{providerSlug}__{connectionShortId}__{toolId}
 */
export function buildIntegrationToolName(
  providerSlug: string,
  connectionId: string,
  toolId: string
): string {
  const shortId = connectionId.slice(0, 8);
  return `${INT_TOOL_PREFIX}${providerSlug}__${shortId}__${toolId}`;
}

/**
 * Parse a namespaced integration tool name back to components.
 */
export function parseIntegrationToolName(
  name: string
): { providerSlug: string; connectionId: string; toolId: string } | null {
  if (!name.startsWith(INT_TOOL_PREFIX)) return null;

  const rest = name.slice(INT_TOOL_PREFIX.length);
  const parts = rest.split('__');
  if (parts.length < 3) return null;

  return {
    providerSlug: parts[0],
    connectionId: parts[1],
    toolId: parts.slice(2).join('__'),
  };
}

/**
 * Check if a tool name is an integration tool.
 */
export function isIntegrationTool(name: string): boolean {
  return name.startsWith(INT_TOOL_PREFIX);
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON SCHEMA → ZOD CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a single JSON Schema property to a Zod schema.
 * Mirrors the approach in mcp-tool-converter.ts.
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
      if (schema.enum && Array.isArray(schema.enum)) {
        zodSchema = z.enum(schema.enum as [string, ...string[]]);
      } else {
        zodSchema = z.string();
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
      break;

    case 'boolean':
      zodSchema = z.boolean();
      break;

    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) || [];

      if (properties) {
        const zodProperties: Record<string, z.ZodTypeAny> = {};
        for (const [propName, propSchema] of Object.entries(properties)) {
          if (propName === '__proto__' || propName === 'constructor' || propName === 'prototype') {
            continue;
          }
          zodProperties[propName] = jsonSchemaToZod(propSchema, propName);
          if (!required.includes(propName)) {
            zodProperties[propName] = zodProperties[propName].optional();
          }
        }
        zodSchema = z.object(zodProperties);
      } else {
        zodSchema = z.record(z.string(), z.unknown());
      }
      break;
    }

    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) {
        zodSchema = z.array(jsonSchemaToZod(items, `${propertyName}Item`));
      } else {
        zodSchema = z.array(z.unknown());
      }
      break;
    }

    default:
      zodSchema = z.unknown();
  }

  if (description) {
    zodSchema = zodSchema.describe(description);
  }

  return zodSchema;
}

/**
 * Convert a ToolDefinition's inputSchema (JSON Schema) to a Zod object schema.
 */
export function convertToolSchemaToZod(
  inputSchema: Record<string, unknown>
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const properties = (inputSchema.properties as Record<string, Record<string, unknown>>) || {};
  const required = (inputSchema.required as string[]) || [];

  const zodProperties: Record<string, z.ZodTypeAny> = {};

  for (const [propName, propSchema] of Object.entries(properties)) {
    if (propName === '__proto__' || propName === 'constructor' || propName === 'prototype') {
      continue;
    }
    try {
      zodProperties[propName] = jsonSchemaToZod(propSchema, propName);
      if (!required.includes(propName)) {
        zodProperties[propName] = zodProperties[propName].optional();
      }
    } catch {
      // Skip problematic properties
      continue;
    }
  }

  return z.object(zodProperties);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CONVERTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert integration grants into AI SDK tool objects.
 *
 * For each active grant with an active connection and valid provider,
 * creates tool objects that route execution through the provided executor.
 */
export function convertIntegrationToolsToAISDK(
  grants: GrantWithConnectionAndProvider[],
  executorContext: ExecutorContext,
  executor: (request: ToolCallRequest) => Promise<ToolCallResult>
): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {};

  for (const grant of grants) {
    const connection = grant.connection;
    if (!connection) continue;
    if (connection.status !== 'active') continue;
    if (!connection.provider?.config) continue;

    const providerConfig = connection.provider.config;
    const providerSlug = connection.provider.slug;

    for (const tool of providerConfig.tools) {
      const toolName = buildIntegrationToolName(
        providerSlug,
        connection.id,
        tool.id
      );

      try {
        const parameters = convertToolSchemaToZod(tool.inputSchema);

        const override = grant.rateLimitOverride;
        const grantForRequest: ToolGrant = {
          allowedTools: grant.allowedTools,
          deniedTools: grant.deniedTools,
          readOnly: grant.readOnly,
          rateLimitOverride: override?.requestsPerMinute
            ? { requestsPerMinute: override.requestsPerMinute }
            : undefined,
        };

        tools[toolName] = {
          description: `[${connection.provider.name}] ${tool.description}`,
          parameters,
          execute: async (args: Record<string, unknown>) => {
            const result = await executor({
              userId: executorContext.userId,
              agentId: executorContext.agentId,
              driveId: executorContext.driveId,
              connectionId: connection.id,
              toolName: tool.id,
              input: args,
              grant: grantForRequest,
            });

            if (!result.success) {
              throw new Error(result.error || 'Integration tool execution failed');
            }

            return result.data;
          },
        };
      } catch {
        // Skip tools with schema conversion errors
        continue;
      }
    }
  }

  return tools;
}
