/**
 * Fly TLS certificates for custom domains — the REST certificates resource.
 *
 * PORTED OFF GRAPHQL. This module used to POST hand-written mutations to
 * `api.fly.io/graphql` (`addCertificate(appId:)`, `app(name:){certificate}`).
 * Two things were wrong with that beyond it being the legacy API:
 *
 *   1. The GraphQL response is `{configured, clientStatus, hostname}` and nothing
 *      more, so a certificate stuck in validation was indistinguishable from one
 *      about to issue — the customer got "not configured yet" forever with no
 *      instruction. The REST resource returns `dns_requirements` and
 *      `validation`, which name the exact records that are missing, including
 *      the `_fly-ownership` TXT that has no GraphQL equivalent at all.
 *   2. It carried its own bespoke `fetch`, timeout and error parsing, duplicating
 *      what `services/fly/flaps-client.ts` already does properly — including
 *      Fly's per-object rate limiting (~1 r/s, burst 3), which this path hit
 *      unprotected every time the domains list lazily reconciled several rows.
 *
 * So the transport is now the shared flaps client and the shape of the answer is
 * unchanged: `FlyCertResponse` is still what `nextCertAction` consumes, extended
 * additively with the ownership fields. Existing callers do not change.
 *
 * TOKEN: `FLY_API_TOKEN` stays the primary credential so no deployment has to be
 * reconfigured for this port; `FLY_MACHINES_ORG_TOKEN` is accepted as a fallback
 * because it is the same class of org-scoped credential and a deployment that has
 * configured published-app hosting has already set it.
 */

import type { FlyCertResponse } from '@pagespace/lib/canvas/cert-action';
import type { FlyOwnershipRequirement } from '@pagespace/lib/validators/fly-ownership';
import {
  checkCertificate,
  deleteCertificate,
  getCertificate as getFlyCertificate,
  requestAcmeCertificate,
  FlapsError,
  type FlapsTransport,
  type FlyCertificate,
} from '@pagespace/lib/services/fly/flaps-client';

/** A certificate is live and servable when Fly reports its status as active. */
const CERT_ACTIVE_STATUS = 'active';

function resolveToken(): string {
  return process.env.FLY_API_TOKEN || process.env.FLY_MACHINES_ORG_TOKEN || '';
}

/**
 * The transport, or null when no credential is configured.
 *
 * Null rather than an empty-token transport: an unauthenticated request to Fly
 * would spend the retry budget on three guaranteed 401s before reporting a
 * failure that was knowable before the first one.
 */
function transportOrNull(): FlapsTransport | null {
  const token = resolveToken();
  return token ? { token } : null;
}

const NO_TOKEN: FlyCertResponse = {
  ok: false,
  error: 'FLY_API_TOKEN is not configured',
};

/** Normalize Fly's ownership requirement, dropping a half-populated one. */
export function ownershipRequirementOf(cert: FlyCertificate): FlyOwnershipRequirement | null {
  const ownership = cert.dns_requirements?.ownership;
  if (!ownership) return null;
  const name = typeof ownership.name === 'string' ? ownership.name : '';
  const appValue = typeof ownership.app_value === 'string' ? ownership.app_value : '';
  const orgValue = typeof ownership.org_value === 'string' ? ownership.org_value : '';
  // A requirement with no name and no value names nothing the customer can act
  // on; reporting it would produce an instruction with blanks in it.
  if (!name || (!appValue && !orgValue)) return null;
  return { name, appValue, orgValue };
}

/** Map a Fly certificate onto the response shape `nextCertAction` consumes. */
function certToResponse(cert: FlyCertificate | null): FlyCertResponse {
  if (!cert) return { ok: false, error: 'Fly did not return a certificate' };
  return {
    ok: true,
    // Keyed off `status`, not the `configured` boolean: `configured` reflects DNS
    // configuration, and a hostname can be correctly configured for minutes
    // before a certificate is actually issued. This is the same distinction the
    // GraphQL path drew with `clientStatus === 'Ready'`.
    configured: cert.status === CERT_ACTIVE_STATUS,
    status: typeof cert.status === 'string' ? cert.status : undefined,
    ownership: ownershipRequirementOf(cert),
    ownershipTxtConfigured: cert.validation?.ownership_txt_configured === true,
  };
}

/** Turn a thrown Flaps failure into the module's error response. */
function toErrorResponse(err: unknown): FlyCertResponse {
  if (err instanceof FlapsError) return { ok: false, error: err.message };
  return { ok: false, error: err instanceof Error ? err.message : 'Unknown Fly API error' };
}

/**
 * Ensure a certificate exists for `hostname` on `appName`, and report its state.
 *
 * READS BEFORE IT WRITES, which the GraphQL version could not do cheaply: a GET
 * that finds an existing certificate returns its full validation state without
 * asking Fly to request anything, so the poll cycle this function serves (the
 * domains-list lazy reconcile calls it on every load) stops being a stream of
 * mutations. Only a hostname Fly has never seen reaches the ACME request.
 *
 * Idempotent either way — `requestAcmeCertificate` resolves an "already exists"
 * race back to the existing certificate — so concurrent reconciles converge.
 */
export async function addCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const transport = transportOrNull();
  if (!transport) return NO_TOKEN;
  try {
    const existing = await getFlyCertificate(transport, appName, hostname);
    if (existing) return certToResponse(existing);
    return certToResponse(await requestAcmeCertificate(transport, appName, hostname));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Ask Fly to RE-READ the hostname's DNS and re-evaluate validation.
 *
 * The endpoint behind "the customer says they added the record". Without it, a
 * hostname whose DNS was fixed sits at Fly's own polling cadence; with it, the
 * settings UI's "Check SSL" actually checks.
 */
export async function recheckCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const transport = transportOrNull();
  if (!transport) return NO_TOKEN;
  try {
    return certToResponse(await checkCertificate(transport, appName, hostname));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Detach a hostname from the router app.
 *
 * Certificates bill per hostname ($0.10/mo beyond the first ten), so a domain
 * removed from a drive has to be removed from Fly too or it bills forever with
 * nothing in our database pointing at it. Idempotent: a hostname Fly does not
 * have is already in the desired state.
 */
export async function removeCertificate(
  appName: string,
  hostname: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const transport = transportOrNull();
  if (!transport) return { ok: false, error: 'FLY_API_TOKEN is not configured' };
  try {
    await deleteCertificate(transport, appName, hostname);
    return { ok: true };
  } catch (err) {
    const mapped = toErrorResponse(err);
    return mapped.ok ? { ok: true } : { ok: false, error: mapped.error };
  }
}
