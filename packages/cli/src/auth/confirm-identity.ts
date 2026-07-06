/**
 * Identity confirmation after login (Phase 4 task 3) — a `whoami`-style call
 * through the SDK's own invoke pipeline (`GET /api/auth/me`, Bearer-authed),
 * unlike the token exchange this fits the registry perfectly: a GET with no
 * body, authenticated with the access token login just obtained. Reused
 * verbatim by `pagespace whoami` (Phase 4 task 5).
 */
import { z } from 'zod';
import { defineOperation, PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';
import type { ConfirmIdentity, Identity } from './loopback-flow.js';

const meOutputSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});

export const whoamiOperation = defineOperation({
  name: 'auth.me',
  method: 'GET',
  path: '/api/auth/me',
  inputSchema: z.object({}),
  outputSchema: meOutputSchema,
  requiredScope: 'account',
  description: "Confirm the authenticated user's identity (name/email).",
});

/**
 * This call is purely cosmetic (a nicer "Logged in as NAME <email>" message) —
 * by the time it runs, the token exchange and credential persistence have
 * already succeeded. Bound it to a short, deterministic budget with no
 * retries so a slow/unresponsive server can never stall CLI exit waiting on
 * this call; a failure here is silently absorbed by the caller (loopback-flow.ts).
 */
export const CONFIRM_IDENTITY_TIMEOUT_MS = 3_000;

export const confirmIdentity: ConfirmIdentity = async ({ host, accessToken }): Promise<Identity> => {
  const client = new PageSpaceClient({
    baseUrl: host,
    auth: new StaticTokenProvider(accessToken),
    timeoutMs: CONFIRM_IDENTITY_TIMEOUT_MS,
    retryPolicy: { maxRetries: 0 },
  });
  const result = await client.invoke(whoamiOperation, {});
  return { name: result.name, email: result.email };
};
