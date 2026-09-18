import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
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
  if (isAuthError(auth)) return auth.error;
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('conversationId' in body) || !('question' in body) || typeof body.conversationId !== 'string' || typeof body.question !== 'string' || !body.question.trim() || body.question.length > MAX_QUESTION_CHARS) return NextResponse.json({ error: 'Invalid side question' }, { status: 400 });
  const [conversation] = await db.select({ userId: conversations.userId, isShared: conversations.isShared, type: conversations.type, contextId: conversations.contextId }).from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
  if (!conversation || !(await canAccessConversation(auth.userId, conversation))) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  const provider = await createAIProvider(auth.userId, {});
  if ('error' in provider) return NextResponse.json({ error: provider.error }, { status: provider.status });
  const snapshot = await buildSideQuestionSnapshot({ conversationId: body.conversationId, readMessages: () => messageRepository.getMessagesByConversationId(body.conversationId), readPlan: async () => (await getActivePlan(body.conversationId, auth.userId))?.title ?? null });
  return createSideQuestionStream({ model: provider.model, question: body.question.trim(), snapshot, abortSignal: request.signal });
}
