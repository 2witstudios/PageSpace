/**
 * The plan bound to a conversation (`conversations.planPageId`).
 *
 * Surface-agnostic on purpose: both chat surfaces (the right-sidebar page chat
 * and the Global Assistant) render the same plan chip, and both reach it here
 * rather than through their own conversation endpoints.
 *
 * This is the read side of the durable binding the agent writes with `set_plan`.
 * It exists precisely so the chip does NOT derive state from the message stream
 * — that is what makes it survive a reload and a context summary, unlike the
 * message-derived TasksDropdown.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { resolveBoundPlan } from '@/lib/ai/core/plan-binding';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Load the conversation's plan for a caller who may READ it. Returns
 * `undefined` when the conversation is missing or out of reach
 * (indistinguishable on purpose), and `null` when it simply has no plan.
 *
 * THE GATE IS `canAccessConversation` — owner OR (isShared AND page access) —
 * the same one predicate behind the realtime `join_conversation` handler,
 * `/stream-join`, `/active-streams` and `/api/ai/conversations/revs`. It used
 * to be a local `ownerId !== userId`, which made this the one
 * conversation-scoped read that disagreed with its four siblings (review
 * finding): on a SHARED page conversation a collaborator could read every
 * message and join the room, but this 404'd, so `PlanChip`'s fetcher threw,
 * `data` stayed undefined and the chip rendered nothing — the plan the agent
 * is visibly working from was invisible to exactly the people it was shared
 * with, and every one of their views fired a failing request for SWR to retry.
 * `conversation-access.ts` exists so these points cannot drift; this one had.
 *
 * The page half — join, drop trashed, re-check `canView` — is `resolveBoundPlan`,
 * shared with the prompt side rather than restated here. Both surfaces must
 * suppress a plan the caller can no longer open (a page can be trashed or have
 * its permissions revoked after `set_plan` ran), and the two used to implement
 * that rule independently, with different joins and different null semantics.
 * It re-checks against THIS caller, so widening the gate cannot widen what a
 * collaborator sees: a plan page they cannot open still resolves to `null`.
 *
 * The conversation-level check cannot be delegated to it either way.
 * `resolveBoundPlan` resolves by conversation id alone and folds "not yours"
 * into the same `null` it uses for "no plan" — correct for a prompt section,
 * which either renders or does not, but this endpoint has to distinguish 404
 * from `{plan: null}`.
 *
 * `resolveBoundPlan` and not `getActivePlan`: the prompt-side wrapper swallows
 * errors so a broken lookup cannot fail a turn. Here a swallowed error would
 * render "no plan" for a conversation that HAS one — the endpoint keeps its
 * 500 so the chip can show that it does not know.
 */
async function loadPlan(conversationId: string, userId: string) {
  const [row] = await db
    .select({
      userId: conversations.userId,
      isShared: conversations.isShared,
      type: conversations.type,
      contextId: conversations.contextId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  // No row is not shared, so this denies non-owners — the module's own
  // fail-closed rule, restated here only because there is nothing to pass it.
  if (!row) return undefined;
  if (!(await canAccessConversation(userId, row))) return undefined;
  return await resolveBoundPlan(conversationId, userId);
}

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;
  const { conversationId } = await context.params;

  try {
    const plan = await loadPlan(conversationId, userId);
    if (plan === undefined) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    return NextResponse.json({ plan });
  } catch (error) {
    loggers.api.error('[CONVERSATION_PLAN_GET]', error as Error);
    return NextResponse.json({ error: 'Failed to load plan' }, { status: 500 });
  }
}

/**
 * Unbind the plan. The page itself is untouched.
 *
 * OWNER-ONLY, deliberately, and NOT `canAccessConversation` like the GET above.
 * That predicate answers "may this caller observe the conversation" — the
 * question every subscription surface asks. Clearing the binding is a mutation
 * of the conversation itself, and a collaborator who can read a shared thread
 * has no business unbinding the plan its owner's agent is working from.
 * `setConversationPlan` scopes its own WHERE by `userId` regardless, so the
 * read below is the 404 gate rather than the enforcement.
 */
export async function DELETE(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;
  const { conversationId } = await context.params;

  try {
    const [row] = await db
      .select({ ownerId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row || row.ownerId !== userId) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Through the repository, which bumps `rev` and emits — the ownership
    // read above stays as the 404 gate, but the write itself re-checks it in
    // the WHERE, so there is no read-then-write window either.
    await conversationRepository.setConversationPlan(conversationId, userId, null);

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'conversation',
      resourceId: conversationId,
      details: { action: 'clear_plan' },
    });

    return NextResponse.json({ plan: null });
  } catch (error) {
    loggers.api.error('[CONVERSATION_PLAN_DELETE]', error as Error);
    return NextResponse.json({ error: 'Failed to clear plan' }, { status: 500 });
  }
}
