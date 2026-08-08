/**
 * `pagespace mcp` (Phase 6 task 1) — serves the full operation registry as
 * an MCP stdio server. Every other command's ambient fallback to the
 * default/personal profile (`auth/resolve.ts`'s `--token` flag > env var >
 * stored profile precedence) is legitimate convenience for a human who
 * already proved who they are at a prompt. `mcp`'s entire purpose, by
 * contrast, is being invoked unattended by an automated MCP client — there
 * is no legitimate case where it should inherit the human's personal
 * credential behind that client's back (Phase 8 task 4). So before touching
 * `ctx.sdk`, this handler runs `hasExplicitCredential` — a pure predicate
 * over the parsed flags/env, deliberately independent of `resolveAuth`/
 * `resolveProfileName`, which both intentionally fall back to the stored
 * "default" profile. Without an explicit credential it still SERVES (an MCP
 * client can only see a pre-transport exit as a hung server — the failure
 * mode this command shipped with, indistinguishable from hours of downtime
 * behind a spawning client like ChatGPT desktop), but through a stub sdk
 * whose every call fails with the actionable message; `ctx.sdk` is never
 * consulted. `run.ts` enforces the same invariant even earlier via the
 * `lazyAuth` route property: with nothing explicit named it never calls
 * `resolveCredentialSource` at all (the ambient stored credential is never
 * even read), and with a credential named it defers resolution — the
 * keychain read, discovery, refresh — to the first tool call via
 * `createLazyAuthProvider`, so `initialize`/`tools/list` always answer
 * immediately. The check here is what makes this handler safe to call
 * directly (as the unit tests below do, bypassing `run.ts` entirely) rather
 * than a redundant no-op. With a credential named, it authenticates through
 * `ctx.sdk` exactly like every other command, ONLY through the resolver
 * built once by `run.ts` (Phase 4 task 7 precedence, extended with the
 * legacy credential env var support in `auth/legacy-token-env.ts` — so
 * existing `npx pagespace-mcp` configs keep working). This file never
 * constructs its own client and never reads a credential env var itself —
 * see `commands/__tests__/single-auth-path.test.ts`, which enforces that
 * structurally across every command module.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthenticationError } from '@pagespace/sdk';
import { hasExplicitCredential, mcpNoExplicitCredentialMessage } from '../auth/resolve.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { buildOperationRegistry, createMcpServer, type McpSdkClient } from '../mcp/serve.js';

export interface McpHandlerDeps {
  readonly createTransport: () => Transport;
}

export function createMcpHandler(deps: McpHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    // The mcp variant of the refusal message: the active key (`pagespace
    // keys use`) deliberately does NOT apply to `pagespace mcp` — an MCP
    // config must name its credential explicitly (--key/PAGESPACE_KEY or
    // --token), never ride the human's per-machine activation.
    //
    // Refusing here must NOT mean refusing to serve: an MCP client can only
    // observe a child that exits before its transport connects as a hung
    // server (the old `pagespace-mcp` npm package always served and failed
    // per-call, which is what every migrated config's client is built
    // against). So the credential-less case serves the registry anyway and
    // fails every `tools/call` with the actionable message — through a stub
    // sdk, NOT `ctx.sdk`, keeping the Phase 8 invariant structural: even if
    // a run.ts regression someday wired an ambient credential into
    // `ctx.sdk`, this handler still could not use it without a credential
    // named in this invocation itself.
    const explicit = hasExplicitCredential({ token: intent.flags.token, key: intent.flags.key }, ctx.env);
    const sdk: McpSdkClient = explicit
      ? ctx.sdk
      : {
          invoke: async () => {
            throw new AuthenticationError(mcpNoExplicitCredentialMessage());
          },
        };

    const registry = buildOperationRegistry();
    const server = createMcpServer({ registry, sdk });

    if (!explicit) {
      ctx.stderr.write(`${mcpNoExplicitCredentialMessage()}\n`);
    }
    ctx.stderr.write(
      `pagespace mcp: serving ${registry.all.length} tools over stdio${explicit ? '' : ' (no credential — every tool call will fail until one is configured)'}\n`,
    );

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
