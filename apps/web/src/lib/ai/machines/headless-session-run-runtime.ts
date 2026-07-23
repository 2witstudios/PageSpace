/**
 * Production wiring for the headless session engine.
 *
 * Everything the pure core (`headless-session-run.ts`) declares as a dep is
 * bound here to what the human path already uses, so a dispatched turn and a
 * typed turn on the SAME conversation are the same kind of event:
 *
 *  • the target's binding comes from `deriveMachinePaneBinding` — the identical
 *    call the chat route makes, against the TARGET row's own id, so the run's
 *    code-execution tools land in the target's node and its downward closure;
 *  • the tool set is composed the same way the route composes it
 *    (`filterToolsForMachineBinding` + `withSessionFamilyTools`), so a session
 *    dispatched to can do exactly what it could do if a human were typing;
 *  • messages go through `saveMessageToDatabase` and the same
 *    `chat:user_message` / `chat:stream_*` broadcasts, so an open pane renders
 *    the dispatch live rather than on next refresh;
 *  • usage is metered through `AIMonitoring.trackUsage` keyed on the OWNING
 *    MACHINE PAGE.
 *
 * THE RUN-CLAIM, and why it is `ai_stream_sessions`.
 *
 * The claim follows `executeWorkflow`'s discipline exactly — one atomic
 * INSERT … ON CONFLICT DO NOTHING against a UNIQUE index, the loser gets zero
 * rows back and bails — but it is taken in the stream table rather than in
 * `workflow_runs`. Two reasons, and the first is decisive:
 *
 *  1. The contention a session dispatch must lose to is a HUMAN typing in that
 *     pane. A machine agent session is an ordinary chat conversation, and its
 *     in-flight generations are registered in `ai_stream_sessions` — nowhere
 *     else. A claim held in any other table would happily run a second
 *     generation on a conversation a person is mid-turn in: two agents, two
 *     sets of write tools, two bills, one interleaved transcript.
 *  2. `workflow_runs.workflowId` is a foreign key into `workflows`. A session
 *     has no workflow row, so the table cannot physically hold this claim.
 *
 * The claim key is a deterministic `streamId` (`session-run:<conversationId>`)
 * carried on the `ai_stream_sessions.stream_id` UNIQUE index — so a second
 * dispatch to the same session conflicts and loses, exactly as a second
 * workflow fire does. A live human stream is caught by the liveness pre-check
 * below (a heartbeat read, the same one the takeover guard trusts), because a
 * client stream's row is keyed by its own messageId and would not collide.
 */

