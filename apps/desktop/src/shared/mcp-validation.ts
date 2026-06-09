import { z } from 'zod';
import { logger } from '../main/logger';

/**
 * Allowed MCP server launcher commands (security finding H5).
 *
 * An MCP server is spawned by the privileged main process. The renderer can
 * push a new config via `mcp:update-config`, so an XSS in the web app could
 * otherwise set `command: 'sh'` (or any host binary) and execute arbitrary
 * processes. We therefore restrict the launcher to a fixed allowlist of known
 * runtimes. Absolute/relative paths are permitted only when their basename is
 * an allowed runtime (e.g. `/usr/local/bin/node`).
 */
export const ALLOWED_MCP_COMMANDS: readonly string[] = [
  'node',
  'npx',
  'bun',
  'bunx',
  'deno',
  'python',
  'python3',
  'uv',
  'uvx',
];

/**
 * Control characters never belong in an executable path. The server is spawned
 * WITHOUT a shell (`spawn(command, args)` in mcp-manager), so ordinary shell
 * metacharacters are passed literally and are not a shell-injection vector —
 * and rejecting them would break legitimate paths like
 * `C:\Program Files (x86)\nodejs\node.exe`. The basename allowlist below is the
 * real control; this check only rejects control characters.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export interface McpServerConfigValidation {
  ok: boolean;
  reason?: string;
}

/** Normalize a command to its lowercase basename, stripping a Windows suffix. */
function commandBasename(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
}

/**
 * Inline-code-evaluation flags per runtime. Real MCP servers launch a script
 * file or package (`node dist/index.js`, `npx -y @scope/server`, `python -m
 * server`) — none pass inline source. Rejecting these flags closes the
 * `node -e <payload>` / `python -c <payload>` execution vectors with no
 * false-positives, while keeping the check runtime-aware (e.g. `node -c` is a
 * harmless syntax check, NOT an eval flag, so it is not blocked). Package
 * runtimes (npx/bunx/uv/uvx) have no inline-eval flag.
 */
const INLINE_EVAL_FLAGS: Readonly<Record<string, readonly string[]>> = {
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
};

/** True when an arg is an inline-eval flag (exact or `--flag=value` form). */
function isInlineEvalArg(arg: string, flags: readonly string[]): boolean {
  return flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * PURE. Validate a single MCP server config's launcher. Rejects empty/non-string
 * commands, control characters, any command whose basename is not an allowed
 * runtime, and inline-code-eval flags on interpreter runtimes. Args, when
 * present, must be an array of strings.
 *
 * NOTE: package runtimes (`npx <pkg>` / `node <script>`) inherently execute the
 * code they are pointed at — that is the MCP feature itself. This validator
 * raises the bar (no direct shells, no inline eval) but cannot make MCP-server
 * configuration non-RCE; that capability is gated by the trusted-origin check
 * on `mcp:update-config` and is an explicit, user-initiated local action.
 */
export function validateMcpServerConfig(cfg: unknown): McpServerConfigValidation {
  if (cfg === null || typeof cfg !== 'object') {
    return { ok: false, reason: 'Server config must be an object' };
  }
  const { command, args } = cfg as { command?: unknown; args?: unknown };

  if (typeof command !== 'string' || command.trim().length === 0) {
    return { ok: false, reason: 'Command is required' };
  }
  if (CONTROL_CHARACTERS.test(command)) {
    return { ok: false, reason: 'Command contains forbidden control characters' };
  }
  const basename = commandBasename(command);
  if (!ALLOWED_MCP_COMMANDS.includes(basename)) {
    return {
      ok: false,
      reason: `Command "${command}" is not an allowed MCP runtime (allowed: ${ALLOWED_MCP_COMMANDS.join(', ')})`,
    };
  }
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) {
    return { ok: false, reason: 'Args must be an array of strings' };
  }
  const argList: string[] = Array.isArray(args) ? args : [];
  const evalFlags = INLINE_EVAL_FLAGS[basename];
  if (evalFlags) {
    const offending = argList.find((arg) => isInlineEvalArg(arg, evalFlags));
    if (offending) {
      return {
        ok: false,
        reason: `Inline-code flag "${offending}" is not allowed for runtime "${basename}"`,
      };
    }
  }
  return { ok: true };
}

/**
 * Zod schema for MCP Server configuration validation
 */
export const MCPServerConfigSchema = z
  .object({
    command: z.string().min(1, 'Command is required'),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),  // Zod v4 requires both key and value schemas
    autoStart: z.boolean().optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().min(1000).max(300000).optional(),
  })
  .superRefine((cfg, ctx) => {
    const result = validateMcpServerConfig(cfg);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.reason ?? 'Invalid MCP server configuration',
        path: ['command'],
      });
    }
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
    logger.debug('Validating config', { config });
    const result = MCPConfigSchema.parse(config);
    logger.debug('Config is valid', {});
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Validation failed', { errors: error.issues });
      const firstError = error.issues[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    logger.error('Unknown validation error', { error });
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
    logger.debug('Validating server config', { serverName: name, config });
    const result = MCPServerConfigSchema.parse(config);
    logger.debug('Server config is valid', { serverName: name });
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Server validation failed', { serverName: name, errors: error.issues });
      const firstError = error.issues[0];
      return {
        success: false,
        error: `${firstError.path.join('.')}: ${firstError.message}`,
      };
    }
    logger.error('Unknown validation error for server', { serverName: name, error });
    return {
      success: false,
      error: 'Invalid server configuration',
    };
  }
}
