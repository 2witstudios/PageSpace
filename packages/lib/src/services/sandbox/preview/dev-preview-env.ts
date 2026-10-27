/**
 * dev-preview-env — the dev-preview kill switch and the preview APEX.
 *
 * Both read from `process.env` DIRECTLY, not via `getValidatedEnv()`, for the
 * same reason `isCodeExecutionEnabled()` and `isAppHostingEnabled()` are:
 * these run in the web tier (the HTTP proxy, the grant mint) AND the realtime
 * tier (the WebSocket half of the proxy, the `ports/watch` detection loop),
 * and realtime's lean env makes `getValidatedEnv()` THROW — which would flip
 * the switch OFF there even when it is correctly set. Non-secret string reads
 * are the right shape.
 *
 * `DEV_PREVIEW_ENABLED` — default OFF: only the literal string `'true'`
 * enables. Everything the preview workstream ships is dark behind this — the
 * proxy 404s, the grant mint 404s, the WebSocket half refuses the upgrade,
 * detection never opens a watch channel — so a deployment that never sets it
 * has no preview surface at all, not a broken one. Exposed to the client as a
 * CAPABILITY (`GET /api/dev-preview/capability`), never as a `NEXT_PUBLIC_*`
 * leak of the flag's mechanics — the same shape the publish surface uses.
 *
 * `DEV_PREVIEW_APEX` — the DEDICATED registrable domain preview hosts live
 * under (`<kind>-<holderId>.preview.<apex>`), e.g. `pagespace-preview.app`.
 * NO DEFAULT, FAIL CLOSED: unset means the feature is not configured and
 * behaves as disabled, because the one thing this value must never be is the
 * app's own registrable domain. A dev server's JS running on
 * `evil.preview.pagespace.ai` could set `Domain=.pagespace.ai` cookies and
 * toss a session onto the app (cookie fixation); a dedicated apex makes that
 * structurally impossible — the preview origins share no registrable domain
 * with anything that holds a PageSpace credential. Hosts under the apex are
 * additionally rejected outright if the apex looks like it is the app's own
 * (see {@link resolveDevPreviewApex}). Ops runbook: mint the wildcard DNS
 * record `*.preview.<apex>` and a wildcard certificate for it, route it to
 * the web app (HTTP) and the realtime app (WebSocket upgrades) — the
 * PageSpace-Deploy Caddy block shipped alongside this module.
 */

import { normalizeDevPreviewApex } from './preview-host';

export { normalizeDevPreviewApex };

export function isDevPreviewEnabled(): boolean {
  return process.env.DEV_PREVIEW_ENABLED === 'true';
}

/** The configured preview apex, or `null` (not configured ⇒ the feature is off). */
export function resolveDevPreviewApex(): string | null {
  let appHost: string | null = null;
  try {
    const webAppUrl = process.env.WEB_APP_URL;
    appHost = webAppUrl ? new URL(webAppUrl).host : null;
  } catch {
    appHost = null;
  }
  return normalizeDevPreviewApex(process.env.DEV_PREVIEW_APEX, appHost);
}

/** Enabled AND configured — the one question every preview entry point asks first. */
export function isDevPreviewConfigured(): boolean {
  return isDevPreviewEnabled() && resolveDevPreviewApex() !== null;
}
