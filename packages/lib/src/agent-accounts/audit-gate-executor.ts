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
 * `act` reports its own phase. A failure it KNOWS happened before anything
 * was sent (DNS, connect, TLS, a refused pinned address) it must catch and
 * RETURN as `upstream_failed` with `upstreamStatus: null` — `decideRetry`'s
 * `before_send` report — which keeps a safe retry possible. An `act` that
 * THROWS is `outcome: 'unknown'`, not a failure: the executor cannot tell
 * where it stopped, so it assumes the request was sent and a non-idempotent
 * write may have landed (threat model §2.4 — replay protection is not
 * idempotency). Reporting it as failed would let a caller retry a push that
 * already happened.
 *
 * The outcome row is written AFTER the effect, so its acceptance cannot gate
 * anything; it is reported instead. `outcomeRecorded: false` means the
 * operation ran (or may have) and the chain holds only the `allowed` row — the
 * caller must surface that, never read the result as a clean success.
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
import { buildDenialRecord } from './build-denial-record';
import type { VerifiedCaller } from './denial-audit-record';

/** What `act` may report: the effect has run, so only an operation outcome can follow it. */
export type OperationOutcome = Extract<AuditOutcome, { readonly kind: 'executed' | 'upstream_failed' | 'unknown' }>;

const OPERATION_OUTCOME_KINDS: readonly string[] = ['executed', 'upstream_failed', 'unknown'] satisfies readonly OperationOutcome['kind'][];

export type AuditedExecution =
  | {
      readonly ok: true;
      readonly outcome: OperationOutcome;
      /** Whether the chain accepted the outcome row. `false`: the effect happened but only `allowed` is durable. */
      readonly outcomeRecorded: boolean;
    }
  | { readonly ok: false; readonly reason: Extract<GrantDenyReason, 'audit_unavailable'> };

export type AuditedExecutor = {
  /** Accept the `allowed` row, then act, then record the outcome. Refuses before acting if the row is not accepted. */
  readonly execute: (input: {
    readonly grant: AgentAccountGrant;
    readonly canonical: CanonicalRequest;
    readonly now: number;
    /** The resource keys this operation's catalogue entry declares (ADR 0004 §5 amendment). */
    readonly declaredResourceKeys: readonly string[];
    /** The effect. Return `upstream_failed` (status null) for a failure known to precede sending; a throw is recorded as `unknown`. */
    readonly act: () => Promise<OperationOutcome>;
  }) => Promise<AuditedExecution>;
  /**
   * Record a refusal. Nothing is executed; the reason is for the audit and the
   * human, never the caller. The refused grant is NOT an input: only the
   * caller this executor authenticated and the raw claim bytes, which are
   * digested (`denial-audit-record.ts`).
   */
  readonly recordDenial: (input: {
    readonly caller: VerifiedCaller;
    readonly claim: Uint8Array;
    readonly reason: GrantDenyReason;
    readonly now: number;
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

      let outcome: OperationOutcome;
      try {
        const reported = await act();
        // The effect has run. A pre-execution kind here (`allowed`, `denied`)
        // would write a second grant event instead of saying what happened.
        outcome = OPERATION_OUTCOME_KINDS.includes(reported.kind) ? reported : { kind: 'unknown' };
      } catch {
        // Where it stopped is unknown; upstream may have acted. Never "failed".
        outcome = { kind: 'unknown' };
      }
      const outcomeAcceptance = await auditRepository.accept({
        record: buildAuditRecord({ grant, canonical, outcome, at: now, hash, declaredResourceKeys }),
      });
      return { ok: true, outcome, outcomeRecorded: outcomeAcceptance.kind === 'accepted' };
    },

    async recordDenial({ caller, claim, reason, now }) {
      const acceptance = await auditRepository.acceptDenial({
        record: buildDenialRecord({ caller, claim, reason, at: now, hash }),
      });
      return { ok: acceptance.kind === 'accepted' };
    },
  };
}
