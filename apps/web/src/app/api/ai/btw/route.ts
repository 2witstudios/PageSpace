import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { messageRepository } from '@/lib/repositories/message-repository';
import { getActivePlan } from '@/lib/ai/core/plan-binding';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { buildSideQuestionSnapshot, createSideQuestionStream } from '@/lib/ai/btw/side-question';
import { ADMIN_ONLY_PROVIDERS, resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { createAdminRestrictedResponse } from '@/lib/subscription/rate-limit-middleware';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { AIMonitoring, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';

export const maxDuration = 60;
const MAX_QUESTION_CHARS = 2_000;
// The model call is bounded by the server, not by the client's connection:
// a client that disconnects mid-answer must not end the generation it is being
// billed for (an abort before the first finished step reports no usage, so
// forwarding request.signal made every abandoned answer free).
const SIDE_QUESTION_TIMEOUT_MS = 55_000;

export async function POST(request: Request) {
  // Measured from the start of the request, so auth, reads and the snapshot count against it.
  const deadline = Date.now() + SIDE_QUESTION_TIMEOUT_MS;
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
  // Prepaid credit gate BEFORE the provider is resolved: a side question is a real
  // model call, so a zero balance — and an unclaimed agent (402 requires_funding) —
  // is refused here and never streams. Metering-exempt providers skip the hold,
  // exactly as the chat turn does (see isMeteringExempt in trackAIUsage).
  const userId = auth.userId;
  const [gateUser] = await db.select({ role: users.role, subscriptionTier: users.subscriptionTier, currentAiProvider: users.currentAiProvider, currentAiModel: users.currentAiModel }).from(users).where(eq(users.id, userId)).limit(1);
  const { provider: gateProvider, model: gateModel } = resolveProviderModel(undefined, undefined, gateUser?.currentAiProvider, gateUser?.currentAiModel);
  // Admin-only providers (the unmetered Z.ai Coder Plan) are refused to non-admins,
  // as the consult and v1 routes do — otherwise a stored `glm` selection would be
  // an unmetered side channel onto the admin subscription.
  if (ADMIN_ONLY_PROVIDERS.has(gateProvider) && gateUser?.role !== 'admin') {
    auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_btw', resourceId: conversationId, details: { reason: 'admin_only_provider', provider: gateProvider, method: 'POST' }, riskScore: 0.5 });
    return createAdminRestrictedResponse();
  }
  let holdId: string | undefined;
  // Becomes true once the stream owns the hold (its settle callback releases it via
  // trackUsage). Until then, every exit below must release it in `finally`.
  let holdHandedOff = false;
  try {
    if (!isMeteringExempt(gateProvider)) {
      const creditGate = await canConsumeAI(userId, (gateUser?.subscriptionTier ?? 'free') as SubscriptionTier, {
        estCostCents: estimateChatHoldCentsForModel(gateModel),
        maxInFlight: MAX_CHAT_INFLIGHT,
      });
      if (!creditGate.allowed) {
        auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_btw', resourceId: conversationId, details: { reason: 'credit_gate', gateReason: creditGate.reason, method: 'POST' }, riskScore: 0.2 });
        return creditGateErrorResponse(creditGate.reason);
      }
      holdId = creditGate.holdId;
    }
    const provider = await createAIProvider(userId, {}, gateUser ? { user: { currentAiProvider: gateUser.currentAiProvider, currentAiModel: gateUser.currentAiModel } } : undefined);
    if ('error' in provider) return NextResponse.json({ error: provider.error }, { status: provider.status });
    const snapshot = await buildSideQuestionSnapshot({ conversationId, readMessages: () => messageRepository.getMessagesByConversationId(conversationId), readPlan: async () => (await getActivePlan(conversationId, userId))?.title ?? null });
    const startTime = Date.now();
    const response = createSideQuestionStream({
      model: provider.model,
      question: question.trim(),
      snapshot,
      abortSignal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      // The chat turn's settle path: trackUsage writes ai_usage_logs and settles the
      // hold through consumeCredits (or releases it on a failed write). It always
      // logs a row, even with no usage, so the orphan sweep can recover the spend.
      onSettle: async ({ success, usage, steps }) => {
        try {
          await AIMonitoring.trackUsage({
            userId,
            provider: provider.provider,
            model: provider.modelName,
            source: 'chat',
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
            totalTokens: usage?.totalTokens,
            cachedInputTokens: usage?.cachedInputTokens,
            reasoningTokens: usage?.reasoningTokens,
            providerCostDollars: extractOpenRouterCostDollars(steps),
            openrouterGenerationIds: extractOpenRouterGenerationIds(steps),
            duration: Date.now() - startTime,
            conversationId,
            success,
            holdId,
            metadata: { sideQuestion: true },
          });
        } catch (trackingError) {
          loggers.api.error('Side question: could not track AI usage', trackingError as Error, { conversationId });
          // trackUsage settles or releases the hold on its own failure paths; if it
          // threw before doing either, free the reservation here. Idempotent: a
          // hold that was already settled or released matches nothing.
          if (holdId) await releaseHold(holdId).catch(() => {});
        }
      },
    });
    holdHandedOff = true;
    return response;
  } finally {
    // The stream never took ownership (gate refused, provider error, snapshot or
    // stream construction threw) — free the reservation.
    // Awaited: the reservation must be gone before the response is sent.
    if (holdId && !holdHandedOff) await releaseHold(holdId).catch(() => {});
  }
}
