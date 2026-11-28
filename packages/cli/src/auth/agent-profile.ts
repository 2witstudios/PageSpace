/**
 * Who an account token belongs to, including whether it is an AI agent and
 * who (if anyone) owns it — `GET /api/auth/me`'s additive ADR 0008 fields
 * (`accountType`, and for an agent `agent.ownerUserId`/`claimedAt`/`source`).
 *
 * Deliberately separate from `confirm-identity.ts`'s `whoamiOperation`, whose
 * name/email-only output the human `login`/`whoami` paths are pinned to.
 * Builds its own client around a token the caller just obtained — the
 * sanctioned `auth/` shape (see `confirm-identity.ts`).
 */
import { z } from 'zod';
import { defineOperation, PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

export const accountProfileOperation = defineOperation({
  name: 'auth.meProfile',
  method: 'GET',
  path: '/api/auth/me',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({
    id: z.string().min(1),
    name: z.string().nullable(),
    // Older servers predate the field; every account they know is a human one.
    accountType: z.enum(['human', 'agent']).default('human'),
    agent: z
      .object({
        ownerUserId: z.string().nullable(),
        claimedAt: z.string().nullable(),
        source: z.string().nullable(),
      })
      .nullable()
      .default(null),
  }),
  requiredScope: 'account',
  description: "The authenticated account's id, name, account type and (for an AI agent) its owner.",
});

export interface AccountProfile {
  readonly id: string;
  readonly name: string | null;
  readonly accountType: 'human' | 'agent';
  /** Null for a human; for an agent, null `ownerUserId` means unclaimed. */
  readonly agent: { readonly ownerUserId: string | null; readonly claimedAt: string | null; readonly source: string | null } | null;
}

export type FetchAccountProfile = (params: { host: string; accessToken: string }) => Promise<AccountProfile>;

export const fetchAccountProfile: FetchAccountProfile = async ({ host, accessToken }) => {
  const client = new PageSpaceClient({
    baseUrl: host,
    auth: new StaticTokenProvider(accessToken),
    timeoutMs: 5_000,
    retryPolicy: { maxRetries: 0 },
  });
  return client.invoke(accountProfileOperation, {});
};