import { createId } from '@paralleldrive/cuid2';
import { generateText, stepCountIs, hasToolCall, type ToolSet, type UIMessage } from 'ai';
import { db } from '@pagespace/db/db';
import { and, eq, desc, ne, or } from '@pagespace/db/operators';
import { chatMessages, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { MAX_CHAT_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { deriveMachinePaneBinding } from '@pagespace/lib/services/machines/machine-pane-binding';
import { agentSurfaceOf, isAgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';
import { buildMachinePaneBindingDeps } from '@/lib/ai/machine-pane/machine-pane-binding-runtime';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, resolveProviderModel } from '@/lib/ai/core/ai-providers-config';
import { resolveGenerationAdmission } from '@/lib/ai/core/generation-admission';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { makeOnStepFinishHandler } from '@/app/api/ai/chat/step-finish-handler';
import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import {
  filterToolsForMachineBinding,
  filterToolsForAgentAllowlist,
  withSessionFamilyTools,
} from '@/lib/ai/core/tool-filtering';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { buildTimestampSystemPrompt } from '@/lib/ai/core/timestamp-utils';
import { saveMessageToDatabase } from '@/lib/ai/core/message-utils';
import { broadcastChatUserMessage, broadcastAiStreamStart, broadcastAiStreamComplete } from '@/lib/websocket';
import { STREAM_HEARTBEAT_STALE_MS } from '@/lib/ai/core/stream-liveness';
import type { ToolExecutionContext } from '@/lib/ai/core/types';
import { buildMachineBindingPrompt } from './machine-binding-prompt';
import { isClaimContested, buildHeadlessToolContext } from './headless-session-run';
import type {
  HeadlessClaimResult,
  HeadlessSessionRunDeps,
  HeadlessSessionTarget,
  HeadlessTranscriptMessage,
} from './headless-session-run';

/** How many prior turns a dispatched run is given as context. */
const HISTORY_LIMIT = 40;

/** Step budget for one dispatched turn — the workflow executor's shape, a session's scale. */
const MAX_STEPS = 60;

/** Heartbeat cadence for a held claim, matching `stream-lifecycle.ts`'s. */
const HEARTBEAT_INTERVAL_MS = 20 * 1000;

/**
 * The two independent reasons a dispatched run must stop — the CLAIM's (a human
 * took the pane over, or the lifetime backstop fired) and the CREDIT
 * accumulator's — as one signal. Either alone ends the generation.
 */
function mergeAbortSignals(claimSignal: AbortSignal | undefined, creditSignal: AbortSignal): AbortSignal {
  return claimSignal ? AbortSignal.any([claimSignal, creditSignal]) : creditSignal;
}

/** The claim key for one session's conversation — unique per conversation, by construction. */
export function sessionRunClaimId(conversationId: string): string {
  return `session-run:${conversationId}`;
}

/**
 * Is a generation ALREADY in flight on this conversation?
 *
 * Heartbeat-authoritative, never status-alone: the terminal write that clears
 * `status` is fire-and-forget and dies with its process, so a crashed stream
 * would otherwise lock a session out of dispatches forever (see
 * `stream-liveness.ts`'s own docblock on exactly this).
 */
async function hasLiveGeneration(conversationId: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt })
    .from(aiStreamSessions)
    .where(and(eq(aiStreamSessions.conversationId, conversationId), eq(aiStreamSessions.status, 'streaming')));

  return rows.some((row) => now.getTime() - row.lastHeartbeatAt.getTime() <= STREAM_HEARTBEAT_STALE_MS);
}

/**
 * Release a claim whose owner is provably gone.
 *
 * Only ever reached when `hasLiveGeneration` already said nothing is beating on
 * this conversation, so this cannot free a claim from a running dispatch — and
 * without it a crashed run's row would hold the unique key forever, making the
 * session permanently un-dispatchable.
 */
async function releaseStaleClaim(claimId: string): Promise<void> {
  await db
    .update(aiStreamSessions)
    .set({ status: 'aborted', completedAt: new Date(), streamId: null })
    .where(and(eq(aiStreamSessions.streamId, claimId), eq(aiStreamSessions.status, 'streaming')));
}

/**
 * Has a human asked this conversation's generation to stop?
 *
 * `stream-abort-mark.ts` records takeover and Stop DURABLY, as
 * `abortRequestedAt` on the streaming row — a mark, not a message, precisely so
 * a run in another process can see it. The interactive path consumes it through
 * the abort registry; a dispatched run has no registry entry, so it reads its
 * own row on the heartbeat it is already running.
 */
async function isAbortRequested(messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ abortRequestedAt: aiStreamSessions.abortRequestedAt })
    .from(aiStreamSessions)
    .where(eq(aiStreamSessions.messageId, messageId));
  return row?.abortRequestedAt != null;
}

