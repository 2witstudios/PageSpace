import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { chatMessages } from '@pagespace/db/schema/core';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import {
  validateConversationAccess,
  serializeMessageRowToMessages,
} from '@/lib/ai/openai-api/v1-conversations';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, getAllowedDriveIds } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  const { id } = await context.params;

  const conversation = await conversationRepository.getConversation(id);
  const access = validateConversationAccess(conversation, authResult.userId);
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status });
  }

  const allowedDriveIds = getAllowedDriveIds(authResult);
  if (allowedDriveIds.length > 0) {
    const contextId = conversation!.contextId;
    if (contextId === null || !allowedDriveIds.includes(contextId)) {
      return NextResponse.json({ error: 'Conversation not accessible with this token' }, { status: 403 });
    }
  }

  // Stale-tab rollout protection: SDK consumers deployed before this PR never send this
  // param, so they never see 'streaming' placeholder rows. See Server Stream Durability
  // epic PR 2.
  const { searchParams } = new URL(request.url);
  const includeStreaming = searchParams.get('includeStreaming') === '1';
  const messages = await chatMessageRepository.getMessagesByConversationId(id, includeStreaming);

  auditRequest(request, { eventType: 'data.read', userId: authResult.userId, resourceType: 'conversation', resourceId: id, details: {}, riskScore: 0 });

  return NextResponse.json({
    id,
    object: 'conversation',
    created_at: Math.floor(conversation!.createdAt.getTime() / 1000),
    user_id: conversation!.userId,
    title: conversation!.title,
    drive_id: conversation!.contextId,
    messages: messages.filter((m) => m.isActive).flatMap(serializeMessageRowToMessages),
  });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  const { id } = await context.params;

  const conversation = await conversationRepository.getConversation(id);
  const access = validateConversationAccess(conversation, authResult.userId);
  if (!access.ok) {
    return NextResponse.json({ error: access.message }, { status: access.status });
  }

  const allowedDriveIds = getAllowedDriveIds(authResult);
  if (allowedDriveIds.length > 0) {
    const contextId = conversation!.contextId;
    if (contextId === null || !allowedDriveIds.includes(contextId)) {
      return NextResponse.json({ error: 'Conversation not accessible with this token' }, { status: 403 });
    }
  }

  await db
    .update(conversations)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(conversations.id, id));

  await db
    .update(chatMessages)
    .set({ isActive: false })
    .where(and(eq(chatMessages.conversationId, id), eq(chatMessages.isActive, true)));

  auditRequest(request, { eventType: 'data.delete', userId: authResult.userId, resourceType: 'conversation', resourceId: id, details: {}, riskScore: 0 });

  return NextResponse.json({ id, deleted: true });
}
