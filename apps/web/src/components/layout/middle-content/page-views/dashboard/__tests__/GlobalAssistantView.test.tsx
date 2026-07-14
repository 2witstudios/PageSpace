/**
 * GlobalAssistantView load-on-select regression tests
 *
 * Pure-function mirrors of the two load-on-select effects in
 * GlobalAssistantView.tsx (global-mode and agent-mode), following the same
 * extraction pattern used in SidebarChatTab.test.tsx — the component itself
 * is too hook-heavy to render cheaply in a unit test.
 *
 * Both effects previously fired unconditionally on a messages-reference
 * change (mount, reload, conversation/agent switch), which clobbers an
 * actively-streaming local Chat instance's messages with a stale snapshot
 * that predates the in-progress reply. This file pins the fix: both must
 * skip while this surface is actively streaming.
 */

import { describe, it, expect } from 'vitest';
import { resolveResumeAction } from '@/lib/ai/streams/resolveResumeAction';

/**
 * Mirrors the global-mode load-on-select effect (~line 1019-1044):
 * `if (selectedAgent) return; if (globalInitialMessages === prevRef) return; if (!globalIsInitialized || !globalConversationId || isOwnGlobalStreamForCurrentConversation) return; prevRef = globalInitialMessages; setGlobalLocalMessages(globalInitialMessages);`
 *
 * The prevRef/dedup check is load-bearing (CodeRabbit review on this PR): without it, this
 * effect re-fires on EVERY isOwnGlobalStreamForCurrentConversation transition, including the
 * streaming -> not-streaming edge at the end of an ordinary send. `globalInitialMessages` is not
 * refreshed for a fresh own completion (GlobalChatContext's onStreamComplete deliberately
 * no-ops for that case), so re-firing without the dedup would reapply the stale pre-send
 * snapshot and wipe the just-completed reply straight back out of the surface's own useChat
 * state.
 *
 * The guard is `isOwnGlobalStreamForCurrentConversation`, not the broader `effectiveIsStreaming`
 * (found via proactive review, not a reviewer comment) — see `isOwnStreamForConversation` below
 * for why the raw flag is wrong here.
 */
function shouldApplyGlobalLocalMessages<T>(
  selectedAgent: { id: string } | null,
  globalIsInitialized: boolean,
  globalConversationId: string | null,
  globalInitialMessages: T[],
  prevGlobalInitialMessages: T[] | null,
  isOwnGlobalStreamForCurrentConversation: boolean,
): boolean {
  if (selectedAgent) return false;
  if (globalInitialMessages === prevGlobalInitialMessages) return false;
  if (!globalIsInitialized || !globalConversationId || isOwnGlobalStreamForCurrentConversation) return false;
  return true;
}

/**
 * Mirrors the agent-mode load-signal effect (~line 993-1017):
 * `if (selectedAgent && agentConversationId && !isOwnAgentStreamForCurrentConversation) setAgentMessages(...)`
 */
function shouldApplyAgentMessagesOnLoadSignal(
  selectedAgent: { id: string } | null,
  agentConversationId: string | null,
  isOwnAgentStreamForCurrentConversation: boolean,
): boolean {
  return Boolean(selectedAgent) && Boolean(agentConversationId) && !isOwnAgentStreamForCurrentConversation;
}

/**
 * Mirrors the refreshSignal effect (~line 758-772): remote events (reconnect,
 * cross-tab edit/delete) bump refreshSignal, and this surface reacts by
 * calling handlePullUpRefresh — but only in global mode, and (as of this PR)
 * only while this conversation isn't the one MY OWN stream is running against,
 * since handlePullUpRefresh overwrites local messages with no reconciliation
 * against an in-flight stream.
 */
function shouldHandlePullUpRefresh(
  selectedAgent: { id: string } | null,
  isInitialized: boolean,
  isOwnGlobalStreamForCurrentConversation: boolean,
): boolean {
  return !selectedAgent && isInitialized && !isOwnGlobalStreamForCurrentConversation;
}