async function claimRun({
  target,
  userId,
  messageId,
}: {
  target: HeadlessSessionTarget;
  userId: string;
  messageId: string;
}): Promise<HeadlessClaimResult> {
  const claimId = sessionRunClaimId(target.conversationId);
  const now = new Date();

  // A human mid-turn in this pane, or a dispatch that is still beating.
  if (await hasLiveGeneration(target.conversationId, now)) return { ok: false, reason: 'busy' };
  await releaseStaleClaim(claimId).catch((error) => {
    loggers.ai.warn('headless-session-run: stale claim release failed', {
      conversationId: target.conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });

  // THE claim. Losing the unique index is losing the race — never an error.
  const [row] = await db
    .insert(aiStreamSessions)
    .values({
      messageId,
      channelId: target.machineId,
      conversationId: target.conversationId,
      userId,
      displayName: target.title,
      browserSessionId: '',
      streamId: claimId,
      status: 'streaming',
      startedAt: now,
      lastHeartbeatAt: now,
    })
    .onConflictDoNothing()
    .returning({ messageId: aiStreamSessions.messageId });

  if (!row) return { ok: false, reason: 'busy' };

  // The pre-insert liveness check and the insert above are NOT one atomic
  // step: a human stream that registered in between has its own streamId and
  // sailed past our unique index. Now that OUR row is visible, re-read and
  // yield to any fresh foreign stream (see isClaimContested — the human always
  // wins, and only this side backs off, so there is no livelock).
  const contenders = await db
    .select({ streamId: aiStreamSessions.streamId, lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt })
    .from(aiStreamSessions)
    .where(and(eq(aiStreamSessions.conversationId, target.conversationId), eq(aiStreamSessions.status, 'streaming')));
  if (isClaimContested(contenders, claimId, STREAM_HEARTBEAT_STALE_MS, new Date())) {
    // Nothing has run under the claim — delete the row outright rather than
    // aborting it, so no released-claim residue is left on the conversation.
    await db.delete(aiStreamSessions).where(eq(aiStreamSessions.messageId, messageId)).catch(() => {});
    return { ok: false, reason: 'busy' };
  }

  // The claim's cancellation channel. Tripped by a human taking the pane over,
  // and by the lifetime backstop below; handed to the generation so either fact
  // actually ends the loop instead of being recorded beside a run that keeps
  // spending. (Issue #2204 follow-up, F7/F14.)
  const abortController = new AbortController();
  const startedAtMs = now.getTime();

  // A dispatched run can sit inside a single long tool call for minutes, so the
  // beat is a real timer — the same reason `stream-lifecycle.ts` refuses to ride
  // its parts checkpoint. `unref` so a held claim never keeps the process alive.
  const heartbeat = setInterval(() => {
    void (async () => {
      // The SAME horizon the normal stream lifecycle enforces. Without it a
      // provider request or tool call that never settles keeps this claim — and
      // its unique key — alive forever, which reads to every future dispatch as
      // "that session is permanently busy".
      if (Date.now() - startedAtMs >= STREAM_MAX_LIFETIME_MS) {
        abortController.abort();
        return;
      }
      if (await isAbortRequested(messageId).catch(() => false)) {
        abortController.abort();
        return;
      }
      await db
        .update(aiStreamSessions)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(aiStreamSessions.messageId, messageId))
        .catch(() => {});
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  void broadcastAiStreamStart({
    messageId,
    pageId: target.machineId,
    conversationId: target.conversationId,
    startedAt: now.toISOString(),
    triggeredBy: { userId, displayName: target.title, browserSessionId: '' },
  });

  return {
    ok: true,
    claim: {
      messageId,
      abortSignal: abortController.signal,
      release: async ({ aborted }) => {
        clearInterval(heartbeat);
        // `streamId: null` is what actually frees the claim — NULLs are distinct
        // under the unique index, so the next dispatch can take it immediately
        // rather than waiting for this row to go stale.
        await db
          .update(aiStreamSessions)
          .set({
            status: aborted ? 'aborted' : 'complete',
            completedAt: new Date(),
            streamId: null,
          })
          .where(eq(aiStreamSessions.messageId, messageId))
          .catch((error) => {
            loggers.ai.warn('headless-session-run: claim finalize failed', {
              messageId,
              error: error instanceof Error ? error.message : 'unknown',
            });
          });

        void broadcastAiStreamComplete({
          messageId,
          pageId: target.machineId,
          conversationId: target.conversationId,
          aborted,
        });
      },
    },
  };
}

/**
 * Resolve the addressed session into a runnable target.
 *
 * Returns null for anything that is not a chat-surface session — a shell row, a
 * retired agentType, a row whose binding no longer derives (its project or
 * branch is gone). Null is not an access decision: authorization already
 * happened in `session-tools.ts` against the derived handle set, and this
 * function is only asked about nodes that set already contained.
 */
async function resolveTarget(identity: {
  node: { machineId: string };
  name: string;
  address: { machineId: string; projectName?: string; branchName?: string; name: string };
}): Promise<HeadlessSessionTarget | null> {
  const { listAgentTerminals } = await import('@pagespace/lib/services/machines/agent-terminals');
  const { buildListAgentTerminalsDeps } = await import('@/lib/machines/agent-terminals-runtime');

  const listed = await listAgentTerminals({
    machineId: identity.address.machineId,
    ...(identity.address.projectName ? { projectName: identity.address.projectName } : {}),
    ...(identity.address.branchName ? { branchName: identity.address.branchName } : {}),
    deps: buildListAgentTerminalsDeps(),
  });
  if (!listed.ok) return null;

  const row = listed.terminals.find((candidate) => candidate.name === identity.address.name);
  if (!row) return null;
  if (!isAgentRuntimeType(row.agentType) || agentSurfaceOf(row.agentType) !== 'chat') return null;

  // The TARGET's own binding — derived from the target row's id, exactly as the
  // chat route derives a pane's. This is what puts the run's bash in the
  // target's sandbox at the target's cwd rather than the dispatcher's.
  const derived = await deriveMachinePaneBinding(
    { chatId: row.machineId, conversationId: row.id },
    buildMachinePaneBindingDeps(),
  );
  if (!derived || !derived.ok) return null;

  const [machinePage] = await db
    .select({ title: pages.title })
    .from(pages)
    .where(eq(pages.id, row.machineId));

  return {
    machineId: row.machineId,
    conversationId: row.id,
    node: derived.binding.self,
    binding: derived.binding,
    title: machinePage?.title ?? 'Machine Agent',
    name: row.name,
  };
}

async function loadHistory(
  target: HeadlessSessionTarget,
  opts: { excludeMessageId: string },
): Promise<HeadlessTranscriptMessage[]> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.pageId, target.machineId),
        eq(chatMessages.conversationId, target.conversationId),
        eq(chatMessages.isActive, true),
        // The dispatched message itself — generate() carries it explicitly, so
        // history returning it too would double every instruction.
        ne(chatMessages.id, opts.excludeMessageId),
        // Placeholders for a generation still in flight carry no content — this
        // feeds a model's context, so they are excluded exactly as `ask_agent`
        // excludes them.
        ne(chatMessages.status, 'streaming'),
        // In SQL, not JS: a post-LIMIT role filter would let system/tool rows
        // consume HISTORY_LIMIT slots and silently shorten the run's context.
        or(eq(chatMessages.role, 'user'), eq(chatMessages.role, 'assistant')),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(HISTORY_LIMIT);

  return rows
    .reverse()
    .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }));
}

