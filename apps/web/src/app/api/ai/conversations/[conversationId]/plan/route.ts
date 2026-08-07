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
import { pages } from '@pagespace/db/schema/core';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { conversationRepository } from '@/lib/repositories/conversation-repository';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Load the conversation's plan, enforcing ownership. Returns `undefined` when
 * the conversation is missing or belongs to someone else (indistinguishable on
 * purpose), and `null` when it simply has no plan.
 */
async function loadPlan(conversationId: string, userId: string) {
  const [row] = await db
    .select({
      ownerId: conversations.userId,
      planPageId: conversations.planPageId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!row || row.ownerId !== userId) return undefined;
  if (!row.planPageId) return null;

  const [page] = await db
    .select({ id: pages.id, title: pages.title, driveId: pages.driveId, isTrashed: pages.isTrashed })
    .from(pages)
    .where(eq(pages.id, row.planPageId))
    .limit(1);

  // Re-check at read time: a plan page can be trashed or have access revoked
  // after set_plan ran, and a chip pointing at something the user can't open is
  // worse than no chip. Mirrors getActivePlan's suppression on the prompt side.
  if (!page || page.isTrashed) return null;
  if (!(await canUserViewPage(userId, page.id))) return null;

  return { pageId: page.id, title: page.title, driveId: page.driveId };
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

/** Unbind the plan. The page itself is untouched. */
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
