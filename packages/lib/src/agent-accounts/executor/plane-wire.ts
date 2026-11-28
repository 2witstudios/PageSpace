/**
 * The web ↔ credential-plane wire shapes (L2·G2): one schema per route, used
 * by the plane to parse what arrives and by the client to type what it sends.
 * Nothing here is secret except `put.material`, which travels once, inbound,
 * over the plane's own listener, and is never echoed.
 */
import { z } from 'zod';
import type { PlaneConsenters } from '../store/store-adapter';

/** The kinds the plane holds and the HTTP executor presents (`api_key`, `bearer`, `oauth2`). */
export const PLANE_HTTP_KINDS = ['api_key', 'bearer', 'oauth2'] as const;
/** Every kind a plane ref may name on the wire. */
const PLANE_REF_KINDS = [...PLANE_HTTP_KINDS, 'ssh_key'] as const;
export type PlaneHttpKind = (typeof PLANE_HTTP_KINDS)[number];

const ref = z.object({ tenantId: z.string().min(1), accountId: z.string().min(1), kind: z.enum(PLANE_REF_KINDS) }).strict();

const material = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('api_key'),
      material: z.object({ value: z.string().min(1).max(8_192), placement: z.object({ in: z.enum(['header', 'query']), name: z.string().min(1).max(64) }).strict() }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal('bearer'), material: z.object({ token: z.string().min(1).max(8_192), expiresAt: z.number().int().positive().nullable() }).strict() }).strict(),
]);

const consenters = z.union([z.object({ kind: z.literal('owner') }).strict(), z.object({ kind: z.literal('pinned'), userIds: z.array(z.string().min(1)).min(1) }).strict()]);

export const planePutBody = z
  .object({
    ref,
    material,
    bindings: z.record(z.string(), z.unknown()),
    scope: z.record(z.string(), z.unknown()),
    consenters,
  })
  .strict();

export const planeRevokeBody = z.object({ ref }).strict();
/** Erase material wherever it is (Infisical is searched even without a plane metadata row). */
export const planeDeleteBody = z.object({ ref }).strict();

/** Metadata only: the plane's stored policy version and consenters for a ref — never material. */
export const planeDescribeBody = z.object({ ref }).strict();

/**
 * Rewrite the plane's bindings for a ref (ADR 0005 §2.2 `rebind`). The plane decides,
 * against ITS stored scope, whether this narrows (no consent) or widens (an
 * `OwnerConsent` signed under the consent key, from a consenter the plane pinned).
 */
export const planeRebindBody = z
  .object({
    ref,
    expectedVersion: z.number().int().min(1),
    bindings: z.record(z.string(), z.unknown()),
    scope: z.record(z.string(), z.unknown()),
    consenters,
    consent: z
      .object({
        consentId: z.string().min(1).max(128),
        consentingUserId: z.string().min(1).max(128),
        stepUpChallengeId: z.string().min(1).max(256),
        ref,
        bindingsDigest: z.string().min(1).max(256),
        consenters,
        issuedAt: z.number().int().positive(),
        signature: z.string().min(1).max(512),
      })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * Connect an OAuth account: the plane exchanges the authorization code at the provider's PINNED token
 * endpoint with ITS OAuth client, checks the id token, and stores the tokens (an ingress `put`). Web sends
 * the code and PKCE verifier and gets back a version, the account's email and the granted scopes — never
 * a token.
 */
export const planeOAuthExchangeBody = z
  .object({
    ref: ref.extend({ kind: z.literal('oauth2') }),
    providerSlug: z.literal('google'),
    code: z.string().min(1).max(4_096),
    codeVerifier: z.string().min(43).max(128),
    redirectUri: z.string().url().max(2_048),
    requestedScopes: z.array(z.string().min(1).max(256)).min(1).max(20),
    bindings: z.record(z.string(), z.unknown()),
    scope: z.record(z.string(), z.unknown()),
    consenters,
  })
  .strict();

/** The host key a server presents, so a person can confirm it before an SSH account is created. No authentication. */
export const planeSshHostKeyBody = z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535) }).strict();

/**
 * Create an SSH account's key: the PLANE generates an ed25519 pair, pins the host key the person confirmed,
 * stores both (ingress `put`) and answers the PUBLIC key only — the private key never leaves the plane.
 */
export const planeSshEnrollBody = z
  .object({
    ref: z.object({ tenantId: z.string().min(1), accountId: z.string().min(1), kind: z.literal('ssh_key') }).strict(),
    username: z.string().min(1).max(64).regex(/^[a-z_][a-z0-9_.-]*$/i),
    hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    bindings: z.record(z.string(), z.unknown()),
    scope: z.record(z.string(), z.unknown()),
    consenters,
  })
  .strict();

