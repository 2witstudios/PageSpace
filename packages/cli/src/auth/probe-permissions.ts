/**
 * Reads back what a JUST-MINTED key can actually do, using the key itself.
 *
 * Mint-time is the moment the answer matters most: a key minted `--role member`
 * looks identical to an admin one until the first write fails, and nothing in
 * the mint output ever said otherwise (issue #2470). Asking the server with the
 * new credential — rather than describing the role flags the user just typed —
 * is what makes this report the permissions that will actually gate requests,
 * resolved by the same code path those requests go through.
 *
 * Same shape and same budget as its neighbour `probe-drives.ts`: one short,
 * retry-free call built on its own client, so a slow server delays a mint's
 * closing summary and nothing else. Callers treat a failure as non-fatal — the
 * key is already minted and stored by the time this runs, and losing the summary
 * must never read as losing the key.
 *
 * Lives HERE rather than beside the `keys` commands for the same reason
 * `probe-drives.ts` does: a command module may never build its own client
 * (`commands/__tests__/single-auth-path.test.ts` enforces that structurally, so
 * every auth path stays the one `run.ts` resolved). A probe that must speak for
 * a credential `ctx.sdk` is NOT holding — here, the key that was just minted —
 * is an auth edge, and auth edges live in this directory where they are
 * reviewed as such.
 */
import { PageSpaceClient, StaticTokenProvider, describeSelfKey } from '@pagespace/sdk';
import type { z } from 'zod';

export type KeyDescription = z.infer<typeof describeSelfKey.outputSchema>;

export type DescribeKeyPermissions = (params: { host: string; accessToken: string }) => Promise<KeyDescription>;

/** Matches `PROBE_DRIVES_TIMEOUT_MS` — this is a closing summary, not a step the mint depends on. */
export const DESCRIBE_KEY_TIMEOUT_MS = 5_000;

export const describeKeyPermissions: DescribeKeyPermissions = async ({ host, accessToken }) => {
  const client = new PageSpaceClient({
    baseUrl: host,
    auth: new StaticTokenProvider(accessToken),
    timeoutMs: DESCRIBE_KEY_TIMEOUT_MS,
    retryPolicy: { maxRetries: 0 },
  });
  return client.invoke(describeSelfKey, {});
};
