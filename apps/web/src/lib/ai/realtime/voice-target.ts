/**
 * What a voice session is bound TO, and when that binding has actually changed.
 *
 * Voice is a second transport onto a conversation that already exists, so a
 * session is addressed the way every other chat surface addresses one: by
 * conversation, plus the context that conversation belongs to. The target is
 * NOT a panel, a route, or a UI mode — those come and go under a live call.
 *
 * The distinction this module exists to draw is the one the whole lifecycle
 * turns on: NAVIGATING is not REBINDING. Walking to another page changes where
 * the user is standing (`locationContext`, which the tools read) and must leave
 * the call alone; deliberately choosing a different agent in the switcher
 * changes who is being talked to, and that is a different conversation with a
 * different history — it cannot be served by the session already running.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

/**
 * Mirrors the shape the rest of the app already uses for a conversation
 * (`conversationState.createAndSetActiveConversation`, `useConversationSubscription`)
 * rather than inventing a voice-only address. A second addressing scheme would
 * be the beginning of a second substrate.
 */
export type VoiceTarget = {
  /**
   * The thread the spoken turns are written into. Required: an unbound call
   * would still connect and still meter, but its transcript would have nowhere
   * to land — and the transcript is the artifact of record, not the audio.
   */
  readonly conversationId: string;
  readonly type: 'global' | 'page' | 'drive';
  /** The page or drive the conversation hangs off, when it hangs off one. */
  readonly contextId?: string;
  /** Set when the target is a page agent rather than the global assistant. */
  readonly agentPageId?: string;
};

/**
 * Two targets are the same binding when every addressing field matches.
 *
 * `conversationId` alone is deliberately NOT the test. It is very nearly
 * sufficient — but the agent switcher can move a session to a different agent
 * while the app is still resolving a conversation id, and treating those as one
 * binding would silently keep talking to the previous agent through a session
 * the user believes they switched.
 */
export const sameVoiceTarget = (
  a: VoiceTarget | null,
  b: VoiceTarget | null,
): boolean => {
  if (a === null || b === null) return a === b;
  return (
    a.conversationId === b.conversationId &&
    a.type === b.type &&
    a.contextId === b.contextId &&
    a.agentPageId === b.agentPageId
  );
};

/**
 * Whether a request to talk to `next` has to tear down the call bound to
 * `current`.
 *
 * `'none'` means the caller asked for the session it already has — pressing the
 * voice button twice, or a re-render handing the same target back — and the
 * live call must survive that, because the alternative is a UI event silently
 * restarting a conversation mid-sentence.
 */
export type BindDecision = 'start' | 'rebind' | 'none';

export const decideBind = (
  current: VoiceTarget | null,
  next: VoiceTarget,
): BindDecision => {
  if (current === null) return 'start';
  return sameVoiceTarget(current, next) ? 'none' : 'rebind';
};