/**
 * Mirrors `isOwnAgentStreamForCurrentConversation`/`isOwnGlobalStreamForCurrentConversation` in
 * GlobalAssistantView.tsx (identical shape to SidebarChatTab.tsx's `isOwnStreamForConversation`,
 * see that file for the full rationale): whether MY OWN local Chat is producing live content for
 * the conversation about to be loaded/refreshed. `agentStatus`/`globalStatus` belong to a
 * stable-id useChat instance that keeps reporting streaming across a conversation switch, for
 * the OLD conversation's still-in-flight request — comparing against the held stream-start id
 * (streamConvIdRef/globalStreamConvIdRef) is the only way to tell whether a currently-true
 * streaming flag actually belongs to the conversation now being loaded.
 */
function isOwnStreamForConversation(
  isStreamingNow: boolean,
  heldStreamConvId: string | null,
  targetConversationId: string | null,
): boolean {
  return isStreamingNow && heldStreamConvId === targetConversationId;
}

/**
 * Stateful simulator for the "ref-advances-only-on-apply" discipline — see
 * the identical helper and rationale in SidebarChatTab.test.tsx. Both the
 * agent load-signal effect and the refreshSignal effect in this file use a
 * "seen" ref alongside a streaming guard; a Codex review on this PR found the
 * first version advanced the ref before checking the guard, permanently
 * losing a load skipped mid-stream.
 */
function createRefAdvancesOnlyOnApplySimulator<X>() {
  let prevRef: X | null = null;
  return {
    step(x: X, guardPasses: boolean): boolean {
      if (x === prevRef) return false;
      if (!guardPasses) return false;
      prevRef = x;
      return true;
    },
  };
}

/**
 * Mirrors `resumeEnabled` — the `enabled` gate passed to useAppStateRecovery.
 *
 * Deliberately takes NO streaming argument, which is the whole point. The gate used to be a
 * render-time boolean folding in `!isStreaming`; iOS freezes JS the moment the app backgrounds,
 * so the value that gated the resume was whatever was true when the app went away — streaming —
 * and recovery was disabled in exactly the case it was written for. The gate must be a callback
 * (evaluated at fire time) considering only the conversation and user-editing; the streaming
 * decision belongs to resolveResumeAction.
 */
function resumeEnabled(currentConversationId: string | null, isAnyEditing: boolean): boolean {
  return currentConversationId !== null && !isAnyEditing;
}

/**
 * Mirrors the side effects of the `onResume` body, IN ORDER. The decision itself is NOT
 * mirrored — it calls the real `resolveResumeAction`, so this pins the wiring against the
 * real policy.
 *
 * Two invariants worth stating plainly, because both were bugs:
 *
 *  - On the native path we stop the local fetch and hand off to `tryRecover`, and there is NO
 *    DB-refresh fallback afterwards. tryRecover already refetches when the run finished while
 *    we were away. A fallback would only fire in the cases where a DB write is UNSAFE: the
 *    /active-streams probe failed (a stream may still be live, and the DB cannot contain an
 *    unpersisted reply), or the DB is behind local state (a send whose POST never landed).
 *
 *  - The web path never stops or probes: a live fetch survives a tab switch.
 *
 */
type ResumeEffect = 'stop' | 'try-recover' | 'refresh' | 'regenerate';

/**
 * One tryRecover outcome. `recovered` and `probeAnswered` are separate because "we recovered
 * nothing" is NOT the same claim as "the server told us there was nothing to recover".
 */
interface Attempt {
  recovered: boolean;
  probeAnswered: boolean;
}

function planResume({
  native,
  isStreaming,
  ownTurnInFlight = isStreaming,
  attempts = [{ recovered: true, probeAnswered: true }],
}: {
  native: boolean;
  /** The broad display/effective streaming flag — what resolveResumeAction sees. */
  isStreaming: boolean;
  /**
   * Whether a stream of OUR OWN was running for the conversation ON SCREEN. Distinct from
   * `isStreaming`, which stays true for a stream still running against a conversation the user has
   * since navigated away from (the useChat id is stable across a switch). Only this may gate a
   * regenerate — otherwise we would fire a generation for the turn the user is now LOOKING at
   * rather than the one that was interrupted.
   */
  ownTurnInFlight?: boolean;
  /** Successive tryRecover outcomes, one per probe the resume handler makes (up to 3). */
  attempts?: Attempt[];
}): ResumeEffect[] {
  const action = resolveResumeAction({ native, isStreaming });
  if (action === 'noop') return [];
  if (action === 'refresh') return ['refresh'];
  // The stop is local-only. It clears useChat state and — critically — ends the dead response
  // body, which releases the channel's `consuming` mark. Without that the rejoin's bootstrap
  // treats the stream as one we are already reading off the POST and skips attaching it.
  const effects: ResumeEffect[] = ['stop', 'try-recover'];
  let attempt: Attempt = attempts[0] ?? { recovered: false, probeAnswered: false };
  if (attempt.recovered) return effects;

  // An unanswered probe is not an answer. Re-probe (bounded) before concluding anything.
  for (let i = 1; !attempt.probeAnswered && i <= 2; i++) {
    effects.push('try-recover');
    attempt = attempts[i] ?? { recovered: false, probeAnswered: false };
    if (attempt.recovered) return effects;
  }

  // Regenerate only on an ANSWERED probe, and only for a turn of ours on this conversation.
  if (ownTurnInFlight && attempt.probeAnswered) effects.push('regenerate');
  return effects;
}

