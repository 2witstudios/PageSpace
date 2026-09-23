/**
 * `createRefreshWorker` — the ONE restricted holder of `oauth2` refresh
 * tokens (L3·G3; ADR 0005 §5.1; threat model A10, C5). I/O only: every
 * decision is a pure module (`decideRefresh`, `decideRefreshEndpoint`,
 * `buildRefreshRequest`, `interpretTokenResponse`, `planRefreshedMaterial`,
 * `classifyRefreshFailure`, `decideRefreshFailureEffects`,
 * `nextRefreshAttempt`); this file fetches their facts and acts on verdicts.
 *
 *   single-flight per account (this process)
 *   ─▶ resolve refresh-capable material ─▶ decideRefresh (fresh? no lock needed)
 *   ─▶ try-lock per account (every replica) ─▶ re-resolve + re-decide under it
 *   ─▶ refresh only from the plane's CURRENT version (never rotation grace)
 *   ─▶ pinned endpoint ─▶ pinned HTTPS POST ─▶ next material
 *   ─▶ rotate under the store's CAS ─▶ mirror the version ─▶ clear attempts
 *
 * Serialization: two callers in one process share one refresh (the in-flight
 * promise) and both receive its result. Across replicas the advisory try-lock
 * lets exactly one refresh run; a caller that finds it held gets
 * `refresh_in_progress` and re-issues after it lands. The re-resolve under
 * the lock is what stops a second upstream refresh: if another replica
 * rotated meanwhile, the grant's version no longer resolves and the caller
 * gets `version_conflict`, never a second exchange of a spent token.
 *
 * Crash recovery is the store's (ADR 0005 §2.3, E1): `rotate` records a
 * pending write before the Infisical write, and the next locked call commits
 * it forward or aborts it. The window this file cannot close — a crash after
 * the provider answered and before `rotate` recorded its intent — loses a
 * rotated refresh token; the next attempt presents the spent one, the
 * provider answers `invalid_grant`, and the account is marked `needs_reauth`
 * (stated residual, threat model §9 Λ2 amendment).
 *
 * The refresh token lives only in this function's locals for one exchange.
 * What callers receive is `OAuth2AccessMaterial`: the refresh token is
 * stripped before return.
 *
 * NOT exported from any `packages/lib` subpath (ADR 0005 F13): only the plane
 * process wires it.
 */
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { OAuth2AccessMaterial, PlaneBindings, ResolveResult, SecretMaterialByKind, SecretRef, StoreAdapter, StoreIdentity } from '../store/store-adapter';
import type { PinnedHttpsClient } from '../executor/pinned-https-client';
import type { RefreshAttemptLedger } from './refresh-attempt-repository';
import type { OAuthEndpointRegistry } from './decide-refresh-endpoint';
import type { OAuthClientCredentials } from './build-refresh-request';
import type { RefreshFailure } from './classify-refresh-failure';
import { decideRefresh } from './decide-refresh';
import { decideRefreshBasis } from './decide-refresh-basis';
import { decideRefreshEndpoint } from './decide-refresh-endpoint';
import { buildRefreshRequest } from './build-refresh-request';
import { interpretTokenResponse } from './interpret-token-response';
import { planRefreshedMaterial } from './plan-refreshed-material';
import { classifyRefreshFailure } from './classify-refresh-failure';
import { decideRefreshFailureEffects } from './decide-refresh-failure-effects';
import { nextRefreshAttempt } from './next-refresh-attempt';

export type OAuth2Ref = SecretRef & { readonly kind: 'oauth2' };

