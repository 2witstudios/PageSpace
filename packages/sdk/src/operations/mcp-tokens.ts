/**
 * MCP token management operations (Phase 4 task 6) — registry entries
 * backing `pagespace keys list/revoke`, plus the self-description operation
 * behind `pagespace keys describe`.
 *
 * Two different authorities, deliberately kept apart. `tokens.list`/
 * `tokens.revoke` reach the key-MANAGEMENT surface, which only a full-user
 * credential may touch — enumerating or revoking every key a person holds is
 * not something one scoped key should be able to do to the others.
 * `tokens.describeSelf` asks only about the credential presenting itself, so
 * it accepts every credential class including `mcp_`.
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
 * remaining operations require a `ps_at_` OAuth access token (from
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

/**
 * The role stored on each `mcp_token_drives` row. `null` is INHERIT — the key
 * acts as its owner in that drive (see apps/web/src/lib/auth/principal-permissions.ts).
 * The server has always returned these three fields
 * (`sessionRepository.findUserMcpTokensWithDrives`); the schema simply never
 * declared them, so zod's unknown-key stripping discarded the answer to "what
 * can this key do" before the CLI could print it (issue #2470).
 */
const driveScopeOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).nullable().default(null),
  customRoleId: z.string().nullable().default(null),
  customRoleName: z.string().nullable().default(null),
});

/** The four-flag answer `@pagespace/lib`'s `PermissionLevel` carries, over the wire. */
const effectivePermissionsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
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

/**
 * What THIS credential is and what it can actually do, resolved server-side.
 *
 * The counterpart to `tokens.list`, and deliberately not a variant of it: a key
 * describes ITSELF and never another key, so the route it calls
 * (`GET /api/auth/key`) can accept the `mcp_` credential class that the
 * key-MANAGEMENT routes refuse. `driveScopes[].role` is the raw grant;
 * `driveScopes[].permissions` is the resolved answer — the same
 * `getAppDriveAccessLevel`/`getScopedDriveAccessLevel`/`getUserAccessLevel`
 * resolution every content route authorizes through, not a second reading of
 * the role vocabulary.
 *
 * Two different questions, and the difference matters. `driveScopes[].permissions`
 * answers it for the DRIVE AS A WHOLE — creating a top-level page, sharing or
 * deleting the drive — where any membership at all grants edit. A PAGE resolves
 * separately and can be strictly narrower: a plain MEMBER may create at the
 * drive root and still be view-only on a document inside it, which is exactly
 * the "reads fine, every write fails" shape issue #2470 was filed about. Pass
 * `pageId` to get that page's own resolution alongside, so a caller about to
 * write somewhere specific can ask about that place instead of inferring.
 *
 * No identity fields: `/api/auth/me` refuses `mcp_` tokens precisely so that
 * holding a scoped key never yields its owner's name or email
 * (packages/cli/src/auth/probe-drives.ts), and this operation must not become
 * the back door to the same thing.
 */
export const describeSelfKey = defineOperation({
  name: 'tokens.describeSelf',
  method: 'GET',
  path: '/api/auth/key',
  inputSchema: z.strictObject({
    /** Optional: also resolve this specific page, whose permissions can be narrower than the drive's. */
    pageId: z.string().optional(),
  }),
  outputSchema: z.object({
    credential: z.object({
      /** `session` appears only when a first-party surface calls this; the SDK's own credentials are `mcp` or `oauth`. */
      type: z.enum(['mcp', 'oauth', 'session']),
      /** Whether the credential is confined to a drive set at all. `false` = it acts as its owner everywhere. */
      scoped: z.boolean(),
      /** Present for `mcp` only — an OAuth access token and a session have no key row to name. */
      id: z.string().nullable(),
      name: z.string().nullable(),
      tokenPrefix: z.string().nullable(),
      createdAt: z.string().nullable(),
      lastUsed: z.string().nullable(),
    }),
    driveScopes: z.array(
      driveScopeOutputSchema.extend({
        /** How `role` was arrived at, since `null` is meaningful rather than missing. */
        roleSource: z.enum(['explicit', 'custom', 'inherited']),
        permissions: effectivePermissionsSchema,
      }),
    ),
    /**
     * Set only when `pageId` was given. `permissions: null` means the page is
     * out of reach entirely (another drive, or a private page this credential
     * cannot see) — deliberately not flattened to all-false, which would read
     * as "the page is here and you may do nothing with it".
     */
    page: z
      .object({ id: z.string(), permissions: effectivePermissionsSchema.nullable() })
      .nullable()
      .default(null),
  }),
  description:
    "Describe the credential making this call: its drive scopes, the role granted in each, and the effective permissions (view/edit/share/delete) that role actually resolves to. Drive-level permissions cover the drive itself (creating a top-level page, sharing or deleting the drive); a specific page can be narrower, so pass pageId to resolve that page too. Answers \"what am I allowed to do here?\" without probing by attempting writes. Describes only itself — never another key.",
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
