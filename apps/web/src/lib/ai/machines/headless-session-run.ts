/**
 * The HEADLESS SESSION ENGINE — running one agent session's own loop with no
 * client attached.
 *
 * `send_session` on an agent session appends a message to that session's
 * conversation and then runs THAT session's agent loop server-side: the target
 * keeps its own identity (its machine page, its conversation, its node), so a
 * dispatch to a branch session runs bash inside the branch's own Sprite at the
 * branch's own cwd — never the dispatcher's. The dispatcher gets an ACK the
 * moment the work is claimed and durable; the run itself continues in the
 * background and its result lands in the target's transcript, which is what
 * `read_session` reads and what a human watching that pane sees live.
 *
 * The shape is `executeWorkflow`'s (apps/web/src/lib/workflows/workflow-executor.ts):
 * CLAIM first, run inside a try, finalize the claim exactly once. What differs
 * is what a lost claim means. A workflow's claim is only ever contended by
 * another workflow fire; a session's conversation is ALSO a live chat surface a
 * human may be talking to right now, so the claim covers both — see
 * `HeadlessRunClaim`. Losing it is not an error to retry, it is a fact to
 * report: someone else is already working in that session.
 *
 * PURE CORE. No DB, no provider SDK, no clock of its own — every effect is an
 * injected dep, so the depth cap, the claim conflict, the ACK-before-run
 * ordering and the billing key are all unit-testable without a database.
 * Production wiring lives in `headless-session-run-runtime.ts`.
 */

import type {
  MachineNodeHandle,
  MachineNodeHandleSet,
} from '@pagespace/lib/services/machines/machine-pane-binding';
import type { SessionTerminalIdentity } from '@/lib/ai/tools/session-tools';

/**
 * Nesting cap for dispatch chains, held at the SAME value and with the same
 * meaning as `ask_agent`'s (`agent-communication-tools.ts`): a run that was
 * itself started at depth N dispatches at depth N+1, and a dispatch arriving at
 * the cap is refused rather than queued. Machine sessions make chains cheap to
 * build (A dispatches to B, B to C) and each link is a full agent loop with
 * code execution — an uncapped chain is an unbounded fan-out of billable work
 * that nobody is watching.
 */
export const MAX_AGENT_DEPTH = 2;

/** The target session, fully resolved: who it is, where it runs, and who pays. */
export interface HeadlessSessionTarget {
  /**
   * The OWNING MACHINE PAGE id. The transcript's page, and — deliberately —
   * the billing/budget key for everything this run does, exactly as it is for
   * a targeted tool call (see `MachineNodeHandle.machineId`). Dispatching into
   * a branch session never moves the money off the machine page.
   */
  machineId: string;
  /** The agent-terminal row id, which IS this session's conversation id. */
  conversationId: string;
  /** The node the session runs at — its cwd and its Sprite. */
  node: MachineNodeHandle;
  /**
   * The TARGET's own derived handle set, not the dispatcher's. This is what
   * pins the run's code-execution tools to the target's node and its downward
   * closure; a dispatcher at the machine root cannot widen a branch session's
   * reach by sending it a message.
   */
  binding: MachineNodeHandleSet;
  /** The machine page's title — the transcript's speaker name. */
  title: string;
  /** The session's own name at its node, for logs and prompt context. */
  name: string;
}

/**
 * A held run-claim on one conversation.
 *
 * The claim is what makes a dispatch safe to fire and forget. It is contended
 * by (a) another dispatch to the same session and (b) a HUMAN's live stream on
 * that same conversation — a machine agent pane is an ordinary chat surface, so
 * a person can be mid-conversation with the exact session being dispatched to.
 * Running anyway would put two generations on one conversation: two sets of
 * write tools, two bills, and a transcript interleaved out of order.
 */
