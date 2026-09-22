/**
 * `createHttpRequestExecutor` — the credential plane's HTTP executor (L2·G2;
 * task item 4; the successor to the decrypt step of
 * `integrations/saga/execute-tool.ts`). I/O only: it fetches facts, calls the
 * pure decisions and acts on their verdicts.
 *
 *   parse ─▶ facts (main-DB row + approval, plane describe) ─▶ canonicalize
 *   ─▶ grant gate (verifyGrant + one-use nonce) ─▶ audited execution:
 *        accept `allowed` ─▶ resolve (plane) ─▶ buildOutboundRequest
 *        ─▶ pinned HTTPS send ─▶ filterResponse ─▶ record outcome
 *   ─▶ decideExecutionResult (an unrecorded outcome is never success)
 *
 * It holds the plaintext key only inside `act`, for the length of one request:
 * it is formatted into the fresh request and handed to `filterResponse` as a
 * known value to scrub, and never returned. Every refusal toward the caller is
 * the constant `refused` (ADR 0004 F16); the reason goes to the audit chain.
 */
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { Ed25519Verify, HashBytes, PresenterKeyId, VerifiedGrant } from '../grant';
import type { CanonicalRequestInput, OperationRegistry } from '../canonical-request';
import type { PlaneScope, SecretRef, StoreAdapter, StoreIdentity, StoreLimits } from '../store/store-adapter';
import type { UsageLedger } from '../store/usage-ledger-repository';
import { decidePolicyUsage } from './decide-policy-usage';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentAccountRepository } from '../agent-account-repository';
import type { GrantGate } from '../grant-gate-executor';
import type { AuditedExecutor } from '../audit-gate-executor';
import type { PinnedHttpsClient } from './pinned-https-client';
import type { ReleasedResponse } from '../filter-response';
import { parseGrant } from '../parse-grant';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { buildOutboundRequest } from '../build-outbound-request';
import { filterResponse } from '../filter-response';
import { decideDestination } from '../decide-destination';
import { expectedBindingFor, type PlaneAttestedFacts, type RunEnvelope } from './expected-binding-for';
import { approvalFactFor } from './approval-fact-for';
import { decideOperationOutcome, type CallerClass, type ExecutionStage } from './decide-operation-outcome';
import { decideExecutionResult, type HttpExecutionResult } from './decide-execution-result';

export type HttpRequestExecutorDeps = {
  readonly store: Pick<StoreAdapter, 'resolve' | 'describe'>;
  readonly provisioner: Pick<TenantProvisioner, 'identityOf'>;
  readonly accounts: Pick<AgentAccountRepository, 'find' | 'findApproval' | 'touchLastUsed'>;
  readonly grantGate: GrantGate;
  readonly audited: AuditedExecutor;
  readonly network: PinnedHttpsClient;
  /** The plane's stored scope for a ref — the only source of a standing policy's caps (Codex P1). */
  readonly planeScope: (ref: SecretRef) => Promise<PlaneScope | null>;
  readonly usage: UsageLedger;
  readonly registry: OperationRegistry;
  /** The account authority's public key (DER SPKI) — the only issuer this executor accepts. */
  readonly issuerPublicKey: Uint8Array;
  readonly presenterKeyId: PresenterKeyId;
  readonly verify: Ed25519Verify;
  /** SHA3-256. */
  readonly hash: HashBytes;
  /** SHA-256 (the canonical body digest). */
  readonly sha256: HashBytes;
  readonly now: () => number;
  readonly rotationGraceMs: StoreLimits['rotationGraceMs'];
  readonly maxReleasedBodyBytes: number;
};

export type HttpExecutionRequest = {
  /** Untrusted until verified. */
  readonly grant: unknown;
  readonly signature: string;
  readonly request: CanonicalRequestInput;
  readonly run: RunEnvelope;
};

export type HttpRequestExecutor = { readonly execute: (input: HttpExecutionRequest) => Promise<HttpExecutionResult> };

const REFUSED: HttpExecutionResult = { ok: false, reason: 'refused' };