const mockAgent = { id: 'agent-123' };
const mockPreSendSnapshot = [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[];
const mockPostLoadSnapshot = [
  { id: 'msg-1', role: 'user', content: 'Hello' },
  { id: 'msg-2', role: 'assistant', content: 'Hi there' },
] as never[];

describe('GlobalAssistantView load-on-select effects', () => {
  describe('shouldApplyGlobalLocalMessages (global mode)', () => {
    it('given global mode, initialized, with a conversation id, a new snapshot, and not streaming, should apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(true);
    });

    it('given agent selected, should never apply (agent mode owns its own effect)', () => {
      expect(
        shouldApplyGlobalLocalMessages(mockAgent, true, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given not yet initialized, should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, false, 'conv-1', mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given no conversation id, should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, null, mockPostLoadSnapshot, null, false)
      ).toBe(false);
    });

    it('given the snapshot reference is unchanged, should NOT re-apply (no-op)', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, mockPostLoadSnapshot, false)
      ).toBe(false);
    });

    // Regression coverage for the clobber bug fixed in this PR.
    it('given effectiveIsStreaming=true (e.g. reload/switch mid-stream), should NOT apply', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPostLoadSnapshot, null, true)
      ).toBe(false);
    });

    // Regression coverage for the CodeRabbit-flagged bug: without the prevRef dedup, this
    // effect re-fires on every effectiveIsStreaming transition — including the moment an
    // ordinary send finishes — and `globalInitialMessages` is never refreshed for that case
    // (GlobalChatContext's onStreamComplete deliberately no-ops for an own fresh stream), so it
    // would reapply the stale PRE-SEND snapshot and wipe the just-completed reply straight back
    // out of the surface's own useChat state. The already-applied snapshot (prevRef === current
    // reference) must short-circuit at the dedup check regardless of how the streaming flag
    // transitions around it.
    it('given the snapshot was already applied and effectiveIsStreaming flips from true to false (stream just completed), should NOT re-apply the stale pre-send snapshot', () => {
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPreSendSnapshot, mockPreSendSnapshot, true)
      ).toBe(false);
      expect(
        shouldApplyGlobalLocalMessages(null, true, 'conv-1', mockPreSendSnapshot, mockPreSendSnapshot, false)
      ).toBe(false);
    });
  });

  describe('shouldApplyAgentMessagesOnLoadSignal (agent mode)', () => {
    it('given an agent selected, a conversation id, and not streaming, should apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, 'conv-1', false)).toBe(true);
    });

    it('given global mode (no agent selected), should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(null, 'conv-1', false)).toBe(false);
    });

    it('given no agent conversation id yet, should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, null, false)).toBe(false);
    });

    // Regression coverage: the load-signal indirection avoids re-firing on every streamed
    // token, but still fires unconditionally on a fresh mount — a reload mid-stream must
    // still be guarded, or it clobbers the in-progress bubble with the pre-reply snapshot.
    it('given effectiveIsStreaming=true (e.g. reload mid-stream), should NOT apply', () => {
      expect(shouldApplyAgentMessagesOnLoadSignal(mockAgent, 'conv-1', true)).toBe(false);
    });
  });

  describe('shouldHandlePullUpRefresh (refreshSignal effect)', () => {
    it('given global mode, initialized, and not streaming, should refresh', () => {
      expect(shouldHandlePullUpRefresh(null, true, false)).toBe(true);
    });

    it('given agent mode, should NOT refresh (agent mode has its own multiplayer wiring)', () => {
      expect(shouldHandlePullUpRefresh(mockAgent, true, false)).toBe(false);
    });

    it('given not yet initialized, should NOT refresh', () => {
      expect(shouldHandlePullUpRefresh(null, false, false)).toBe(false);
    });

    // Regression coverage: this effect previously had NO streaming guard at all (a gap
    // missed in the first version of this PR) — handlePullUpRefresh overwrites local
    // messages unconditionally, so running it mid-stream clobbers the in-progress reply.
    it('given effectiveIsStreaming=true, should NOT refresh (would clobber the live reply)', () => {
      expect(shouldHandlePullUpRefresh(null, true, true)).toBe(false);
    });
  });

  // ============================================
  // Ref-advances-only-on-apply regression tests (Codex review on PR #2061)
  //
  // Pins the multi-render sequence the single-call boolean tests above can't
  // express: a load/refresh skipped while streaming must be retried once
  // streaming ends, even though the underlying reference/signal never
  // changed again in the meantime. Applies identically to the agent
  // load-signal effect (~972) and the refreshSignal effect (~745) in this
  // file — both use a "seen" ref alongside the streaming guard.
  // ============================================

  describe('ref-advances-only-on-apply (retry-after-guard-lifts)', () => {
    it('given the guard blocks (streaming) then later passes with the SAME reference, should apply on the later render instead of being lost', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      const signal = 1;
      expect(sim.step(signal, false)).toBe(false); // streaming — blocked
      expect(sim.step(signal, true)).toBe(true); // streaming ended, same signal — must still apply
    });

    it('given the guard passes immediately, should apply once and not re-apply on a redundant re-render with the same reference', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      const signal = 1;
      expect(sim.step(signal, true)).toBe(true);
      expect(sim.step(signal, true)).toBe(false); // already applied — no-op
    });

    it('given a NEW signal arrives while still blocked, should keep deferring until the guard passes, then apply the latest', () => {
      const sim = createRefAdvancesOnlyOnApplySimulator<number>();
      expect(sim.step(1, false)).toBe(false); // streaming — blocked
      expect(sim.step(2, false)).toBe(false); // still streaming — newer signal also deferred
      expect(sim.step(2, true)).toBe(true); // guard lifts — applies the latest signal
    });
  });

  // ============================================
  // isOwnStreamForConversation regression tests
  //
  // Found via proactive review, not a reviewer comment: the load-on-select/refresh effects
  // originally guarded on the raw effectiveIsStreaming flag, which reflects a stable-id useChat
  // instance that keeps reporting "streaming" across a conversation/agent switch — for the OLD
  // conversation's still-in-flight request, not the one now being loaded. Switching
  // conversations mid-stream does not abort the running POST (documented at length elsewhere in
  // this file, e.g. the streamConvIdRef/globalStreamConvIdRef comments). Guarding on the raw
  // flag would strand a newly-selected, idle conversation behind an unrelated stream still
  // running in a conversation the user already left, until that unrelated stream finished.
  // ============================================

  describe('isOwnStreamForConversation (conversation-scoped streaming guard)', () => {
    it('given streaming and the held stream conversation matches the target, should report true (blocks — this IS the conversation being clobbered)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-A')).toBe(true);
    });

    it('given streaming but the held stream conversation is a DIFFERENT one than the target, should report false (does not block)', () => {
      expect(isOwnStreamForConversation(true, 'conv-A', 'conv-B')).toBe(false);
    });

    it('given not streaming at all, should report false regardless of conversation ids', () => {
      expect(isOwnStreamForConversation(false, 'conv-A', 'conv-A')).toBe(false);
    });

    it('given the exact regression scenario — sending in conv-A (or agent conversation A), then switching to idle conv-B while A keeps streaming — the load-on-select guard for conv-B must NOT be blocked', () => {
      const blocked = isOwnStreamForConversation(true, 'conv-A', 'conv-B');
      expect(blocked).toBe(false);
    });
  });

