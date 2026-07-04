/**
 * `pagespace mcp` (Phase 6 task 1) — serves the full operation registry as
 * an MCP stdio server. Authenticates exactly like every other command:
 * ONLY through `ctx.sdk`, built once by `run.ts`'s resolver (Phase 4 task 7
 * precedence, extended with the legacy credential env var support in
 * `auth/legacy-token-env.ts` — so existing `npx pagespace-mcp` configs keep
 * working). This file never constructs its own client and never reads a
 * credential env var itself — see `commands/__tests__/single-auth-path.test.ts`,
 * which enforces that structurally across every command module.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { buildOperationRegistry, createMcpServer } from '../mcp/serve.js';

export interface McpHandlerDeps {
  readonly createTransport: () => Transport;
}

export function createMcpHandler(deps: McpHandlerDeps): CommandHandler {
  return async (ctx) => {
    const registry = buildOperationRegistry();
    const server = createMcpServer({ registry, sdk: ctx.sdk });

    ctx.stderr.write(`pagespace mcp: serving ${registry.all.length} tools over stdio\n`);

    try {
      await server.connect(deps.createTransport());
    } catch (error) {
      ctx.stderr.write(`Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    return EXIT_SUCCESS;
  };
}

export const mcpHandler: CommandHandler = createMcpHandler({
  createTransport: () => new StdioServerTransport(),
});
