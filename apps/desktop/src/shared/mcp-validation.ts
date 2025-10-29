import { z } from 'zod';

/**
 * Zod schema for MCP Server configuration validation
 */
export const MCPServerConfigSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),  // Zod v4 requires both key and value schemas
  autoStart: z.boolean().optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().min(1000).max(300000).optional(),
});

/**
 * Zod schema for full MCP configuration
 */
export const MCPConfigSchema = z.object({
  mcpServers: z.record(z.string(), MCPServerConfigSchema)
    .superRefine((servers, ctx) => {
      // Validate server names separately to avoid Zod v4 refined key schema issue
      const nameRegex = /^[a-zA-Z0-9_-]+$/;
      Object.keys(servers).forEach(name => {
        if (!nameRegex.test(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Server name "${name}" must only contain letters, numbers, hyphens, and underscores`,
            path: [name],
          });
        }
      });
    }),
});

/**
 * Type-safe configuration validation
 */
export function validateMCPConfig(config: unknown): { success: true; data: z.infer<typeof MCPConfigSchema> } | { success: false; error: string } {
  try {
    console.log('[MCP Validation] Validating config:', JSON.stringify(config, null, 2));
    const result = MCPConfigSchema.parse(config);
    console.log('[MCP Validation] ✓ Config is valid');
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[MCP Validation] ✗ Validation failed:', error.errors);
      // Include all errors for better debugging
      const allErrors = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join('; ');
      const firstError = error.errors[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    console.error('[MCP Validation] ✗ Unknown validation error:', error);
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
    console.log(`[MCP Validation] Validating server "${name}":`, JSON.stringify(config, null, 2));
    const result = MCPServerConfigSchema.parse(config);
    console.log(`[MCP Validation] ✓ Server "${name}" config is valid`);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(`[MCP Validation] ✗ Server "${name}" validation failed:`, error.errors);
      const firstError = error.errors[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    console.error(`[MCP Validation] ✗ Unknown validation error for server "${name}":`, error);
    return {
      success: false,
      error: 'Invalid server configuration',
    };
  }
}
