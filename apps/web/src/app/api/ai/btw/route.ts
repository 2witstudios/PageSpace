import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { canConsumeAI, resolveEntitlementTier } from '@pagespace/lib/billing/credit-gate';
import { conversationSpend } from '@pagespace/lib/billing/spend-target';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { isMeteringExempt } from '@pagespace/lib/ai/model-defaults';
import { estimateChatHoldCentsForModel } from '@pagespace/lib/monitoring/chat-pricing';
import { AIMonitoring, estimateTokens, extractOpenRouterCostDollars, extractOpenRouterGenerationIds } from '@pagespace/lib/monitoring/ai-monitoring';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { messageRepository } from '@/lib/repositories/message-repository';
import { getActivePlan } from '@/lib/ai/core/plan-binding';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { resolveGenerationAdmission } from '@/lib/ai/core/generation-admission';
import { conversationSessionDriveId } from '@/lib/ai/core/session-spend';
import { priceInterruptedStep } from '@/lib/ai/core/interrupted-step-cost';
import { createAdminRestrictedResponse, createSubscriptionRequiredResponse, requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import { buildSideQuestionSnapshot, createSideQuestionStream } from '@/lib/ai/btw/side-question';

export const maxDuration = 60;
const MAX_QUESTION_CHARS = 2_000;

export async function POST(request: Request) {
  // Credit-gate reservation. Hoisted so the finally can free it on any exit between
  // the gate and the stream taking it over; once the stream starts, its settlement
  // (trackUsage) owns the release.
  let holdId: string | undefined;
  // The wallet the hold was placed on, threaded to settlement with it (WAL-5).
  let walletId: string | undefined;
  let holdHandedOff = false;
  try {
    const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: true });
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_btw', resourceId: 'side-question', details: { reason: 'auth_failed', method: 'POST', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('conversationId' in body) || !('question' in body)) return NextResponse.json({ error: 'Invalid side question' }, { status: 400 });
    // Destructure to consts so the typeof narrowing below survives inside the
    // read closures passed to buildSideQuestionSnapshot (property narrowing on
    // `body` would reset inside those callbacks and fail the build).
    const { conversationId, question } = body;
    if (typeof conversationId !== 'string' || typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_CHARS) return NextResponse.json({ error: 'Invalid side question' }, { status: 400 });
    const [conversation] = await db.select({ userId: conversations.userId, isShared: conversations.isShared, type: conversations.type, contextId: conversations.contextId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation || !(await canAccessConversation(userId, conversation))) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_btw', resourceId: conversationId, details: { reason: 'conversation_not_accessible', method: 'POST' }, riskScore: 0.5 });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const trimmedQuestion = question.trim();
    const snapshot = await buildSideQuestionSnapshot({ conversationId, readMessages: () => messageRepository.getMessagesByConversationId(conversationId), readPlan: async () => (await getActivePlan(conversationId, userId))?.title ?? null });

    // Same admission as a chat turn, keyed off the provider that will ACTUALLY run
    // (resolveProviderModel is what createAIProvider resolves too).
    const [user] = await db.select({ subscriptionTier: users.subscriptionTier, role: users.role, currentAiProvider: users.currentAiProvider, currentAiModel: users.currentAiModel }).from(users).where(eq(users.id, userId)).limit(1);
    const { provider: effectiveProvider, model: effectiveModel } = resolveProviderModel(undefined, undefined, user?.currentAiProvider, user?.currentAiModel);
    const consumerTier = (user?.subscriptionTier ?? 'free') as SubscriptionTier;
    // A side question spends in the session of the conversation it asks about (SPEND-7):
    // a page or drive conversation's drive, or personal credits for a global one (SPEND-8).
    // It spends the source stored on that conversation (SPEND-3), or refuses (SPEND-4).
    const spend = conversationSpend(await conversationSessionDriveId(conversation), conversationId);
    // Entitlement exactly as a chat turn decides it: an admin-only provider is a
    // role block, a paid-tier model is a tier block (a downgraded user's stored
    // model must not keep running here) — for the tier of whoever funds the call (WAL-8).
    const admission = resolveGenerationAdmission({
      provider: effectiveProvider,
      model: effectiveModel,
      subscriptionTier: await resolveEntitlementTier(userId, consumerTier, spend),
      isAdmin: user?.role === 'admin',
      requiresProSubscription,
    });
    if (!admission.allowed) {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'ai_btw', resourceId: conversationId, details: { reason: admission.reason, provider: effectiveProvider, method: 'POST' }, riskScore: 0.5 });
      return admission.reason === 'provider_admin_only' ? createAdminRestrictedResponse() : createSubscriptionRequiredResponse();
    }
    // The reservation for this call. Also the ceiling on what an aborted run's
    // estimate may charge (see priceInterruptedStep).
    const holdCents = estimateChatHoldCentsForModel(effectiveModel, { inputTokens: estimateTokens(snapshot) + estimateTokens(trimmedQuestion) });
    // Prepaid credit gate BEFORE the provider is built: out_of_credits -> 402, the
    // in-flight cap -> 429. Metering-exempt providers bill on a flat external plan,
    // so they skip the gate (no hold) exactly as the chat pipeline does.
    if (!isMeteringExempt(effectiveProvider)) {
      const gate = await canConsumeAI(userId, consumerTier, {
        spend,
        estCostCents: holdCents,
        maxInFlight: MAX_CHAT_INFLIGHT,
      });
      if (!gate.allowed) {
        loggers.ai.warn('Side question: AI credit gate denied', { userId, reason: gate.reason });
        return creditGateErrorResponse(gate.reason, gate.refusal);
      }
      holdId = gate.holdId;
      walletId = gate.walletId;
    }

    const provider = await createAIProvider(userId, {}, { user: user ?? null });
    if ('error' in provider) return NextResponse.json({ error: provider.error }, { status: provider.status });

    const startTime = Date.now();
    const settledHoldId = holdId;
    const settledWalletId = walletId;
    const response = createSideQuestionStream({
      model: provider.model,
      question: trimmedQuestion,
      snapshot,
      abortSignal: request.signal,
      onSettle: async ({ outcome, usage, steps, interruptedStep, error }) => {
        // An abort cut the one step off before the provider reported usage: bill
        // the interrupted step by the shared policy, as an estimate. Its row is
        // kept off the OpenRouter cost reconcile, which would see no generation
        // for it and refund the charge.
        try {
          const interrupted = interruptedStep && (() => {
            const inputTokens = estimateTokens(interruptedStep.promptText);
            const outputTokens = estimateTokens(interruptedStep.outputText);
            return { inputTokens, outputTokens, ...priceInterruptedStep({ model: provider.modelName, inputTokens, outputTokens, holdCents }) };
          })();
          await AIMonitoring.trackUsage({
            userId,
            provider: provider.provider,
            model: provider.modelName,
            source: 'chat',
            ...(interrupted
              ? {
                inputTokens: interrupted.inputTokens,
                outputTokens: interrupted.outputTokens,
                totalTokens: interrupted.inputTokens + interrupted.outputTokens,
                providerCostDollars: interrupted.costDollars,
                openrouterGenerationIds: [],
                costSource: 'estimate' as const,
              }
              : {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined),
                providerCostDollars: extractOpenRouterCostDollars(steps),
                openrouterGenerationIds: extractOpenRouterGenerationIds(steps),
              }),
            duration: Date.now() - startTime,
            conversationId,
            success: outcome === 'finished',
            holdId: settledHoldId,
            walletId: settledWalletId,
            error: outcome === 'errored' ? (error instanceof Error ? error.message : String(error)) : undefined,
            metadata: {
              feature: 'side_question',
              outcome,
              ...(interrupted ? { abortedStep: { inputTokens: interrupted.inputTokens, outputTokens: interrupted.outputTokens, costDollars: interrupted.costDollars, capped: interrupted.capped } } : {}),
            },
          });
        } catch (trackError) {
          // trackUsage releases the hold on its own failure paths; this only keeps a
          // metering throw from surfacing as an unhandled rejection in the stream.
          loggers.ai.error('Side question: usage settlement failed', trackError as Error, { userId, conversationId });
        }
      },
    });
    // The stream's settlement owns the hold from here.
    holdHandedOff = true;
    return response;
  } finally {
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}
