/**
 * An in-memory `GrantAuditStore` for suites that drive the REAL bridge client
 * (GA wave 3): the client refuses to send a grant whose sign-time audit row
 * cannot be written, so a route test that mocks the drive-envs runtime must
 * hand it somewhere to write. Rows are kept in insertion order; `recordResult`
 * answers only a row still waiting, like the database does.
 */
import type { DriveEnvGrantAuditRecord, GrantAuditStore } from '@pagespace/lib/services/drive-envs/grant-audit-store';

export function createGrantAuditFake(): GrantAuditStore & { rows: DriveEnvGrantAuditRecord[] } {
  const rows: DriveEnvGrantAuditRecord[] = [];
  let seq = 0;
  return {
    rows,
    async recordSign(input) {
      const row: DriveEnvGrantAuditRecord = { id: `row_${++seq}`, envId: input.envId, grantId: input.grantId, userId: input.principal.userId, sessionId: input.principal.sessionId, conversationId: input.principal.conversationId, op: input.op, argsHash: input.argsHash, summary: input.summary, verdict: 'signed', exitCode: null, challengeId: input.approval?.challengeId ?? null, approvalScope: input.approval?.scope ?? null, ts: input.now, resultAt: null };
      rows.push(row);
      return row;
    },
    async recordRefusal(input) {
      const row: DriveEnvGrantAuditRecord = { id: `row_${++seq}`, envId: input.envId, grantId: null, userId: input.principal.userId, sessionId: input.principal.sessionId, conversationId: input.principal.conversationId, op: input.op, argsHash: input.argsHash, summary: input.summary, verdict: `refused:${input.reason}`, exitCode: null, challengeId: null, approvalScope: null, ts: input.now, resultAt: input.now };
      rows.push(row);
      return row;
    },
    async recordResult(input) {
      const index = rows.findIndex((row) => row.grantId === input.grantId && row.resultAt === null);
      if (index < 0) return null;
      const updated = { ...rows[index]!, verdict: input.verdict, exitCode: input.exitCode, resultAt: input.now };
      rows[index] = updated;
      return updated;
    },
    async listForEnv({ envId, limit }) {
      return rows.filter((row) => row.envId === envId).reverse().slice(0, limit);
    },
    async listForOwner({ limit }) {
      return [...rows].reverse().slice(0, limit);
    },
  };
}
