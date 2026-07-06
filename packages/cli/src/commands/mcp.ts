/**
 * `pagespace mcp` (Phase 6 task 1) — serves the full operation registry as
 * an MCP stdio server. Every other command's ambient fallback to the
 * default/personal profile (`auth/resolve.ts`'s `--token` flag > env var >
 * stored profile precedence) is legitimate convenience for a human who
 * already proved who they are at a prompt. `mcp`'s entire purpose, by
 * contrast, is being invoked unattended by an automated MCP client — there
 * is no legitimate case where it should inherit the human's personal
 * credential behind that client's back (Phase 8 task 4). So before doing
 * anything else, this handler runs `hasExplicitCredential` — a pure
 * predicate over the parsed flags/env, deliberately independent of
 * `resolveAuth`/`resolveProfileName`, which both intentionally fall back to
 * the stored "default" profile — and refuses to start the stdio server at
 * all unless this invocation names a credential itself. `run.ts` runs this
 * same check even earlier, before dispatching here at all — needed because
 * by the time this handler runs, `run.ts` has already resolved and would
 * otherwise be about to enforce the ambient auth source (a real
 * discovery+refresh network call, and a credential rotation, for a stored
 * default profile) via `enforceAuth`. The check here is what makes this
 * handler safe to call directly (as the unit tests below do, bypassing
 * `run.ts` entirely) rather than a redundant no-op. Once past both gates,
 * it authenticates through `ctx.sdk` exactly like every other
 * command, ONLY through the resolver built once by `run.ts` (Phase 4 task 7
 * precedence, extended with the legacy credential env var support in
 * `auth/legacy-token-env.ts` — so existing `npx pagespace-mcp` configs keep
 * working). This file never constructs its own client and never reads a
 * credential env var itself — see `commands/__tests__/single-auth-path.test.ts`,
 * which enforces that structurally across every command module.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { hasExplicitCredential, noExplicitCredentialMessage } from '../auth/resolve.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { buildOperationRegistry, createMcpServer } from '../mcp/serve.js';

export interface McpHandlerDeps {
  readonly createTransport: () => Transport;
}

export function createMcpHandler(deps: McpHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    if (!hasExplicitCredential({ token: intent.flags.token, profile: intent.flags.profile }, ctx.env)) {
      ctx.stderr.write(`${noExplicitCredentialMessage()}\n`);
      return EXIT_RUNTIME_ERROR;
    }

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