export type RefreshWorkerDeps = {
  readonly store: Pick<StoreAdapter, 'rotate'>;
  /**
   * Resolves the refresh-capable material (`refresh-worker` channel) at `version`.
   * The worker never builds a grant itself: whoever wires it supplies this.
   */
  readonly resolveRefreshable: (input: { readonly ref: OAuth2Ref; readonly version: CredentialVersion }) => Promise<ResolveResult<'refresh-worker', 'oauth2'>>;
  /** The plane metadata store's committed current version for the ref (no material), or null when unreadable. */
  readonly currentVersion: (ref: OAuth2Ref) => Promise<CredentialVersion | null>;
  /** The tenant's store identity in the refresh-worker role, or null when the plane cannot reach it. */
  readonly identityFor: (ref: OAuth2Ref) => Promise<(StoreIdentity & { readonly channel: 'refresh-worker' }) | null>;
  readonly attempts: RefreshAttemptLedger;
  readonly advisoryLockPool: AdvisoryLockPool;
  readonly network: PinnedHttpsClient;
  readonly registry: OAuthEndpointRegistry;
  /** The plane-held OAuth client for a provider, or null when none is configured. */
  readonly clientFor: (providerSlug: string) => OAuthClientCredentials | null;
  readonly accounts: {
    readonly advanceCredentialVersion: (input: { readonly id: string; readonly from: number; readonly to: number }) => Promise<boolean>;
    readonly markNeedsReauth: (input: { readonly id: string; readonly at: number }) => Promise<boolean>;
  };
  readonly now: () => number;
  /** Refresh when the access token has less than this left. */
  readonly marginMs: number;
};

export type RefreshRequest = {
  readonly ref: OAuth2Ref;
  /** The version the caller's grant names. */
  readonly version: CredentialVersion;
  readonly providerSlug: string | null;
  /** The plane's stored bindings for the ref (rotate re-checks them). */
  readonly bindings: PlaneBindings;
};

export type RefreshOutcome =
  | { readonly ok: true; readonly material: OAuth2AccessMaterial; readonly version: CredentialVersion; readonly refreshed: boolean }
  | {
      readonly ok: false;
      readonly reason:
        /** Another replica holds the per-account lock; re-issue once it lands. */
        | 'refresh_in_progress'
        /** A previous failure set a retry time that has not passed. */
        | 'backoff'
        /** The grant is dead upstream or the failure cap was reached; the human reconnects. */
        | 'needs_reauth'
        /** Generic provider, tampered endpoint, or no client configured: nothing is sent. */
        | 'not_refreshable'
        /** The version moved (another refresh landed); re-issue with the current version. */
        | 'version_conflict'
        | 'refresh_failed'
        | 'store_unavailable';
    };

const LOCK_PREFIX = 'agent-accounts:refresh';

const accessOnly = ({ refreshToken: _refreshToken, ...access }: SecretMaterialByKind['oauth2']): OAuth2AccessMaterial => access;

const refKey = (ref: OAuth2Ref): string => `${ref.tenantId}:${ref.accountId}`;

