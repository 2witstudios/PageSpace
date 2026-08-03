import type { UIMessage } from 'ai';

/**
 * Whether the conversation cache already holds a final row for `messageId`
 * whose terminal status is CONSISTENT with the completion event — the guard
 * that decides if the stream_complete reload fallback may be suppressed.
 *
 * "Consistent" (Codex P2, PR #2320): a locally committed row may be wrong
 * about how the stream actually ended. A local Stop commits the partial as
 * 'interrupted' (buildOwnStreamCommitOnFinish), but if the server-side abort
 * failed or landed too late, the generation ran on and durably persisted a
 * COMPLETE reply — suppressing the clean completion's reload would pin the
 * pane to the stale partial until reopened. So suppression requires the
 * cached status to agree with the event:
 *
 * - 'complete'  → final under any event (the sender drained the full body).
 * - 'interrupted' → final only when the event itself says aborted — the
 *   server confirms the stop; a NON-aborted completion contradicts the local
 *   row and must reload the authoritative reply.
 * - 'streaming' / absent → never final (an includeStreaming placeholder or a
 *   row of unknown provenance): let the reload fetch DB truth.
 *
 * Scans from the end — the completed message is almost always the newest row.
 */
export const cacheHasConsistentFinalMessage = (
  messages: readonly UIMessage[],
  messageId: string,
  aborted: boolean,
): boolean => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.id !== messageId) continue;
    const status = (m as UIMessage & { status?: string }).status;
    return status === 'complete' || (status === 'interrupted' && aborted);
  }
  return false;
};
