/**
 * Liveness probe for a credential that `GET /api/auth/me` cannot speak for.
 *
 * `mcp_*` keys are deliberately excluded from `/api/auth/me`
 * (`apps/web/src/app/api/auth/me/route.ts`): a scoped key is its own
 * drive-member principal, and resolving it to the personal owner behind it
 * would hand that owner's name/email to whoever holds the key. So `whoami`
 * cannot confirm a scoped key by asking "who am I?" — the honest question for
 * a scoped key is "does this key still work, and what can it reach?", which
 * `drives.list` answers with the smallest authenticated call the key is
 * already entitled to make.
 *
 * A rejection here is the real "this key was revoked" signal; the caller maps
 * it to the re-mint remediation, never to "run pagespace login" (a scoped key
 * has no login session to refresh).
 */
import { PageSpaceClient, StaticTokenProvider } from '@pagespace/sdk';

export type ProbeDriveCount = (params: { host: string; accessToken: string }) => Promise<number>;

/**
 * Same short, retry-free budget `confirmIdentity` uses (see
 * `confirm-identity.ts`): this is a status readout, so a slow or unresponsive
 * server must never stall CLI exit.
 */
export const PROBE_DRIVES_TIMEOUT_MS = 5_000;

export const probeDriveCount: ProbeDriveCount = async ({ host, accessToken }) => {
  const client = new PageSpaceClient({
    baseUrl: host,
    auth: new StaticTokenProvider(accessToken),
    timeoutMs: PROBE_DRIVES_TIMEOUT_MS,
    retryPolicy: { maxRetries: 0 },
  });
  const drives = await client.drives.list({});
  return drives.length;
};
