/**
 * MCP token management operations (Phase 4 task 6) — net-new registry
 * entries backing `pagespace tokens create/list/revoke`.
 *
 * Route-verified against `apps/web/src/app/auth/mcp-tokens/route.ts`
 * (POST/GET) and `.../mcp-tokens/[tokenId]/route.ts` (DELETE). The server
 * owns all scope-capping (MEMBER-cannot-grant-ADMIN, custom-role ownership,
 * drive-access checks) — this module only shapes the request/response, never
 * re-implements that authority decision.
 *
 * `listMcpTokens`'s output schema deliberately has no `token` field: even if
 * a buggy or compromised server included one, zod's default
 * unknown-key-stripping on `z.object()` silently discards it before it ever
 * reaches the CLI's display logic. The server can't return it anyway (hashes
 * only at rest) — this is defense in depth, not the primary guarantee.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const driveScopeInputSchema = z.strictObject({
  id: z.string(),
  role: z.enum(['ADMIN', 'MEMBER']).nullish(),
  customRoleId: z.string().optional(),
});

const driveScopeOutputSchema = z.object({ id: z.string(), name: z.string() });

export const createMcpToken = defineOperation({
  name: 'tokens.create',
  method: 'POST',
  path: '/api/auth/mcp-tokens',
  inputSchema: z.strictObject({
    name: z.string().min(1).max(100),
    drives: z.array(driveScopeInputSchema).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    token: z.string(),
    createdAt: z.string(),
    lastUsed: z.string().nullable(),
    driveScopes: z.array(driveScopeOutputSchema),
  }),
  requiredScope: 'account',
  description:
    'Create a new MCP token, optionally scoped to one or more drives with a role/custom-role downgrade. The plaintext token is returned exactly once in this response — the server never returns it again.',
});

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
