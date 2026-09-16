/**
 * Repository seam for tool approvals: the user's standing grants and the atomic
 * per-approval decision record. See `packages/db/src/schema/tool-approvals.ts`
 * for why the decision lives in its own table (exactly-once execution) rather
 * than on the message row.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNull, or } from '@pagespace/db/operators';
import { aiToolApprovalGrants, aiToolApprovalDecisions } from '@pagespace/db/schema/tool-approvals';
import type { ToolApprovalGrant } from '@/lib/ai/approvals/approval-policy';

export type ToolApprovalScope = 'once' | 'conversation' | 'always';
export type ToolApprovalOutcome = 'ok' | 'error' | 'denied' | 'stale';

export interface ToolApprovalGrantRow extends ToolApprovalGrant {
  id: string;
  createdAt: Date;
}

export interface ClaimDecisionInput {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
  conversationId: string;
  userId: string;
  approved: boolean;
  reason?: string | null;
  scope?: ToolApprovalScope | null;
}

export const toolApprovalRepository = {
  /**
   * The one place a decision is made durable. `INSERT … ON CONFLICT DO NOTHING
   * RETURNING`: of any number of concurrent callers for the same approval id —
   * two tabs, or an approve racing the typed-message denial — exactly one gets
   * the row back and proceeds; every other caller gets `null` and must treat
   * the approval as already resolved. No transaction, no row lock, no shared
   * repository seam to thread it through.
   */
  async claimDecision(input: ClaimDecisionInput): Promise<{ approvalId: string } | null> {
    const [row] = await db
      .insert(aiToolApprovalDecisions)
      .values({
        approvalId: input.approvalId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        messageId: input.messageId,
        conversationId: input.conversationId,
        userId: input.userId,
        approved: input.approved,
        reason: input.reason ?? null,
        scope: input.approved ? (input.scope ?? 'once') : null,
      })
      .onConflictDoNothing({ target: aiToolApprovalDecisions.approvalId })
      .returning({ approvalId: aiToolApprovalDecisions.approvalId });
    return row ?? null;
  },

  /** Record what actually happened to an approved call. Idempotent (a plain update). */
  async markExecuted(approvalId: string, outcome: ToolApprovalOutcome): Promise<void> {
    await db
      .update(aiToolApprovalDecisions)
      .set({ executedAt: new Date(), outcome })
      .where(eq(aiToolApprovalDecisions.approvalId, approvalId));
  },

  /**
   * The grants that apply to ONE turn: every user-wide grant plus the grants
   * scoped to this conversation. Grants for other conversations never come
   * back, so the policy cannot honour one by mistake.
   */
  async listGrants(userId: string, conversationId: string | null): Promise<ToolApprovalGrantRow[]> {
    const scope = conversationId
      ? or(isNull(aiToolApprovalGrants.conversationId), eq(aiToolApprovalGrants.conversationId, conversationId))
      : isNull(aiToolApprovalGrants.conversationId);
    return db
      .select({
        id: aiToolApprovalGrants.id,
        toolName: aiToolApprovalGrants.toolName,
        conversationId: aiToolApprovalGrants.conversationId,
        createdAt: aiToolApprovalGrants.createdAt,
      })
      .from(aiToolApprovalGrants)
      .where(and(eq(aiToolApprovalGrants.userId, userId), scope));
  },

  /** Every grant the user holds, for the settings screen (user-wide and per-conversation alike). */
  async listAllGrants(userId: string): Promise<ToolApprovalGrantRow[]> {
    return db
      .select({
        id: aiToolApprovalGrants.id,
        toolName: aiToolApprovalGrants.toolName,
        conversationId: aiToolApprovalGrants.conversationId,
        createdAt: aiToolApprovalGrants.createdAt,
      })
      .from(aiToolApprovalGrants)
      .where(eq(aiToolApprovalGrants.userId, userId));
  },

  /**
   * Idempotent: the unique indexes (composite for conversation grants, partial
   * for user-wide ones) make a repeated "always allow" a no-op rather than a
   * second row.
   */
  async addGrant(input: { userId: string; toolName: string; conversationId: string | null }): Promise<void> {
    await db
      .insert(aiToolApprovalGrants)
      .values({ userId: input.userId, toolName: input.toolName, conversationId: input.conversationId })
      .onConflictDoNothing();
  },

  /** Scoped to the owner: a grant id from another user matches nothing. Returns whether a row was removed. */
  async revokeGrant(input: { userId: string; grantId: string }): Promise<boolean> {
    const rows = await db
      .delete(aiToolApprovalGrants)
      .where(and(eq(aiToolApprovalGrants.id, input.grantId), eq(aiToolApprovalGrants.userId, input.userId)))
      .returning({ id: aiToolApprovalGrants.id });
    return rows.length > 0;
  },
};