/**
 * The dispatched turn's system prompt.
 *
 * Same three layers the human path assembles — the machine page's own prompt,
 * timestamp context, and the FROZEN machine-binding block — plus one honest
 * statement of the situation: nobody is watching this run, so it cannot ask a
 * question and wait, and its answer reaches the dispatcher only by being
 * written into this transcript.
 */
function buildSystemPrompt(target: HeadlessSessionTarget, basePrompt: string | null): string {
  return (
    (basePrompt || 'You are a PageSpace Agent running on a machine.') +
    `\n\n${buildTimestampSystemPrompt()}` +
    buildMachineBindingPrompt(target.binding) +
    `\n\nDISPATCHED TURN (no one is watching this run)` +
    `\n• This turn was sent to you by another agent through send_session. There is no interactive user attached: do not ask a question and wait for an answer — nothing will answer.` +
    `\n• Finish the work you were asked to do, then state the outcome plainly in your reply. Your reply is written to this session's transcript, which is the ONLY way the sender sees your result (they read it with read_session).`
  );
}

async function generate(input: {
  target: HeadlessSessionTarget;
  message: string;
  history: HeadlessTranscriptMessage[];
  userId: string;
  depth: number;
  abortSignal?: AbortSignal;
  balanceSnapshotCents?: number | null;
  onStepUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => void;
}): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; toolCallCount?: number; provider: string; model: string }> {
  const { target, userId, depth } = input;

  const [machinePage] = await db
    .select({ id: pages.id, title: pages.title, type: pages.type, systemPrompt: pages.systemPrompt, aiProvider: pages.aiProvider, aiModel: pages.aiModel, enabledTools: pages.enabledTools })
    .from(pages)
    .where(eq(pages.id, target.machineId));

  // ENTITLEMENT, before a token is spent (issue #2204 follow-up, F4). The
  // machine page's configured provider/model is not the dispatcher's own
  // selection, so a free or non-admin collaborator could otherwise reach a
  // paid or admin-only provider through send_session that the chat route would
  // have refused them. Same shared decision, same answer, different transport.
  const [actor] = await db
    .select({ role: users.role, subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId));
  const requested = resolveProviderModel(
    machinePage?.aiProvider || DEFAULT_PROVIDER,
    machinePage?.aiModel || DEFAULT_MODEL,
    undefined,
    undefined,
  );
  const admission = resolveGenerationAdmission({
    provider: requested.provider,
    model: requested.model,
    subscriptionTier: actor?.subscriptionTier ?? undefined,
    isAdmin: actor?.role === 'admin',
    requiresProSubscription,
  });
  if (!admission.allowed) {
    throw new Error(
      admission.reason === 'provider_admin_only'
        ? 'This machine is configured with an administrator-only AI provider.'
        : 'This machine is configured with a model that requires a paid plan.',
    );
  }

  const providerResult = await createAIProvider(userId, {
    selectedProvider: machinePage?.aiProvider || DEFAULT_PROVIDER,
    selectedModel: machinePage?.aiModel || DEFAULT_MODEL,
  });
  if (isProviderError(providerResult)) throw new Error(`AI provider error: ${providerResult.error}`);

  // The bound-conversation tool surface, composed exactly as the chat route
  // composes it: machine tools minus switch_machine/list_machines, plus the
  // session family, MINUS whatever the page's saved allowlist excludes — a
  // restriction the owner configured must not evaporate just because the same
  // session was reached by dispatch instead of a browser. The session family
  // survives the allowlist for the same reason it does interactively (it is
  // the binding's orchestration surface; see filterToolsForAgentAllowlist).
  const { buildSessionTools } = await import('@/lib/ai/tools/session-tools-runtime');
  const tools = filterToolsForAgentAllowlist(
    withSessionFamilyTools(
      filterToolsForMachineBinding(pageSpaceTools, true),
      buildSessionTools(),
      true,
    ),
    (machinePage?.enabledTools as string[] | null) ?? null,
  ) as ToolSet;

  const context = buildHeadlessToolContext({
    target,
    machinePage: machinePage ? { id: machinePage.id, title: machinePage.title, type: machinePage.type } : undefined,
    userId,
    depth,
  }) as ToolExecutionContext;

  const messages = [
    ...input.history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: 'user' as const, content: input.message },
  ];

  // The interactive route's balance-aware step accumulator, on the dispatched
  // path (issue #2204 follow-up, F5). Up to MAX_STEPS of model work can follow
  // a single reservation, so without this a low-balance user keeps spending
  // well past what was reserved for them.
  const creditAbortController = new AbortController();
  const guardBalance =
    input.balanceSnapshotCents != null
      ? makeOnStepFinishHandler(creditAbortController, input.balanceSnapshotCents, providerResult.modelName)
      : null;
  const abortSignal = mergeAbortSignals(input.abortSignal, creditAbortController.signal);

  // ALWAYS registered, not only when a balance guard exists: this is also how
  // the engine learns what the provider already charged for, so an aborted run
  // still bills its completed steps (see HeadlessGenerateInput.onStepUsage).
  const onStepFinish = ({ usage }: { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) => {
    input.onStepUsage?.(usage);
    guardBalance?.(usage);
  };

  const result = await generateText({
    model: providerResult.model,
    system: buildSystemPrompt(target, machinePage?.systemPrompt ?? null),
    messages,
    tools: { ...tools, ...finishTool },
    toolChoice: 'auto',
    maxRetries: 3,
    experimental_context: context,
    abortSignal,
    onStepFinish,
    stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(MAX_STEPS)],
  });

  // Text from EVERY step: `result.text` is the final step alone, which is empty
  // whenever the model's last act was calling the finish tool.
  const text = result.steps?.map((step) => step.text).filter(Boolean).join('') || '';

  return {
    text,
    usage: result.totalUsage
      ? {
          inputTokens: result.totalUsage.inputTokens,
          outputTokens: result.totalUsage.outputTokens,
          totalTokens: result.totalUsage.totalTokens,
        }
      : undefined,
    toolCallCount: result.steps?.flatMap((step) => step.toolCalls ?? []).length ?? 0,
    // What the loop ACTUALLY ran on — the factory's resolved identity, so a
    // machine page with its own provider/model is billed at that rate, never
    // the default's.
    provider: providerResult.provider,
    model: providerResult.modelName,
  };
}

