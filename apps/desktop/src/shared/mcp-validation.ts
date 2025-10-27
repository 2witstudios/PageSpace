import { z } from 'zod';

/**
 * Zod schema for MCP Server configuration validation
 */
export const MCPServerConfigSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Zod schema for full MCP configuration
 */
export const MCPConfigSchema = z.object({
  mcpServers: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Server name must only contain letters, numbers, hyphens, and underscores'),
    MCPServerConfigSchema
  ),
});

/**
 * Type-safe configuration validation
 */
export function validateMCPConfig(config: unknown): { success: true; data: z.infer<typeof MCPConfigSchema> } | { success: false; error: string } {
  try {
    const result = MCPConfigSchema.parse(config);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstError = error.errors[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    return {
      success: false,
      error: 'Invalid configuration format',
    };
  }
}

/**
 * Validate a single server configuration
 */
export function validateServerConfig(name: string, config: unknown): { success: true; data: z.infer<typeof MCPServerConfigSchema> } | { success: false; error: string } {
  // Validate server name
  const nameRegex = /^[a-zA-Z0-9_-]+$/;
  if (!nameRegex.test(name)) {
    return {
      success: false,
      error: 'Server name must only contain letters, numbers, hyphens, and underscores',
    };
  }

  // Validate config
  try {
    const result = MCPServerConfigSchema.parse(config);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstError = error.errors[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    return {
      success: false,
      error: 'Invalid server configuration',
    };
  }
}
