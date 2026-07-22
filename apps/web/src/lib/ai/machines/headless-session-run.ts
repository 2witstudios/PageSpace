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
}

export interface HeadlessGenerateResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  toolCallCount?: number;
}

export interface HeadlessSessionRunDeps {
  /** Resolve the addressed session into a runnable target, or null if it is not an agent session. */
  resolveTarget: (identity: SessionTerminalIdentity) => Promise<HeadlessSessionTarget | null>;
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
  /** The target conversation's prior turns, oldest first. */
  loadHistory: (target: HeadlessSessionTarget) => Promise<HeadlessTranscriptMessage[]>;
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
  | { ok: false; reason: 'not_an_agent_session' | 'busy' | 'depth_exceeded' | 'failed'; detail?: string };

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

  const messageId = deps.newId();
  const claimed = await deps.claimRun({ target, userId: input.actor.userId, messageId });
  if (!claimed.ok) return { ok: false, reason: 'busy' };
  const claim = claimed.claim;

  try {
    await deps.appendMessage({
      target,
      userId: input.actor.userId,
      messageId: deps.newId(),
      content: input.message,
    });
  } catch (error) {
    // The claim is ours and the run will never happen — release it rather than
    // leaving the session unreachable until the claim goes stale.
    deps.onError?.('headless-session-run: append failed', error);
    await claim.release({ aborted: true, error: errorText(error) }).catch(() => {});
    return { ok: false, reason: 'failed', detail: errorText(error) };
  }

  deps.defer(() => runClaimedTurn({ input, target, claim, deps }));

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
  deps,
}: {
  input: HeadlessDispatchInput;
  target: HeadlessSessionTarget;
  claim: HeadlessRunClaim;
  deps: HeadlessSessionRunDeps;
}): Promise<void> {
  let result: HeadlessGenerateResult | undefined;
  let failure: string | undefined;

  try {
    const history = await deps.loadHistory(target);
    result = await deps.generate({
      target,
      message: input.message,
      history,
      userId: input.actor.userId,
      // The run executes one level deeper than the dispatcher, so a session it
      // dispatches to in turn sees the chain it is actually part of.
      depth: input.depth + 1,
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
      usage: result?.usage,
      success: failure === undefined,
    });
  } catch (error) {
    deps.onError?.('headless-session-run: usage tracking failed', error);
  }

  await claim.release({ aborted: failure !== undefined, error: failure }).catch((error) => {
    deps.onError?.('headless-session-run: claim release failed', error);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