export function buildHeadlessSessionRunDeps(): HeadlessSessionRunDeps {
  return {
    resolveTarget,
    claimRun,

    // The interactive path's admission control (chat/route.ts's canConsumeAI
    // gate), applied to the dispatched path: a user at their limit is refused
    // before the claim, and the hold is released by the engine once the run
    // settles (consumption itself flows through trackUsage).
    checkCredit: async ({ userId }) => {
      const [user] = await db
        .select({ subscriptionTier: users.subscriptionTier })
        .from(users)
        .where(eq(users.id, userId));
      const gate = await canConsumeAI(userId, (user?.subscriptionTier ?? 'free') as SubscriptionTier, {
        // The interactive route's CONFIGURED cap, not the gate's default
        // (issue #2204 follow-up, F6). Each session's claim is independent, so
        // without this a paid user dispatching to many different sessions at
        // once faced no concurrency ceiling at all — an unbounded headless
        // fan-out of reservations the chat composer could never produce.
        maxInFlight: MAX_CHAT_INFLIGHT,
      });
      if (!gate.allowed) return { allowed: false, reason: gate.reason ?? 'denied' };
      return {
        allowed: true,
        holdId: gate.holdId ?? null,
        // The run's OWN slice of the balance — what its per-step accumulator
        // guards against, so concurrent runs cannot collectively overshoot.
        balanceSnapshotCents:
          gate.holdId && gate.balanceSnapshot ? gate.balanceSnapshot.netSpendableCents : null,
      };
    },
    releaseHold: async (holdId) => {
      await releaseHold(holdId);
    },

    appendMessage: async ({ target, userId, messageId, content }) => {
      const uiMessage: UIMessage = {
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', text: content }],
      };
      await saveMessageToDatabase({
        messageId,
        pageId: target.machineId,
        conversationId: target.conversationId,
        userId,
        role: 'user',
        content,
        uiMessage,
      });
      // The pane a human has open renders this immediately — a dispatched
      // instruction that only appears on refresh looks like nothing happened.
      void broadcastChatUserMessage({
        message: uiMessage,
        pageId: target.machineId,
        conversationId: target.conversationId,
        triggeredBy: { userId, displayName: target.title, browserSessionId: '' },
      });
    },

    loadHistory,
    generate,

    persistReply: async ({ target, messageId, content, aborted }) => {
      await saveMessageToDatabase({
        messageId,
        pageId: target.machineId,
        conversationId: target.conversationId,
        userId: null,
        role: 'assistant',
        content,
        status: aborted ? 'interrupted' : 'complete',
      });
    },

    trackUsage: async ({ userId, pageId, conversationId, usage, success, provider, model }) => {
      await AIMonitoring.trackUsage({
        userId,
        // The generate result's resolved identity; the defaults only for a run
        // that failed before a provider was ever resolved (usage is absent
        // there too, so nothing is charged at the wrong rate).
        provider: provider ?? DEFAULT_PROVIDER,
        model: model ?? DEFAULT_MODEL,
        source: 'page_agent',
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        conversationId,
        // The OWNING MACHINE PAGE — the runtime-guardrail/payer key every node
        // of the tree bills against (see `MachineNodeHandle.machineId`).
        pageId,
        success,
        metadata: { feature: 'send_session' },
      });
    },

    newId: () => createId(),

    // Fire-and-forget: the ACK returns to the dispatching model immediately and
    // the loop keeps running. `after()` is unavailable inside tool execution
    // (the same constraint ask_agent's compaction hits), so this is a detached
    // promise with its own error handling inside the engine.
    defer: (run) => {
      void run();
    },

    onError: (message, error) => {
      loggers.ai.error(message, error instanceof Error ? error : undefined);
    },
  };
}