export function createRefreshWorker(deps: RefreshWorkerDeps) {
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  async function resolveOrFail(request: RefreshRequest): Promise<{ readonly material: SecretMaterialByKind['oauth2']; readonly version: CredentialVersion } | RefreshOutcome> {
    const resolved = await deps.resolveRefreshable({ ref: request.ref, version: request.version }).catch(() => null);
    if (resolved === null) return { ok: false, reason: 'store_unavailable' };
    if (!resolved.ok) return { ok: false, reason: resolved.reason === 'version_mismatch' || resolved.reason === 'bindings_stale' ? 'version_conflict' : 'store_unavailable' };
    return { material: resolved.material, version: resolved.version };
  }

  async function fail(request: RefreshRequest, failure: RefreshFailure, now: number): Promise<RefreshOutcome> {
    const effects = decideRefreshFailureEffects({ failure: classifyRefreshFailure({ failure }) });
    const previous = await deps.attempts.read(request.ref);
    await deps.attempts.write({ ref: request.ref, fact: nextRefreshAttempt({ previous, outcome: effects.attempt, now }) });
    if (effects.accountStatus === 'needs_reauth') {
      await deps.accounts.markNeedsReauth({ id: request.ref.accountId, at: now });
      return { ok: false, reason: 'needs_reauth' };
    }
    return { ok: false, reason: 'refresh_failed' };
  }

  /** Under the per-account lock: re-resolve, re-decide, and refresh at most once. */
  async function refreshLocked(request: RefreshRequest): Promise<RefreshOutcome> {
    const current = await resolveOrFail(request);
    if ('ok' in current) return current;
    const now = deps.now();
    const lastAttempt = await deps.attempts.read(request.ref);
    const decision = decideRefresh({ material: current.material, now, marginMs: deps.marginMs, lockHeld: false, lastAttempt });
    if (decision.action === 'skip') {
      return decision.reason === 'fresh' ? { ok: true, material: accessOnly(current.material), version: current.version, refreshed: false } : { ok: false, reason: decision.reason === 'locked' ? 'refresh_in_progress' : 'backoff' };
    }
    if (decision.action === 'needs_reauth') {
      await deps.accounts.markNeedsReauth({ id: request.ref.accountId, at: now });
      return { ok: false, reason: 'needs_reauth' };
    }
    // Rotation grace can serve the PREVIOUS version, whose refresh token is already spent:
    // refreshing from it is a replay (RFC 9700 §4.14.2). Only the current version is a basis.
    const currentVersion = await deps.currentVersion(request.ref).catch(() => null);
    if (decideRefreshBasis({ resolvedVersion: current.version, currentVersion }).basis !== 'current') return { ok: false, reason: 'version_conflict' };

    const endpoint = decideRefreshEndpoint({ providerSlug: request.providerSlug, material: current.material, registry: deps.registry });
    if (!endpoint.ok) {
      if (endpoint.reason === 'endpoint_mismatch') await deps.accounts.markNeedsReauth({ id: request.ref.accountId, at: now });
      return { ok: false, reason: endpoint.reason === 'endpoint_mismatch' ? 'needs_reauth' : 'not_refreshable' };
    }
    const client = request.providerSlug === null ? null : deps.clientFor(request.providerSlug);
    const identity = await deps.identityFor(request.ref);
    if (client === null) return { ok: false, reason: 'not_refreshable' };
    if (identity === null) return { ok: false, reason: 'store_unavailable' };
    const built = buildRefreshRequest({ tokenEndpoint: endpoint.tokenEndpoint, clientAuth: endpoint.clientAuth, client, refreshToken: current.material.refreshToken ?? '' });
    if (!built.ok) return { ok: false, reason: 'not_refreshable' };

    const send = await deps.network.send(built.request);
    const answeredAt = deps.now();
    const reading = interpretTokenResponse({ send, now: answeredAt });
    if (!reading.ok) return fail(request, reading.failure, answeredAt);
    const plan = planRefreshedMaterial({ previous: current.material, response: reading.body, now: answeredAt });
    if (!plan.ok) return fail(request, { kind: 'malformed_response' }, answeredAt);

    const rotated = await deps.store.rotate({ ref: request.ref, expectedVersion: current.version, next: { kind: 'oauth2', material: plan.next }, bindings: request.bindings, identity });
    if (!rotated.ok) return { ok: false, reason: rotated.reason === 'version_conflict' ? 'version_conflict' : 'store_unavailable' };
    await deps.attempts.write({ ref: request.ref, fact: null });
    await deps.accounts.advanceCredentialVersion({ id: request.ref.accountId, from: current.version, to: rotated.version });
    return { ok: true, material: accessOnly(plan.next), version: rotated.version, refreshed: true };
  }

  async function run(request: RefreshRequest): Promise<RefreshOutcome> {
    // Fast path: a fresh token needs no lock and spends nothing.
    const first = await resolveOrFail(request);
    if ('ok' in first) return first;
    const lastAttempt = await deps.attempts.read(request.ref);
    const early = decideRefresh({ material: first.material, now: deps.now(), marginMs: deps.marginMs, lockHeld: false, lastAttempt });
    if (early.action === 'skip' && early.reason === 'fresh') return { ok: true, material: accessOnly(first.material), version: first.version, refreshed: false };

    const locked = await withAdvisoryLock(deps.advisoryLockPool, `${LOCK_PREFIX}:${refKey(request.ref)}`, () => refreshLocked(request));
    if (locked.outcome === 'acquired') return locked.result;
    if (locked.outcome === 'connection_error') return { ok: false, reason: 'store_unavailable' };
    const held = decideRefresh({ material: first.material, now: deps.now(), marginMs: deps.marginMs, lockHeld: true, lastAttempt });
    if (held.action === 'needs_reauth') return { ok: false, reason: 'needs_reauth' };
    return { ok: false, reason: 'refresh_in_progress' };
  }

  return {
    /**
     * The access material for `request.ref`, refreshed first when it is about to expire.
     * Concurrent calls for one account in this process share one refresh.
     */
    ensureFresh(request: RefreshRequest): Promise<RefreshOutcome> {
      const key = refKey(request.ref);
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const started = run(request).finally(() => inFlight.delete(key));
      inFlight.set(key, started);
      return started;
    },
  };
}

export type RefreshWorker = ReturnType<typeof createRefreshWorker>;
