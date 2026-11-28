/**
 * `createSshCommandExecutor` — the credential plane's SSH executor (slice 5;
 * ADR 0005 §10e). I/O only; the HTTP executor's twin:
 *
 *   parse ─▶ facts (main-DB row + approval + delegation, plane describe)
 *   ─▶ canonicalize against the PLANE's pinned target ─▶ grant gate
 *   (verifyGrant, audience ssh-executor, one-use nonce) ─▶ policy usage
 *   reserve ─▶ audited execution: resolve the key ─▶ public-address,
 *   pinned-host-key SSH exec ─▶ scrub ─▶ record outcome
 *
 * The target is the plane's stored `allowedOrigins[0]`, never the main-DB
 * row's: a writer who re-pointed the row at another host still reaches only
 * the host the plane agreed to. The private key exists only inside `act`,
 * for one connection, and is scrubbed from the output.
 */
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { DelegationFact, Ed25519Verify, HashBytes, PresenterKeyId, VerifiedGrant } from '../grant';
import type { PlaneScope, SecretRef, StoreAdapter, StoreIdentity, StoreLimits } from '../store/store-adapter';
import type { UsageLedger } from '../store/usage-ledger-repository';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentAccountRepository } from '../agent-account-repository';
import type { GrantGate } from '../grant-gate-executor';
import type { AuditedExecutor } from '../audit-gate-executor';
import type { SshClient, SshExecOutcome } from './ssh-client';
import { parseGrant } from '../parse-grant';
import { digestRequest } from '../digest-request';
import { canonicalizeSshCommand, sshTargetOf } from '../ssh/ssh-command';
import { decidePolicyUsage } from './decide-policy-usage';
import { approvalFactFor } from './approval-fact-for';
import { expectedBindingFor, type PlaneAttestedFacts, type RunEnvelope } from './expected-binding-for';
import { decideSshResult, sshAuditOutcome, sshKnownValues, type SshExecutionResult } from './decide-ssh-result';

export type SshCommandExecutorDeps = {
  readonly store: Pick<StoreAdapter, 'resolve' | 'describe'>;
  readonly provisioner: Pick<TenantProvisioner, 'identityOf'>;
  readonly accounts: Pick<AgentAccountRepository, 'find' | 'findApproval' | 'findDelegation' | 'touchLastUsed'>;
  readonly grantGate: GrantGate;
  readonly audited: AuditedExecutor;
  readonly ssh: SshClient;
  readonly planeScope: (ref: SecretRef) => Promise<PlaneScope | null>;
  readonly usage: UsageLedger;
  readonly issuerPublicKey: Uint8Array;
  readonly presenterKeyId: PresenterKeyId;
  readonly verify: Ed25519Verify;
  /** SHA3-256. */
  readonly hash: HashBytes;
  /** SHA-256 (the canonical body digest). */
  readonly sha256: HashBytes;
  readonly now: () => number;
  readonly rotationGraceMs: StoreLimits['rotationGraceMs'];
};

export type SshCommandRequest = {
  /** Untrusted until verified. */
  readonly grant: unknown;
  readonly signature: string;
  readonly command: string;
  readonly stdin: string;
  readonly run: RunEnvelope;
};

export type SshCommandExecutor = { readonly execute: (input: SshCommandRequest) => Promise<SshExecutionResult> };

const REFUSED: SshExecutionResult = { ok: false, reason: 'refused' };

