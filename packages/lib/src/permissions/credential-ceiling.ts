import { z } from 'zod';
import type { DriveScopeRow } from '../auth/oauth/scopes';

/**
 * A drive-scoped credential's ceiling, in ONE principal-neutral shape.
 *
 * A scoped `mcp_` key and a drive-scoped OAuth grant are the same thing to the
 * permission model (ADR 0002 Decision 2): the user, narrowed to some drives,
 * optionally weakened by an explicit role per drive. They differ only in where
 * the per-drive rows live — `mcp_token_drives` for a key (resolved live, by
 * token id), the consented scope set for a grant (carried as rows). This type
 * names which, and the web app's ceiling resolvers (`apps/web/src/lib/auth/
 * credential-ceiling.ts`) are the only place that branches on it,
 * so every consumer — the request principal, the agent-tool layer, a signed
 * dispatch hop, a persisted deferred run — asks one question and cannot forget
 * a credential kind.
 *
 * Serializable by construction (it crosses the agent-dispatch hop and is
 * persisted with deferred runs): parse it with {@link credentialCeilingSchema}
 * wherever it arrives from outside the process.
 */
export type CredentialCeiling =
  | { readonly kind: 'mcp'; readonly tokenId: string }
  | { readonly kind: 'oauth'; readonly driveScopes: DriveScopeRow[] };

const driveScopeRowSchema = z
  .object({
    driveId: z.string().min(1),
    role: z.enum(['ADMIN', 'MEMBER']).nullable(),
    customRoleId: z.string().min(1).nullable(),
  })
  .strict();

export const credentialCeilingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mcp'), tokenId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('oauth'), driveScopes: z.array(driveScopeRowSchema) }).strict(),
]);