export interface HeadlessRunClaim {
  /** The assistant message id this run will write into. */
  messageId: string;
  /**
   * The claim's cancellation channel (issue #2204 follow-up, F7/F14).
   *
   * The claim is what watches the conversation, so the claim is what learns
   * that the run must stop — a human taking the pane over (a durable
   * `abortRequestedAt` mark), or the run outliving its lifetime backstop. The
   * generation is handed this signal so those facts actually end the loop
   * rather than merely being recorded next to a loop that keeps billing.
   */
  abortSignal?: AbortSignal;
  /** Release the claim, exactly once, whatever the outcome. */
  release: (outcome: { aborted: boolean; error?: string }) => Promise<void>;
}

export type HeadlessClaimResult =
  | { ok: true; claim: HeadlessRunClaim }
  /** Someone (or something) else is already generating on this conversation. */
  | { ok: false; reason: 'busy' };

export interface HeadlessTranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HeadlessGenerateInput {
  target: HeadlessSessionTarget;
  /** The dispatched message, already appended to the transcript. */
  message: string;
  /** Prior turns of this session's conversation, oldest first. */
  history: HeadlessTranscriptMessage[];
  /** The user this run is attributed to (the dispatcher's own user). */
  userId: string;
  /** The depth THIS run executes at — what its own tools see as `agentCallDepth`. */
  depth: number;
  /** The claim's cancellation channel — see {@link HeadlessRunClaim.abortSignal}. */
  abortSignal?: AbortSignal;
  /** Net spendable cents behind this run's reservation, or null when unmetered. */
  balanceSnapshotCents?: number | null;
  /**
   * Cumulative usage after each completed model step (issue #2204 follow-up
   * review, Codex P1).
   *
   * The final `HeadlessGenerateResult` is the only usage report a SUCCESSFUL
   * run needs — but an aborted or failed one never produces it. A run stopped
   * by takeover, by the credit guard, or by the lifetime backstop rejects out
   * of `generateText` after the provider has already charged for the steps it
   * completed, and `trackAIUsage` skips an unsuccessful zero-token call
   * entirely (`success || totalTokens > 0`), so those tokens went unbilled.
   * Reporting per step makes the charge survive any exit.
   */
  onStepUsage?: (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => void;
}

export interface HeadlessGenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  toolCallCount?: number;
  /** The provider/model the loop ACTUALLY ran on — billing must record these, never a default. */
  provider?: string;
  model?: string;
}

/**
 * The post-insert half of the conversation claim.
 *
 * The runtime's pre-insert liveness check and its claim INSERT are two steps,
 * not one: a human stream can register in between, and a client stream's row
 * (keyed by its own streamId) never collides with `session-run:<id>`'s unique
 * index. So after the claim row is visible, the runtime re-reads the
 * conversation's streaming rows and asks THIS question: is any FOREIGN row
 * (not our claim) still beating? If so, the dispatch backs off and releases —
 * the human always wins, and exactly one side yields, so the pair of checks
 * serializes the conversation without a table lock. Heartbeat-authoritative
 * for the same reason the pre-check is (a crashed stream must not lock the
 * session forever). A NULL streamId still contests: it is not ours.
 */
export function isClaimContested(
  rows: ReadonlyArray<{ streamId: string | null; lastHeartbeatAt: Date }>,
  claimId: string,
  staleMs: number,
  now: Date,
): boolean {
  return rows.some(
    (row) => row.streamId !== claimId && now.getTime() - row.lastHeartbeatAt.getTime() <= staleMs,
  );
}

/** The machine page a dispatched run executes as — the slice the tool context needs. */
export interface HeadlessMachinePage {
  id: string;
  title: string;
  type: string;
}

/**
 * The tool-execution context a dispatched turn runs under (issue #2204
 * follow-up, F8).
 *
 * THE PART THAT IS EASY TO GET WRONG, and was: `chatSource`.
 * `resolveSandboxActorContext` fails CLOSED — "Code execution requires an
 * active drive" — for any context whose `chatSource.type` is not `'global'`
 * and that carries no drive. It reaches a page agent's drive through
 * `chatSource.agentPageId`, so a context with `locationContext.currentPage`
 * alone looks driveless and every bash/file/git tool in the run is refused.
 * A dispatched session is a page agent on the machine page, exactly as the
 * interactive route describes it, so it must say so the same way.
 *
 * Pure, and separated from the runtime's `generate` for that reason: this is
 * the whole difference between a dispatched session that can execute code and
 * one that cannot, and it should never again be provable only by dispatching.
 */
