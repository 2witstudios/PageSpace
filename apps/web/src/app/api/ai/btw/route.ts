import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { messageRepository } from '@/lib/repositories/message-repository';
import { getActivePlan } from '@/lib/ai/core/plan-binding';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { buildSideQuestionSnapshot, createSideQuestionStream } from '@/lib/ai/btw/side-question';

export const maxDuration = 60;
const MAX_QUESTION_CHARS = 2_000;

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: true });
  if (isAuthError(auth)) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_btw', resourceId: 'side-question', details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
    return auth.error;
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('conversationId' in body) || !('question' in body)) return NextResponse.json({ error: 'Invalid side question' }, { status: 400 });
  // Destructure to consts so the typeof narrowing below survives inside the
  // read closures passed to buildSideQuestionSnapshot (property narrowing on
  // `body` would reset inside those callbacks and fail the build).
  const { conversationId, question } = body;
  if (typeof conversationId !== 'string' || typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) return NextResponse.json({ error: 'Invalid side question' }, { status: 400 });
  const [conversation] = await db.select({ userId: conversations.userId, isShared: conversations.isShared, type: conversations.type, contextId: conversations.contextId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation || !(await canAccessConversation(auth.userId, conversation))) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'ai_btw', resourceId: conversationId, details: { reason: 'conversation_not_accessible', method: 'POST' }, riskScore: 0.5 });
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const provider = await createAIProvider(auth.userId, {});
  if ('error' in provider) return NextResponse.json({ error: provider.error }, { status: provider.status });
  const snapshot = await buildSideQuestionSnapshot({ conversationId, readMessages: () => messageRepository.getMessagesByConversationId(conversationId), readPlan: async () => (await getActivePlan(conversationId, auth.userId))?.title ?? null });
  return createSideQuestionStream({ model: provider.model, question: question.trim(), snapshot, abortSignal: request.signal });
}
