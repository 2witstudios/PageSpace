/**
 * The agent-account audit adapter (ADR 0004 §5) — I/O only, no decision
 * logic. It maps the frozen `AgentAccountAuditRecord` onto the existing
 * tamper-evident chain (`audit/security-audit.ts`,
 * `security-audit-repository.ts`, `chain-step.ts`) and reports whether the
 * row was DURABLY ACCEPTED. It never throws: an audit outage is a fact the
 * gate must act on (`decideAuditGate`), not an exception that unwinds into
 * a caller who might carry on.
 *
 * The record reaches the chain as `details`, which is folded into the
 * event hash and therefore cannot be erased later — which is precisely why
 * `buildAuditRecord` admits no body, no credential and no header value.
 * `sanitizeAuditDetails` runs anyway, as defence in depth: a future field
 * that looks like user text is redacted before it is hashed rather than
 * after someone notices.
 *
 * Integration-tested against the real `:5433` chain
 * (`__tests__/audit-repository.integration.test.ts`).
 */
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';
import type { AuditAppendPath } from '../audit/security-audit';
import { sanitizeAuditDetails } from '../audit/sanitize-audit-details';
import type { AgentAccountAuditRecord, AuditOutcome } from './audit';
import type { AuditAcceptance } from './decide-audit-gate';

/** One event type per outcome, as a `Record` so an added outcome must be mapped here. */
const EVENT_TYPE_BY_OUTCOME: Readonly<Record<AuditOutcome['kind'], SecurityEventType>> = {
  allowed: 'credential.grant.allowed',
  denied: 'credential.grant.denied',
  executed: 'credential.operation.executed',
  upstream_failed: 'credential.operation.failed',
  unknown: 'credential.operation.unknown',
};

export const AGENT_ACCOUNT_AUDIT_RESOURCE_TYPE = 'agent_account_grant';

export type AgentAccountAuditRepository = {
  /** Write the record and report whether the store durably accepted it. Never throws. */
  readonly accept: (input: { readonly record: AgentAccountAuditRecord }) => Promise<AuditAcceptance>;
};

export function createAgentAccountAuditRepository({ appendPath }: { readonly appendPath: AuditAppendPath }): AgentAccountAuditRepository {
  return {
    async accept({ record }) {
      try {
        await appendPath.appendEvent({
          eventType: EVENT_TYPE_BY_OUTCOME[record.outcome.kind],
          userId: record.principal.human.userId,
          sessionId: record.principal.human.sessionId ?? undefined,
          resourceType: AGENT_ACCOUNT_AUDIT_RESOURCE_TYPE,
          resourceId: record.grantId,
          details: sanitizeAuditDetails({
            accountId: record.accountId,
            accountKind: record.accountKind,
            credentialVersion: record.credentialVersion,
            policyVersion: record.policyVersion,
            approvalId: record.approvalId,
            requestDigest: record.requestDigest,
            normalizedAction: record.normalizedAction,
            presenter: record.presenter,
            principal: record.principal,
            outcome: record.outcome,
            at: record.at,
          }),
        });
        return { kind: 'accepted' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