export interface HeadlessToolContext {
  userId: string;
  conversationId: string;
  machineBinding: MachineNodeHandleSet;
  agentCallDepth: number;
  requestOrigin: 'agent';
  chatSource?: { type: 'page'; agentPageId: string; agentTitle: string };
  locationContext?: { currentPage: { id: string; title: string; type: string; path: string } };
}

export function buildHeadlessToolContext(input: {
  target: HeadlessSessionTarget;
  machinePage: HeadlessMachinePage | undefined;
  userId: string;
  depth: number;
}): HeadlessToolContext {
  const { target, machinePage, userId, depth } = input;
  return {
    userId,
    conversationId: target.conversationId,
    machineBinding: target.binding,
    // Its own dispatches are one level deeper than this run — the cap in
    // `dispatchHeadlessSessionTurn` reads this counter back off the context.
    agentCallDepth: depth,
    requestOrigin: 'agent',
    ...(machinePage
      ? {
          chatSource: {
            type: 'page' as const,
            agentPageId: machinePage.id,
            agentTitle: machinePage.title,
          },
          locationContext: {
            currentPage: {
              id: machinePage.id,
              title: machinePage.title,
              type: machinePage.type,
              path: `/${machinePage.title}`,
            },
          },
        }
      : {}),
  };
}

export interface HeadlessSessionRunDeps {
  /** Resolve the addressed session into a runnable target, or null if it is not an agent session. */
  resolveTarget: (identity: SessionTerminalIdentity) => Promise<HeadlessSessionTarget | null>;
  /**
   * The SAME admission control the interactive path runs (`canConsumeAI`): a
   * user at their limit must be refused here too, or send_session becomes the
   * unmetered way around the chat route's gate. Checked BEFORE the claim, so a
   * denied dispatch leaves nothing behind.
   */
  checkCredit: (input: {
    userId: string;
  }) => Promise<
    | {
        allowed: true;
        holdId: string | null;
        /**
         * Net spendable cents behind this reservation, when the gate computed
         * one. Threaded to `generate` so the run's per-step accumulator guards
         * against ITS OWN slice of the balance rather than the gross figure —
         * the same discipline the interactive route applies. (F5.)
         */
        balanceSnapshotCents?: number | null;
      }
    | { allowed: false; reason: string }
  >;
  /** Release the gate's hold once the run settles — actual consumption flows through `trackUsage`. */
  releaseHold: (holdId: string) => Promise<void>;
  /** Atomic claim on the conversation — the workflow_runs discipline, contended by live streams too. */
  claimRun: (input: {
    target: HeadlessSessionTarget;
    userId: string;
    messageId: string;
  }) => Promise<HeadlessClaimResult>;
  /** Persist the dispatched message into the target's transcript AND broadcast it. */
  appendMessage: (input: {
    target: HeadlessSessionTarget;
    userId: string;
    messageId: string;
    content: string;
  }) => Promise<void>;
  /**
   * The target conversation's prior turns, oldest first — EXCLUDING the
   * message this dispatch just appended (`excludeMessageId`): the run passes
   * that message to `generate` explicitly, and a history read that also
   * returned it would hand the model every dispatched instruction twice.
   */
  loadHistory: (
    target: HeadlessSessionTarget,
    opts: { excludeMessageId: string },
  ) => Promise<HeadlessTranscriptMessage[]>;
  /** Run the target's own agent loop under the target's binding. */
  generate: (input: HeadlessGenerateInput) => Promise<HeadlessGenerateResult>;
  /** Persist the reply into the transcript (and broadcast its arrival). */
  persistReply: (input: {
    target: HeadlessSessionTarget;
    messageId: string;
    content: string;
    aborted: boolean;
  }) => Promise<void>;
  /** Meter the run. `pageId` is the OWNING MACHINE PAGE — never the node, never the drive agent. */
  trackUsage: (input: {
    userId: string;
    pageId: string;
    conversationId: string;
    usage: HeadlessGenerateResult['usage'];
    success: boolean;
    /** From the generate result — absent when the run failed before generating. */
    provider?: string;
    model?: string;
  }) => Promise<void>;
  /** Fresh message ids. */
  newId: () => string;
  /**
   * Run the loop OUT OF BAND. Production hands this to the runtime's
   * fire-and-forget; tests hand it a collector so the whole run is observable.
   * The ACK is returned before this ever resolves — that asymmetry is the
   * feature, and putting it behind a dep is what makes it assertable.
   */
  defer: (run: () => Promise<void>) => void;
  /** Non-fatal diagnostics. */
  onError?: (message: string, error: unknown) => void;
}