/** Run ONE command under a signed `ssh-executor` grant (the SSH executor verifies it, as the HTTP one does). */
export const planeSshExecBody = z
  .object({
    grant: z.unknown(),
    signature: z.string().min(1).max(512),
    command: z.string().min(1).max(8_192),
    stdin: z.string().max(262_144),
    run: z
      .object({
        human: z.object({ userId: z.string().min(1), sessionId: z.string().min(1).nullable() }).strict(),
        agentPageId: z.string().min(1).nullable(),
        conversationId: z.string().min(1),
        runId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/** The policy window's counters for a ref (the plane's own usage ledger). */
export const planeUsageBody = z.object({ ref }).strict();

export const planeExecuteBody = z
  .object({
    grant: z.unknown(),
    signature: z.string().min(1).max(512),
    request: z
      .object({
        method: z.string().min(1).max(16),
        url: z.string().min(1).max(8_192),
        headers: z.record(z.string(), z.string()),
        /** Base64 of the exact body bytes. ~1 MiB of body at most. */
        bodyBase64: z.string().max(1_400_000),
      })
      .strict(),
    run: z
      .object({
        human: z.object({ userId: z.string().min(1), sessionId: z.string().min(1).nullable() }).strict(),
        agentPageId: z.string().min(1).nullable(),
        conversationId: z.string().min(1),
        runId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type PlanePutBody = z.infer<typeof planePutBody>;
export type PlaneRevokeBody = z.infer<typeof planeRevokeBody>;
export type PlaneDeleteBody = z.infer<typeof planeDeleteBody>;
export type PlaneExecuteBody = z.infer<typeof planeExecuteBody>;
export type PlaneDescribeBody = z.infer<typeof planeDescribeBody>;
export type PlaneRebindBody = z.infer<typeof planeRebindBody>;
export type PlaneUsageBody = z.infer<typeof planeUsageBody>;
export type PlaneOAuthExchangeBody = z.infer<typeof planeOAuthExchangeBody>;
export type PlaneSshHostKeyBody = z.infer<typeof planeSshHostKeyBody>;
export type PlaneSshEnrollBody = z.infer<typeof planeSshEnrollBody>;
export type PlaneSshExecBody = z.infer<typeof planeSshExecBody>;
export type PlaneSshHostKeyResult = { readonly ok: true; readonly fingerprint: string; readonly algorithm: string } | { readonly ok: false; readonly reason: 'unresolvable' | 'address_refused' | 'unreachable' | 'timeout' | 'host_key_mismatch' | 'auth_failed' };
export type PlaneSshEnrollResult =
  | { readonly ok: true; readonly version: number; readonly publicKey: string }
  | { readonly ok: false; readonly reason: 'target_invalid' | 'store_unavailable' | 'kind_mismatch' | 'version_conflict' | 'write_unverified' | 'lock_unavailable' | 'consenters_invalid' | 'identity_refused' };
export type PlaneOAuthExchangeResult =
  | { readonly ok: true; readonly version: number; readonly email: string; readonly scopes: readonly string[] }
  | {
      readonly ok: false;
      readonly reason:
        /** No OAuth client for the provider on the plane. */
        | 'not_configured'
        /** The provider refused the code (expired, used, or for another client). */
        | 'exchange_refused'
        | 'exchange_failed'
        | 'no_refresh_token'
        | 'no_service_granted'
        | 'identity_invalid'
        | 'malformed'
        | 'store_unavailable'
        | 'kind_mismatch'
        | 'version_conflict'
        | 'write_unverified'
        | 'lock_unavailable'
        | 'consenters_invalid'
        | 'identity_refused';
    };

export type PlaneDescribeResult =
  | { readonly ok: true; readonly policyVersion: number; readonly consenters: PlaneConsenters; readonly revoked: boolean }
  | { readonly ok: false; readonly reason: 'not_found' | 'identity_refused' | 'store_unavailable' };
export type PlaneUsageResult = { readonly ok: true; readonly usesThisHour: number; readonly bytesOutThisHour: number; readonly concurrent: number } | { readonly ok: false; readonly reason: 'store_unavailable' };

export const PLANE_ROUTES = {
  put: '/v1/accounts/put',
  revoke: '/v1/accounts/revoke',
  delete: '/v1/accounts/delete',
  describe: '/v1/accounts/describe',
  rebind: '/v1/accounts/rebind',
  usage: '/v1/accounts/usage',
  oauthExchange: '/v1/oauth/exchange',
  sshHostKey: '/v1/ssh/hostkey',
  sshEnroll: '/v1/ssh/enroll',
  sshExec: '/v1/ssh/exec',
  execute: '/v1/http/execute',
} as const;
