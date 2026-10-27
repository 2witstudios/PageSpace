import { create } from 'zustand';

/**
 * Shared in-flight set for ask_user answers: one toolCallId is added the
 * instant its submit begins (synchronous, before any await) so every
 * co-mounted surface showing the same conversation disables the card in the
 * same store update. `claimAnswering`'s return value IS the mutex for M4/M6
 * (double-click, or two surfaces racing to answer the same question): only
 * the caller that actually flips the id from absent to present gets `true`
 * back and proceeds to submit; a loser sees `false` and must no-op — the
 * component-level `answerableToolCallIds` check alone is NOT enough, because
 * two callers can both read it before either one's store update lands.
 */
interface AskUserAnsweringState {
  answeringToolCallIds: ReadonlySet<string>;
  /** Attempts to claim toolCallId. Returns true iff THIS call performed the claim. */
  claimAnswering: (toolCallId: string) => boolean;
  clearAnswering: (toolCallId: string) => void;
}

export const useAskUserAnsweringStore = create<AskUserAnsweringState>((set, get) => ({
  answeringToolCallIds: new Set<string>(),
  claimAnswering: (toolCallId) => {
    if (get().answeringToolCallIds.has(toolCallId)) return false;
    const next = new Set(get().answeringToolCallIds);
    next.add(toolCallId);
    set({ answeringToolCallIds: next });
    return true;
  },
  clearAnswering: (toolCallId) => {
    if (!get().answeringToolCallIds.has(toolCallId)) return;
    const next = new Set(get().answeringToolCallIds);
    next.delete(toolCallId);
    set({ answeringToolCallIds: next });
  },
}));
