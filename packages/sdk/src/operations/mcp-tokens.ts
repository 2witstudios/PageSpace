/**
 * MCP token management operations (Phase 4 task 6) — registry entries
 * backing `pagespace keys list/revoke`.
 *
 * Route-verified against `apps/web/src/app/api/auth/mcp-tokens/route.ts`
 * (GET) and `.../mcp-tokens/[tokenId]/route.ts` (DELETE). The server owns
 * all scope-capping (MEMBER-cannot-grant-ADMIN, custom-role ownership,
 * drive-access checks) — this module only shapes the request/response, never
 * re-implements that authority decision.
 *
 * There is deliberately NO `tokens.create` operation. The server locked
 * POST /api/auth/mcp-tokens to session auth (Phase 8 #1878, a
 * credential-minting-escalation fix), and neither credential class the SDK
 * documents — `mcp_` API keys or `ps_at_` OAuth access tokens — is accepted
 * there. Session credentials are reserved for first-party surfaces (browser
 * cookie sessions, and the desktop/mobile apps' Bearer session tokens);
 * they are not an SDK-supported credential, and shipping a typed minting
 * method usable only via one would reopen the silent, agent-runnable
 * key-minting affordance Phase 8 closed. Key MINTING happens via the OAuth
 * authorize/consent flow (`pagespace keys create`) or the web UI. Both
 * remaining operations require an `oauth_`-class access token (from
 * `pagespace login` / the OAuth flow) or a web session — the routes reject
 * `mcp_` tokens.
 *
 * `listMcpTokens`'s output schema deliberately has no `token` field: even if
 * a buggy or compromised server included one, zod's default
 * unknown-key-stripping on `z.object()` silently discards it before it ever
 * reaches the CLI's display logic. The server can't return it anyway (hashes
 * only at rest) — this is defense in depth, not the primary guarantee.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const driveScopeOutputSchema = z.object({ id: z.string(), name: z.string() });

export const listMcpTokens = defineOperation({
  name: 'tokens.list',
  method: 'GET',
  path: '/api/auth/mcp-tokens',
  inputSchema: z.strictObject({}),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tokenPrefix: z.string(),
      lastUsed: z.string().nullable(),
      createdAt: z.string(),
      isScoped: z.boolean(),
      driveScopes: z.array(driveScopeOutputSchema),
    }),
  ),
  requiredScope: 'account',
  description: "List the caller's MCP tokens. Never includes the plaintext token — only its prefix.",
});

export const revokeMcpToken = defineOperation({
  name: 'tokens.revoke',
  method: 'DELETE',
  path: '/api/auth/mcp-tokens/:tokenId',
  inputSchema: z.strictObject({ tokenId: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  requiredScope: 'account',
  destructive: true,
  description: 'Revoke (soft-delete) an MCP token by id. Irreversible — the CLI requires --yes.',
});
