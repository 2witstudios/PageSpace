import type { TakedownRequest, TakedownResponse } from '@pagespace/lib/content-safety/takedown-request';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * The admin app's one way to run a content takedown: hand it to the web app.
 *
 * Takedown deletes objects from the private uploads bucket and the public
 * publish bucket. Only the web app holds credentials for both; the admin app
 * has no S3 access at all. So the admin route authenticates the admin, audits
 * the action, and proxies here — the same server-to-server pattern as the
 * global-prompt proxy (`WEB_APP_INTERNAL_URL` + `SERVICE_API_SECRET`).
 */
export type WebTakedownResult =
  | { ok: true; status: number; body: TakedownResponse }
  | { ok: false; status: number; error: string };

const TAKEDOWN_PATH = '/api/internal/content-safety/takedown';
/**
 * A takedown lists and deletes across two buckets and may run a message search
 * with a 120-second statement timeout; this must be longer than that, or a slow
 * search would surface here as "could not reach the web app".
 */
const TIMEOUT_MS = 180_000;

export async function callWebTakedown(request: TakedownRequest, adminUserId: string): Promise<WebTakedownResult> {
  const webUrl = process.env.WEB_APP_INTERNAL_URL ?? process.env.NEXT_PUBLIC_WEB_APP_URL;
  const serviceSecret = process.env.SERVICE_API_SECRET;

  if (!webUrl || !serviceSecret) {
    loggers.security.warn('Content takedown proxy not configured: WEB_APP_INTERNAL_URL or SERVICE_API_SECRET missing');
    return {
      ok: false,
      status: 503,
      error: 'Content takedown is not configured on this host. Set WEB_APP_INTERNAL_URL and SERVICE_API_SECRET.',
    };
  }

  let upstream: Response;
  try {
    upstream = await fetch(new URL(TAKEDOWN_PATH, webUrl).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-secret': serviceSecret,
        'x-service-user-id': adminUserId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    loggers.security.error('Content takedown proxy error', error instanceof Error ? error : undefined, { action: request.action });
    return { ok: false, status: 502, error: 'Failed to reach the web app. The takedown may not have run; check the case list before retrying.' };
  }

  const body = (await upstream.json().catch(() => null)) as (TakedownResponse & { error?: string }) | null;
  if (!upstream.ok || !body) {
    return { ok: false, status: upstream.ok ? 502 : upstream.status, error: body?.error ?? `Web app answered ${upstream.status}` };
  }
  return { ok: true, status: upstream.status, body };
}