export interface HeadlessDispatchInput {
  identity: SessionTerminalIdentity;
  actor: { userId: string };
  message: string;
  /**
   * The DISPATCHER's depth — 0 for a human-driven turn, N for a turn that is
   * itself running inside a headless run at depth N. The dispatched run
   * executes at `depth + 1`.
   */
  depth: number;
}

export type HeadlessDispatchResult =
  | {
      ok: true;
      /** Always true: the message is durable and the run is claimed, but no answer exists yet. */
      accepted: true;
      messageId: string;
    }
  | {
      ok: false;
      reason: 'not_an_agent_session' | 'busy' | 'depth_exceeded' | 'credit_denied' | 'failed';
      detail?: string;
    };

/**
 * Dispatch one turn to an agent session.
 *
 * ORDER IS THE CONTRACT, and it is the same order `executeWorkflow` uses:
 *
 *   1. depth cap — refuse before anything is persisted, so a refused chain
 *      leaves no half-message in a transcript;
 *   2. resolve the target (and with it, the target's OWN binding);
 *   3. CLAIM the conversation — before the message is written, so a losing
 *      dispatch does not leave an unanswered message behind;
 *   4. append + broadcast the message — now the watching pane shows it;
 *   5. ACK, and run the loop out of band under the held claim.
 *
 * Step 3 before step 4 is the one that is easy to get backwards. A message
 * appended by a dispatch that then loses the claim reads, to the session and to
 * the human watching it, as an instruction that was delivered and ignored.
 */
export async function dispatchHeadlessSessionTurn(
  input: HeadlessDispatchInput,
  deps: HeadlessSessionRunDeps,
): Promise<HeadlessDispatchResult> {
  if (input.depth >= MAX_AGENT_DEPTH) {
    return { ok: false, reason: 'depth_exceeded' };
  }

  const target = await deps.resolveTarget(input.identity);
  if (!target) return { ok: false, reason: 'not_an_agent_session' };

  // Admission control before the claim: a denied dispatch must leave no claim
  // held and no message appended — the same "refuse before anything is
  // persisted" rule as the depth cap.
  const credit = await deps.checkCredit({ userId: input.actor.userId });
  if (!credit.allowed) {
    return { ok: false, reason: 'credit_denied', detail: credit.reason };
  }
  const holdId = credit.holdId;
  const balanceSnapshotCents = credit.balanceSnapshotCents ?? null;

  const releaseHold = async () => {
    if (holdId) await deps.releaseHold(holdId).catch(() => {});
  };

  const messageId = deps.newId();
  // THROWS release the hold too (issue #2204 follow-up, F15). A `busy` result
  // and an append failure both released it; a claimRun that rejected on a
  // database or network blip exited before any cleanup, stranding spendable
  // balance until the hold's TTL expired. Every exit after the hold exists is
  // now a releasing exit.
  let claimed: HeadlessClaimResult;
  try {
    claimed = await deps.claimRun({ target, userId: input.actor.userId, messageId });
  } catch (error) {
    deps.onError?.('headless-session-run: claim failed', error);
    await releaseHold();
    return { ok: false, reason: 'failed', detail: errorText(error) };
  }
  if (!claimed.ok) {
    // No run will happen — a hold left behind would strand spendable balance
    // until it expires.
    await releaseHold();
    return { ok: false, reason: 'busy' };
  }
  const claim = claimed.claim;

  const userMessageId = deps.newId();
  try {
    await deps.appendMessage({
      target,
      userId: input.actor.userId,
      messageId: userMessageId,
      content: input.message,
    });
  } catch (error) {
    // The claim is ours and the run will never happen — release it rather than
    // leaving the session unreachable until the claim goes stale.
    deps.onError?.('headless-session-run: append failed', error);
    await claim.release({ aborted: true, error: errorText(error) }).catch(() => {});
    await releaseHold();
    return { ok: false, reason: 'failed', detail: errorText(error) };
  }

  deps.defer(() => runClaimedTurn({ input, target, claim, holdId, balanceSnapshotCents, userMessageId, deps }));

  return { ok: true, accepted: true, messageId: claim.messageId };
}

