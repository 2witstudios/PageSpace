import type { PendingStreamsMap } from '@/stores/pendingStreams/applyAddStream';

/**
 * Which conversations must currently hold an editing-store streaming registration.
 *
 * THE CONTRACT BEING PROTECTED (repo CLAUDE.md): a streaming registration must be continuous
 * from the send CLICK through the stream's end, so nothing lands mid-stream and clobbers the
 * very content this epic exists to keep on screen.
 *
 * WHAT IT ACTUALLY GATES TODAY, enumerated because the previous wording here was wrong and was
 * being cited elsewhere as justification — and because my first correction of it was wrong too:
 *
 *   - SWR revalidation: NO. Every `isPaused()` call site asks `isAnyEditing()`, which
 *     deliberately matches only `'document' | 'form'`.
 *   - Auth-token refresh: NO. `shouldDeferAuthRefresh` (= `isAnyActive`) has no callers.
 *   - The global quick-create shortcut: YES, app-wide. `QuickCreatePalette` gates its key
 *     binding on `!isEditingActive()`, which IS `isAnyActive` and counts every session type.
 *   - The conversation's own UI: YES — `displayIsStreaming` and `isConversationBusy` derive
 *     from the same entries, which is why continuity from the send CLICK still matters.
 *
 * The SWR/auth wiring exists and is one call site away from being real. The description should
 * match the code until then.
 *
 * WHY BOTH INPUTS.
 *
 * - `pendingSends` covers the submitted window: send clicked, request not yet answered, no
 *   stream entry anywhere. Nothing else knows this window exists.
 * - `streams` covers everything from the first chunk onward — INCLUDING the cases useChat's
 *   status could never see: a stream bootstrapped after a refresh (useChat sits at idle, so the
 *   surface reported "not streaming" while a replayed stream was live on screen), a remote
 *   user's stream, and a cross-instance stream. This is why the old registration ORed flags from
 *   five different mount sites and still left that gap open.
 *
 * The two overlap by design at the handoff instant, and the result is a SET of conversations —
 * so they collapse to one registration rather than two. `useSendHandoff` ends its pendingSend
 * exactly when the store entry appears, which is what makes the handoff seamless in both
 * directions.
 *
 * WHY KEYED BY CONVERSATION, NOT BY SURFACE.
 *
 * GlobalAssistantView and SidebarChatTab are co-mounted everywhere after one dashboard visit,
 * and both show the same conversation. Five surface-keyed registrations meant N sessions for one
 * stream, each with its own lifecycle to get wrong. One conversation-keyed session per live
 * conversation is the honest count of what is actually streaming.
 *
 * Returns a SORTED array: the caller diffs this against its previous result to decide what to
 * start and end, so an unstable order would make an unchanged set look changed.
 */
export const deriveStreamingRegistrations = ({
  pendingSends,
  streams,
}: {
  pendingSends: ReadonlySet<string>;
  streams: PendingStreamsMap;
}): string[] => {
  const conversationIds = new Set<string>(pendingSends);
  for (const stream of streams.values()) {
    conversationIds.add(stream.conversationId);
  }
  return Array.from(conversationIds).sort();
};
