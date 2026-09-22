/**
 * Identity confirmation after login — `client.auth.me()`, the SDK's own
 * `auth.me` operation (`GET /api/auth/me`, Bearer-authed), shared by
 * `pagespace login`, `login --device`, `keys` and `whoami`. Before ADR 0004
 * Decision 11 the CLI declared a private copy of that operation; the SDK
 * now owns it, with an output schema that reads both the full first-party
 * body and the profile-only body a third-party app gets.
 */
import { getAuthMe, PageSpaceClient, StaticTokenProvider, defineOperation } from '@pagespace/sdk';
import type { ConfirmIdentity, Identity } from './loopback-flow.js';

/**
 * The SDK's `auth.me`, projected to the two fields the CLI renders. Kept as a
 * public export for existing importers; `confirmIdentity` itself calls the
 * facade, `client.auth.me()`.
 */
export const whoamiOperation = defineOperation({
  name: getAuthMe.name,
  method: getAuthMe.method,
  path: getAuthMe.path,
  inputSchema: getAuthMe.inputSchema,
  outputSchema: getAuthMe.outputSchema.pick({ name: true, email: true }),
  requiredScope: getAuthMe.requiredScope,
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
  const me = await client.auth.me({});
  return { name: me.name, email: me.email };
};
