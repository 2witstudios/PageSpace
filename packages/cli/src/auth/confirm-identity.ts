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

export const confirmIdentity: ConfirmIdentity = async ({ host, accessToken }): Promise<Identity> => {
  const client = new PageSpaceClient({ baseUrl: host, auth: new StaticTokenProvider(accessToken) });
  const result = await client.invoke(whoamiOperation, {});
  return { name: result.name, email: result.email };
};