/**
 * The claimed run itself. Every exit path releases the claim exactly once —
 * a claim that outlives its run makes the session permanently un-dispatchable
 * until it goes stale, which is indistinguishable from a hung agent.
 */
async function runClaimedTurn({
  input,
  target,
  claim,
  holdId,
  balanceSnapshotCents,
  userMessageId,
  deps,
}: {
  input: HeadlessDispatchInput;
  target: HeadlessSessionTarget;
  claim: HeadlessRunClaim;
  holdId: string | null;
  balanceSnapshotCents: number | null;
  userMessageId: string;
  deps: HeadlessSessionRunDeps;
}): Promise<void> {
  let result: HeadlessGenerateResult | undefined;
  let failure: string | undefined;

  // What the provider has ALREADY charged for, accumulated as the run goes, so
  // an abort or a mid-loop failure still bills what it spent. See
  // `HeadlessGenerateInput.onStepUsage`.
  const spent = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let spentAnything = false;

  try {
    const history = await deps.loadHistory(target, { excludeMessageId: userMessageId });
    result = await deps.generate({
      target,
      message: input.message,
      history,
      userId: input.actor.userId,
      // The run executes one level deeper than the dispatcher, so a session it
      // dispatches to in turn sees the chain it is actually part of.
      depth: input.depth + 1,
      ...(claim.abortSignal ? { abortSignal: claim.abortSignal } : {}),
      balanceSnapshotCents,
      onStepUsage: (usage) => {
        spentAnything = true;
        spent.inputTokens += usage.inputTokens ?? 0;
        spent.outputTokens += usage.outputTokens ?? 0;
        spent.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      },
    });
    await deps.persistReply({
      target,
      messageId: claim.messageId,
      content: result.text,
      aborted: false,
    });
  } catch (error) {
    failure = errorText(error);
    deps.onError?.('headless-session-run: run failed', error);
    // A failed run still gets a terminal transcript entry: a session that
    // silently produces nothing is indistinguishable from one still thinking.
    await deps
      .persistReply({
        target,
        messageId: claim.messageId,
        content: `This session could not complete the dispatched turn: ${failure}`,
        aborted: true,
      })
      .catch(() => {});
  }

  // Metering is keyed on the OWNING MACHINE PAGE — the same key a targeted
  // bash call bills against — so a headless run is not a hole in the machine's
  // budget. Awaited for the same reason `executeWorkflow` awaits it: the charge
  // must be durable before the run reports done.
  try {
    await deps.trackUsage({
      userId: input.actor.userId,
      pageId: target.machineId,
      conversationId: target.conversationId,
      // The completed run's own total when there is one; otherwise what the
      // steps reported before the abort/failure — never nothing, or the
      // provider's charge for those steps is silently absorbed.
      usage: result?.usage ?? (spentAnything ? spent : undefined),
      success: failure === undefined,
      provider: result?.provider,
      model: result?.model,
    });
  } catch (error) {
    deps.onError?.('headless-session-run: usage tracking failed', error);
  }

  await claim.release({ aborted: failure !== undefined, error: failure }).catch((error) => {
    deps.onError?.('headless-session-run: claim release failed', error);
  });

  // The hold has done its job (admission); actual consumption flowed through
  // trackUsage above. Released last, and unconditionally — success, failure,
  // or a generate that threw — so the user's spendable balance is accurate.
  if (holdId) {
    await deps.releaseHold(holdId).catch((error) => {
      deps.onError?.('headless-session-run: hold release failed', error);
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