export function createSshCommandExecutor(deps: SshCommandExecutorDeps): SshCommandExecutor {
  const presenter = { keyId: deps.presenterKeyId, channel: 'ssh-executor' as const };
  const caller = { channel: 'ssh-executor' as const, presenterKeyId: deps.presenterKeyId };

  async function deny(claim: unknown, reason: Parameters<AuditedExecutor['recordDenial']>[0]['reason'], now: number): Promise<SshExecutionResult> {
    await deps.audited.recordDenial({ caller, claim: new TextEncoder().encode(JSON.stringify(claim) ?? 'null'), reason, now }).catch(() => undefined);
    return REFUSED;
  }

  async function planeFacts(row: AgentAccountRecord, identity: Omit<StoreIdentity, 'channel'>): Promise<PlaneAttestedFacts | null> {
    const described = await deps.store.describe({ ref: { tenantId: identity.tenantId, accountId: row.id as never, kind: row.kind }, identity: { ...identity, channel: 'manage' } });
    return described.ok ? { allowedOrigins: described.bindings.allowedOrigins, version: described.version, previousVersion: described.previousVersion, rotatedAt: described.rotatedAt, revokedAt: described.revokedAt } : null;
  }

  return {
    async execute({ grant: claim, signature, command, stdin, run }) {
      const now = deps.now();
      const parsed = parseGrant({ grant: claim });
      if (!parsed.ok) return deny(claim, 'malformed', now);

      const row = await deps.accounts.find(parsed.grant.accountId).catch(() => null);
      const tenant = row === null ? null : await deps.provisioner.identityOf(row.tenantId as never);
      const identityBase = row === null || tenant === null ? null : { tenantId: row.tenantId as never, identityId: tenant.identityId, blastRadius: 'tenant' as const };
      const plane = row === null || identityBase === null ? null : await planeFacts(row, identityBase);

      // The plane's pinned target, never the main-DB row's.
      const pinned = plane !== null && plane.allowedOrigins.length === 1 ? plane.allowedOrigins[0]! : '';
      const canonicalized = canonicalizeSshCommand({ target: pinned, command, stdin, sha256: deps.sha256 });
      if (!canonicalized.ok) return deny(claim, 'digest_mismatch', now);
      const canonical = canonicalized.canonical;

      const approvalRow = parsed.grant.approvalId === 'policy' ? null : await deps.accounts.findApproval(parsed.grant.approvalId).catch(() => null);
      const delegation: DelegationFact =
        parsed.grant.delegationId === null ? { kind: 'none' } : ((await deps.accounts.findDelegation({ delegationId: parsed.grant.delegationId, now }).catch(() => null)) ?? { kind: 'none' });
      const usageRef: SecretRef | null = row === null ? null : { tenantId: row.tenantId as never, accountId: row.id as never, kind: row.kind };
      const requestBytes = new TextEncoder().encode(command).byteLength + new TextEncoder().encode(stdin).byteLength;
      const policyUsage =
        parsed.grant.approvalId !== 'policy' || usageRef === null
          ? { expired: false, limitsExceeded: false }
          : await Promise.all([deps.planeScope(usageRef), deps.usage.window({ ref: usageRef, now })]).then(
              ([scope, usage]) => decidePolicyUsage({ policy: scope?.approvalPolicy ?? null, usage, requestBytes, now }),
              () => ({ expired: true, limitsExceeded: true }),
            );
      const verdict = await deps.grantGate.present<'ssh-executor'>({
        grant: claim,
        signature,
        issuerPublicKey: deps.issuerPublicKey,
        now,
        expected: expectedBindingFor<'ssh-executor'>({ run, presenter, row, plane, allowedDriveIds: parsed.grant.callerCeiling.allowedDriveIds, delegation }),
        requestDigest: digestRequest({ canonical, hash: deps.hash }),
        requestOperation: canonical.operation,
        approval: approvalFactFor({ approvalId: parsed.grant.approvalId, approval: approvalRow, policyVersion: row?.policyVersion ?? 0, policyUsage }),
        verify: deps.verify,
        hash: deps.hash,
        rotationGraceMs: deps.rotationGraceMs,
      });
      if (!verdict.ok) return deny(claim, verdict.reason, now);
      if (row === null || identityBase === null || plane === null || usageRef === null) return deny(claim, 'version_mismatch', now);
      const grant: VerifiedGrant<'ssh-executor'> = verdict.grant;
      const target = sshTargetOf(pinned);
      if (target === null) return deny(claim, 'digest_mismatch', now);

      if (grant.approvalId === 'policy') {
        const scope = await deps.planeScope(usageRef).catch(() => null);
        const reserved = await deps.usage.reserve({
          ref: usageRef,
          grantId: grant.grantId,
          bytes: requestBytes,
          now,
          admits: (usage) => {
            const decision = decidePolicyUsage({ policy: scope?.approvalPolicy ?? null, usage, requestBytes, now });
            return !decision.expired && !decision.limitsExceeded;
          },
        });
        if (!reserved) return deny(claim, 'approval_mismatch', now);
      }

      let outcome: SshExecOutcome | null = null;
      let knownValues: readonly string[] = [];
      try {
        const audited = await deps.audited.execute({
          grant,
          canonical,
          now,
          auditResourceKeys: [],
          act: async () => {
            const resolved = await deps.store.resolve<'ssh-executor', 'ssh_key'>({
              ref: { tenantId: identityBase.tenantId, accountId: grant.accountId, kind: 'ssh_key' },
              version: grant.credentialVersion,
              grant,
              identity: { ...identityBase, channel: 'ssh-executor' },
            });
            if (!resolved.ok) return { kind: 'upstream_failed', upstreamStatus: null };
            knownValues = sshKnownValues(resolved.material.privateKey);
            outcome = await deps.ssh.exec({
              host: target.host,
              port: target.port,
              username: resolved.material.username,
              privateKey: resolved.material.privateKey,
              hostKeySha256: resolved.material.hostKeySha256,
              command,
              stdin,
            });
            return sshAuditOutcome(outcome);
          },
        });
        if (audited.ok) await deps.accounts.touchLastUsed({ id: row.id, at: now }).catch(() => undefined);
        return decideSshResult({ audited, outcome, knownValues });
      } finally {
        if (grant.approvalId === 'policy') await deps.usage.finish({ grantId: grant.grantId, now: deps.now() });
      }
    },
  };
}
