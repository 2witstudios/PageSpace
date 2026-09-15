/**
 * The audited executor (ADR 0004 F13) — the I/O shell that makes "audit
 * acceptance precedes execution" structural rather than advisory.
 *
 * The order is the whole point:
 *   1. build and ACCEPT the `allowed` record; if the chain does not confirm
 *      it, `decideAuditGate` refuses and the operation NEVER RUNS;
 *   2. only then call `act`, the caller's effect;
 *   3. write the outcome row under the SAME `grantId`, so the pair is one
 *      linked story in the chain.
 *
 * An `act` that throws is `outcome: 'unknown'`, not a failure: the request
 * was already sent and a non-idempotent write may have landed (threat model
 * §2.4 — replay protection is not idempotency; `decideRetry` owns what the
 * caller may do next). Reporting it as failed would let a caller retry a
 * push that already happened.
 *
 * No decision logic lives here: the gate is `decideAuditGate`, the record is
 * `buildAuditRecord`. Integration-tested against the real chain.
 */
import type { AgentAccountGrant, GrantDenyReason, HashBytes } from './grant';
import type { AuditOutcome } from './audit';
import type { CanonicalRequest } from './canonical-request';
import { buildAuditRecord } from './build-audit-record';
import { decideAuditGate } from './decide-audit-gate';
import type { AgentAccountAuditRepository } from './audit-repository';

export type AuditedExecution =
  | { readonly ok: true; readonly outcome: AuditOutcome }
  | { readonly ok: false; readonly reason: Extract<GrantDenyReason, 'audit_unavailable'> };

export type AuditedExecutor = {
  /** Accept the `allowed` row, then act, then record the outcome. Refuses before acting if the row is not accepted. */
  readonly execute: (input: {
    readonly grant: AgentAccountGrant;
    readonly canonical: CanonicalRequest;
    readonly now: number;
    /** The resource keys this operation's catalogue entry declares (ADR 0004 §5 amendment). */
    readonly declaredResourceKeys: readonly string[];
    readonly act: () => Promise<AuditOutcome>;
  }) => Promise<AuditedExecution>;
  /** Record a refusal. Nothing is executed; the reason is for the audit and the human, never the caller. */
  readonly recordDenial: (input: {
    readonly grant: AgentAccountGrant;
    readonly canonical: CanonicalRequest;
    readonly reason: GrantDenyReason;
    readonly now: number;
    readonly declaredResourceKeys: readonly string[];
  }) => Promise<{ readonly ok: boolean }>;
};

export function createAuditedExecutor({
  auditRepository,
  hash,
}: {
  readonly auditRepository: AgentAccountAuditRepository;
  /** SHA3-256 in production; injected so this file performs no crypto of its own. */
  readonly hash: HashBytes;
}): AuditedExecutor {
  return {
    async execute({ grant, canonical, now, declaredResourceKeys, act }) {
      const acceptance = await auditRepository.accept({
        record: buildAuditRecord({ grant, canonical, outcome: { kind: 'allowed' }, at: now, hash, declaredResourceKeys }),
      });
      const gate = decideAuditGate({ acceptance });
      if (gate.action === 'refuse') return { ok: false, reason: gate.reason };

      let outcome: AuditOutcome;
      try {
        outcome = await act();
      } catch {
        // The request was sent; upstream may have acted. Never "failed".
        outcome = { kind: 'unknown' };
      }
      await auditRepository.accept({ record: buildAuditRecord({ grant, canonical, outcome, at: now, hash, declaredResourceKeys }) });
      return { ok: true, outcome };
    },

    async recordDenial({ grant, canonical, reason, now, declaredResourceKeys }) {
      const acceptance = await auditRepository.accept({
        record: buildAuditRecord({ grant, canonical, outcome: { kind: 'denied', reason }, at: now, hash, declaredResourceKeys }),
      });
      return { ok: acceptance.kind === 'accepted' };
    },
  };
}