export function createHttpRequestExecutor(deps: HttpRequestExecutorDeps): HttpRequestExecutor {
  const presenter = { keyId: deps.presenterKeyId, channel: 'http-executor' as const };
  const caller = { channel: 'http-executor' as const, presenterKeyId: deps.presenterKeyId };

  async function deny(claim: unknown, reason: Parameters<AuditedExecutor['recordDenial']>[0]['reason'], now: number): Promise<HttpExecutionResult> {
    await deps.audited.recordDenial({ caller, claim: new TextEncoder().encode(JSON.stringify(claim) ?? 'null'), reason, now }).catch(() => undefined);
    return REFUSED;
  }

  async function planeFacts(row: AgentAccountRecord, identity: Omit<StoreIdentity, 'channel'>): Promise<PlaneAttestedFacts | null> {
    const described = await deps.store.describe({ ref: { tenantId: identity.tenantId, accountId: row.id as never, kind: row.kind }, identity: { ...identity, channel: 'manage' } });
    return described.ok ? { allowedOrigins: described.bindings.allowedOrigins, version: described.version, previousVersion: described.previousVersion, rotatedAt: described.rotatedAt, revokedAt: described.revokedAt } : null;
  }

  return {
    async execute({ grant: claim, signature, request, run }) {
      const now = deps.now();
      const parsed = parseGrant({ grant: claim });
      if (!parsed.ok) return deny(claim, 'malformed', now);

      const row = await deps.accounts.find(parsed.grant.accountId).catch(() => null);
      const tenant = row === null ? null : await deps.provisioner.identityOf(row.tenantId as never);
      const identityBase = row === null || tenant === null ? null : { tenantId: row.tenantId as never, identityId: tenant.identityId, blastRadius: 'tenant' as const };
      const plane = row === null || identityBase === null ? null : await planeFacts(row, identityBase);

      const canonicalized = canonicalizeRequest({ request, providerSlug: row?.providerSlug ?? null, registry: deps.registry });
      if (!canonicalized.ok) return deny(claim, 'digest_mismatch', now);
      const canonical = canonicalized.canonical;

      const approvalRow = parsed.grant.approvalId === 'policy' ? null : await deps.accounts.findApproval(parsed.grant.approvalId).catch(() => null);
      // A standing policy's caps come from the PLANE's stored scope and its own usage ledger; anything the
      // plane cannot read counts as exhausted, never as unlimited (Codex P1).
      const usageRef: SecretRef | null = row === null ? null : { tenantId: row.tenantId as never, accountId: row.id as never, kind: 'api_key' };
      const requestBytes = request.body.byteLength;
      const policyUsage =
        parsed.grant.approvalId !== 'policy' || usageRef === null
          ? { expired: false, limitsExceeded: false }
          : await Promise.all([deps.planeScope(usageRef), deps.usage.window({ ref: usageRef, now })]).then(
              ([scope, usage]) => decidePolicyUsage({ policy: scope?.approvalPolicy ?? null, usage, requestBytes, now }),
              () => ({ expired: true, limitsExceeded: true }),
            );
      const verdict = await deps.grantGate.present<'http-executor'>({
        grant: claim,
        signature,
        issuerPublicKey: deps.issuerPublicKey,
        now,
        expected: expectedBindingFor({ run, presenter, row, plane, allowedDriveIds: parsed.grant.callerCeiling.allowedDriveIds }),
        requestDigest: digestRequest({ canonical, hash: deps.hash }),
        requestOperation: canonical.operation,
        approval: approvalFactFor({ approvalId: parsed.grant.approvalId, approval: approvalRow, policyVersion: row?.policyVersion ?? 0, policyUsage }),
        verify: deps.verify,
        hash: deps.hash,
        rotationGraceMs: deps.rotationGraceMs,
      });
      if (!verdict.ok) return deny(claim, verdict.reason, now);
      if (row === null || identityBase === null || plane === null) return deny(claim, 'version_mismatch', now);
      const grant: VerifiedGrant<'http-executor'> = verdict.grant;
      // The pin is the PLANE's stored origins, checked before the key is even resolved (review HIGH-1).
      const pinnedOrigins = plane.allowedOrigins as never;
      // Reserve the use atomically: a request racing another at the cap is refused here, after the verifier.
      if (grant.approvalId === 'policy' && usageRef !== null) {
        const scope = await deps.planeScope(usageRef).catch(() => null);
        const reserved = await deps.usage.reserve({
          ref: usageRef,
          grantId: grant.grantId,
          bytes: requestBytes,
          now,
          admits: (usage) => {
            const verdict = decidePolicyUsage({ policy: scope?.approvalPolicy ?? null, usage, requestBytes, now });
            return !verdict.expired && !verdict.limitsExceeded;
          },
        });
        if (!reserved) return deny(claim, 'approval_mismatch', now);
      }

      let caller: CallerClass = 'refused';
      let released: ReleasedResponse | null = null;
      const audited = await deps.audited.execute({
        grant,
        canonical,
        now,
        auditResourceKeys: [],
        act: async () => {
          let stage: ExecutionStage = { kind: 'not_resolved' };
          const destination = decideDestination({ url: `${canonical.origin}${canonical.path}`, allowedOrigins: pinnedOrigins, hop: 'initial' });
          if (!destination.allow) {
            const outcome = decideOperationOutcome({ stage: { kind: 'not_built' } });
            caller = outcome.caller;
            return outcome.audit;
          }
          const resolved = await deps.store.resolve({
            ref: { tenantId: identityBase.tenantId, accountId: grant.accountId, kind: 'api_key' },
            version: grant.credentialVersion,
            grant,
            identity: { ...identityBase, channel: 'http-executor' },
          });
          if (resolved.ok) {
            const outbound = buildOutboundRequest({ canonical, body: request.body, material: resolved.material, sha256: deps.sha256 });
            if (!outbound.ok) {
              stage = { kind: 'not_built' };
            } else {
              const send = await deps.network.send(outbound.request);
              stage = { kind: 'sent', send };
              if (send.kind === 'response') {
                released = filterResponse({ status: send.status, headers: send.headers, body: send.body, knownValues: [resolved.material.value], maxBodyBytes: deps.maxReleasedBodyBytes });
                if (send.truncated) released = { ...released, truncated: true };
              }
            }
          }
          const outcome = decideOperationOutcome({ stage });
          caller = outcome.caller;
          return outcome.audit;
        },
      });

      if (grant.approvalId === 'policy') await deps.usage.finish({ grantId: grant.grantId, now: deps.now() });
      if (audited.ok) await deps.accounts.touchLastUsed({ id: row.id, at: now }).catch(() => undefined);
      return decideExecutionResult({ audited, caller, released });
    },
  };
}