/**
 * Mirrors the rejoin branch of `tryRecover`: the live stream's messageId is used to evict the
 * half-streamed assistant bubble useChat is still holding, so the rejoined pending stream is not
 * deduped away.
 *
 * `Chat.stop()` "keeps the generated tokens", and a dropped fetch leaves them too — so `messages`
 * still holds an assistant message whose id IS the live stream's messageId (the server mints one
 * id and uses it for BOTH the UI message and the stream registry row). The rejoin re-adds that
 * same stream to the pending store, and the surfaces drop a pending stream whose messageId
 * already appears in `messages` (dedupRemoteStreams / ChatMessagesArea.visibleRemoteStreams).
 * Leave the stale bubble in place and the rejoined stream is filtered straight back out — not one
 * token renders, and the user stares at a frozen partial.
 */
function evictStalePartial<T extends { id: string }>(
  messages: T[],
  liveMessageId: string,
  serverPartsCount: number,
): T[] {
  // Only when the server has something to put in its place. `parts` from /active-streams is the
  // registry's DEBOUNCED checkpoint, so it is empty for a stream only a few parts old. Evicting
  // against an empty checkpoint and then failing the SSE join (the multi-instance case, where the
  // multicast lives in another process) removes the stream and leaves the user with NOTHING —
  // strictly worse than the frozen partial we started with.
  if (serverPartsCount === 0) return messages;
  return messages.filter((m) => m.id !== liveMessageId);
}

  describe('app-state resume recovery (useAppStateRecovery wiring)', () => {
    describe('resumeEnabled (the gate)', () => {
      it('given a conversation and no active editing, should enable recovery', () => {
        expect(resumeEnabled('conv-A', false)).toBe(true);
      });

      it('given no conversation, should NOT enable recovery (nothing to rejoin)', () => {
        expect(resumeEnabled(null, false)).toBe(false);
      });

      it('given the user is actively editing, should NOT enable recovery (would clobber their edit)', () => {
        expect(resumeEnabled('conv-A', true)).toBe(false);
      });

    });

    describe('planResume (the onResume body)', () => {
      it('given native mid-stream (the orphaned-stream bug), should stop the local fetch and hand off to tryRecover — and NOT read the DB', () => {
        // THE KEY INVARIANT. The reply is not persisted until the run completes, so a DB
        // snapshot taken while the stream is still generating contains no assistant message.
        // Writing it would wipe the in-progress bubble. tryRecover asks /active-streams first
        // and rejoins; the DB is never read while a run is live.
        expect(planResume({ native: true, isStreaming: true })).toEqual(['stop', 'try-recover']);
      });

      it('given native, should always stop BEFORE recovering', () => {
        // The stop is local-only, but it is what ends the dead response body and so releases
        // the channel's `consuming` mark. Without that, the rejoin's bootstrap classifies the
        // stream as one we are already reading off the POST body and skips attaching it — the
        // rejoin would silently do nothing.
        const plan = planResume({ native: true, isStreaming: true });
        expect(plan.indexOf('stop')).toBeLessThan(plan.indexOf('try-recover'));
      });

      it('given native and NOT streaming, should still stop and probe — the recovery is deterministic, not flag-gated', () => {
        // The local fetch is dead after backgrounding regardless of what useChat still
        // reports, so native always probes. /active-streams is the authoritative answer
        // on whether a stream is actually live; no client flag gates the rejoin.
        expect(planResume({ native: true, isStreaming: false })).toEqual(['stop', 'try-recover']);
      });

      it('given web with a live fetch, should do nothing — the fetch survives a tab switch and must not be clobbered', () => {
        expect(planResume({ native: false, isStreaming: true })).toEqual([]);
      });

      it('given web with no live fetch, should refresh only (no stop, no probe)', () => {
        expect(planResume({ native: false, isStreaming: false })).toEqual(['refresh']);
      });

      it('given native, a stream for a DIFFERENT conversation, and nothing to recover, should NOT regenerate', () => {
        // The broad flag stays true for a stream still running against a conversation the user has
        // navigated away from. Regenerating on it would fire a generation for the turn now on
        // screen rather than the interrupted one — a spurious reply, and a spurious charge, on an
        // untouched conversation.
        expect(
          planResume({
            native: true,
            isStreaming: true,
            ownTurnInFlight: false,
            attempts: [{ recovered: false, probeAnswered: true }],
          }),
        ).toEqual(['stop', 'try-recover']);
      });

      it('given native and the probe never ANSWERED, should re-probe and then NOT regenerate', () => {
        // Silence is not an answer. Every generation start calls takeOverConversationStreams, so a
        // regenerate issued while the run is in fact still live does not race it — it ABORTS it.
        // We would kill a healthy generation, re-run write tools it had already executed, bill the
        // discarded tokens, and strand its partial in the DB. Doing nothing is safe: the stop
        // released the `consuming` mark, so the socket-reconnect bootstrap picks a live run up.
        const plan = planResume({
          native: true,
          isStreaming: true,
          ownTurnInFlight: true,
          attempts: [
            { recovered: false, probeAnswered: false },
            { recovered: false, probeAnswered: false },
            { recovered: false, probeAnswered: false },
          ],
        });
        expect(plan).toEqual(['stop', 'try-recover', 'try-recover', 'try-recover']);
        expect(plan).not.toContain('regenerate');
      });

      it('given the probe answers only on a LATER attempt, should still regenerate — a cold radio must not strand the turn', () => {
        // The first request after a foreground is the one most likely to fail. Concluding from that
        // single silence would leave the user's prompt unanswered forever; re-probing lets the
        // radio come back and gives us a real answer to act on.
        expect(
          planResume({
            native: true,
            isStreaming: true,
            ownTurnInFlight: true,
            attempts: [
              { recovered: false, probeAnswered: false },
              { recovered: false, probeAnswered: true },
            ],
          }),
        ).toEqual(['stop', 'try-recover', 'try-recover', 'regenerate']);
      });

      it('given a re-probe finds the live stream, should rejoin and never regenerate', () => {
        expect(
          planResume({
            native: true,
            isStreaming: true,
            ownTurnInFlight: true,
            attempts: [
              { recovered: false, probeAnswered: false },
              { recovered: true, probeAnswered: true },
            ],
          }),
        ).toEqual(['stop', 'try-recover', 'try-recover']);
      });

      it('given native, a turn in flight, an ANSWERED probe, and NOTHING to recover, should regenerate — never a DB refresh', () => {
        // The stop above settles useChat at `ready` with no `error`, and useStreamRecovery only
        // fires on `status === 'error'` — so aborting the fetch destroys the very signal that
        // used to drive the fallback. Without regenerating here, a turn whose POST died on the
        // background transition (a radio drop right then is common) finds no stream, no reply and
        // no error, and the user's prompt sits unanswered forever.
        const plan = planResume({ native: true, isStreaming: true, attempts: [{ recovered: false, probeAnswered: true }] });
        expect(plan).toEqual(['stop', 'try-recover', 'regenerate']);
        expect(plan).not.toContain('refresh');
      });

      it('given native, NO turn in flight, and nothing to recover, should NOT regenerate', () => {
        // An ordinary resume on an idle conversation must never fire a spurious generation.
        expect(planResume({ native: true, isStreaming: false, attempts: [{ recovered: false, probeAnswered: true }] })).toEqual([
          'stop',
          'try-recover',
        ]);
      });
    });

    describe('evictStalePartial (why the rejoin renders at all)', () => {
      const liveId = 'srv-msg-1';
      const messages = [
        { id: 'u1', role: 'user' },
        { id: liveId, role: 'assistant' }, // the frozen half-streamed bubble
      ];

      it('given a rejoined live stream the server has parts for, should drop the local partial carrying that same messageId', () => {
        // Without this the pending stream the rejoin adds under `liveId` is deduped away,
        // because `liveId` is still present in `messages`. The bubble would never update.
        expect(evictStalePartial(messages, liveId, 12)).toEqual([{ id: 'u1', role: 'user' }]);
      });

      it('given the partial is evicted, the rejoined stream is no longer deduped out', () => {
        const remaining = evictStalePartial(messages, liveId, 12);
        const seen = new Set(remaining.map((m) => m.id));
        expect(seen.has(liveId)).toBe(false);
      });

      it('given the server checkpoint is EMPTY, should KEEP the local partial', () => {
        // The debounced checkpoint is empty for a stream only a few parts old. If we evicted here
        // and the SSE join then failed (multi-instance: the multicast lives in another process),
        // the bootstrap removes the stream and the user is left with nothing at all — worse than
        // the frozen partial. Keep what they had; the rejoin can still attach and take over.
        expect(evictStalePartial(messages, liveId, 0)).toEqual(messages);
      });

      it('given messages with no matching id, should leave them untouched', () => {
        expect(evictStalePartial(messages, 'some-other-id', 12)).toEqual(messages);
      });

      it('should only ever drop the ONE message the server named — never the user turn', () => {
        const out = evictStalePartial(messages, liveId, 12);
        expect(out.some((m) => m.role === 'user')).toBe(true);
      });
    });
  });
});
