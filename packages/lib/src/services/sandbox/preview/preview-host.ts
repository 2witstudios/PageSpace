/**
 * Preview HOST naming — pure, dependency-free, edge-safe.
 *
 * Split out of `preview-grant.ts` (which needs `node:crypto`) so the web
 * app's Edge middleware — which must stay a graph of leaf modules — can ask
 * "is this request's Host a preview host, and for which holder?" without
 * pulling Node built-ins into the Edge bundle. Everything here is a string
 * function; the security reasoning lives in `preview-grant.ts`'s header and
 * `dev-preview-env.ts` (the dedicated-apex rule).
 */

import type { DevPreviewHolderRef } from './dev-preview-core';

const APEX_SHAPE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HOLDER_ID_SHAPE = /^[a-z0-9]{1,64}$/;
const HOST_KIND_LABEL: Record<DevPreviewHolderRef['kind'], string> = { workspace: 'ws', env: 'env' };

/**
 * Pure: normalize a configured apex, or `null` when it is unset, malformed,
 * or — the cookie-tossing guard — the same registrable domain as (or a
 * parent/child of) `appHost`, the host the app itself is served from.
 */
export function normalizeDevPreviewApex(raw: string | undefined, appHost: string | null): string | null {
  const apex = (raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!APEX_SHAPE.test(apex)) return null;
  if (appHost) {
    const app = appHost.split(':')[0].toLowerCase();
    if (app === apex || app.endsWith(`.${apex}`) || apex.endsWith(`.${app}`)) return null;
    // Siblings share a registrable domain too (`previews.pagespace.ai` vs
    // `app.pagespace.ai`): a `Domain=.pagespace.ai` cookie set from the
    // former reaches the latter. No Public Suffix List is available to an
    // edge leaf, so the registrable domain is approximated CONSERVATIVELY:
    // if the apex and the app host agree on their last two labels — or on
    // their last three when the second label is short (`co.uk`, `com.au`) —
    // they are treated as the same registrable domain and the apex is
    // refused. A false refusal costs a rename; a false accept costs the
    // cookie boundary.
    if (registrableDomain(app) === registrableDomain(apex)) return null;
  }
  return apex;
}

/** Pure, PSL-free approximation of the registrable domain (see {@link normalizeDevPreviewApex}). */
function registrableDomain(hostname: string): string {
  const labels = hostname.split('.');
  const take = labels.length >= 3 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Pure: the preview host for a holder. Throws on an id that cannot be a label (never a client input — ids come from authorized rows). */
export function buildPreviewHost(holder: DevPreviewHolderRef, apex: string): string {
  if (!HOLDER_ID_SHAPE.test(holder.id)) throw new Error('preview holder id is not a valid host label');
  return `${HOST_KIND_LABEL[holder.kind]}-${holder.id}.preview.${apex}`;
}

/** Pure: the holder a request's `Host` names, or null when the host is not a preview host under `apex`. */
export function parsePreviewHost(host: string | null | undefined, apex: string): DevPreviewHolderRef | null {
  if (!host) return null;
  const hostname = host.split(':')[0].toLowerCase();
  const suffix = `.preview.${apex}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  const match = /^(ws|env)-([a-z0-9]{1,64})$/.exec(label);
  if (!match) return null;
  return { kind: match[1] === 'ws' ? 'workspace' : 'env', id: match[2] };
}

/** Pure: the app-origin CSP `frame-src` entry that admits every preview host and nothing else. */
export function previewFrameSrcEntry(apex: string): string {
  return `https://*.preview.${apex}`;
}

/** The web-tier mount the middleware rewrites a preview-host request onto: `<prefix>/<kind>/<holderId><original path>`. */
export const DEV_PREVIEW_HOST_ROUTE_PREFIX = '/api/dev-preview/host';

/** Pure: the internal path a preview-host request is rewritten to. The original pathname rides along verbatim. */
export function rewritePreviewHostPath(holder: DevPreviewHolderRef, pathname: string): string {
  return `${DEV_PREVIEW_HOST_ROUTE_PREFIX}/${holder.kind}/${holder.id}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
