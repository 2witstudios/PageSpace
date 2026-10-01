import type { UIMessage } from 'ai';

/**
 * Optimistic patch for a tool-approval answer — the approval twin of
 * `applyAskUserAnswer.ts`. A paused tool part (`approval-requested`) becomes
 * `approval-responded` carrying the user's answer the instant they click, so
 * every surface showing the conversation disables the card together; the resume
 * POST's own commit reconciles it once the server has persisted the outcome.
 *
 * Any `tool-*` part can be paused, so this matches by toolCallId alone (unlike
 * the ask_user patch, which also pins the part type).
 *
 * STATE-CONDITIONAL, both ways. The optimistic flip only applies to a part still
 * in `approval-requested`, and the revert only undoes a part still in
 * `approval-responded`. Anything else means newer server truth already landed —
 * a realtime event moved the part to `output-*`, or another tab answered first —
 * and an optimistic patch, a 409 revert, or a replayed pending mutation must
 * never write an older guess over it.
 *
 * Pure — never mutates input; returns the input reference when nothing matched.
 */

type ApprovalPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
};

export interface ToolApprovalResponsePayload {
  messageId: string;
  toolCallId: string;
  approval: { id: string; approved: boolean; reason?: string };
}

export interface ToolApprovalRevertPayload {
  messageId: string;
  toolCallId: string;
  /** The answer this tab applied optimistically — the revert only undoes a part still carrying it. */
  approval: { id: string; approved: boolean; reason?: string };
}

const patchToolPart = <T extends UIMessage>(
  messages: T[],
  messageId: string,
  toolCallId: string,
  /** The part state this patch is allowed to act on; any other state is newer truth and is left alone. */
  fromState: string,
  patch: (part: ApprovalPart) => ApprovalPart,
  /** Extra guard on the matched part; false leaves it alone. */
  matches: (part: ApprovalPart) => boolean = () => true,
): T[] => {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return messages;

  const message = messages[idx];
  const parts = (message.parts ?? []) as ApprovalPart[];
  const partIdx = parts.findIndex((p) => p.type.startsWith('tool-') && p.toolCallId === toolCallId);
  if (partIdx < 0 || parts[partIdx].state !== fromState || !matches(parts[partIdx])) return messages;

  const nextParts = parts.slice();
  nextParts[partIdx] = patch(parts[partIdx]);

  const next = messages.slice();
  next[idx] = { ...message, parts: nextParts } as T;
  return next;
};

/** Flip a paused part to approval-responded with the given answer. */
export const applyToolApprovalResponse = <T extends UIMessage>(
  messages: T[],
  payload: ToolApprovalResponsePayload,
): T[] =>
  patchToolPart(messages, payload.messageId, payload.toolCallId, 'approval-requested', (part) => ({
    ...part,
    state: 'approval-responded',
    approval: payload.approval,
  }));

const sameAnswer = (
  actual: ApprovalPart['approval'],
  expected: ToolApprovalRevertPayload['approval'],
): boolean =>
  actual?.id === expected.id && actual.approved === expected.approved && (actual.reason ?? undefined) === (expected.reason ?? undefined);

/**
 * Revert an optimistic answer (the resume POST was rejected) back to
 * approval-requested, keeping only the approval id the server issued. Only a
 * part still in `approval-responded` AND still carrying the answer this tab
 * applied is reverted: a 409 usually means another tab answered first, and its
 * server-saved answer may already have landed here over ours — reopening the
 * card on top of it would offer buttons for a decided call. (An identical
 * answer from another tab is indistinguishable by value and is reverted; the
 * realtime update for the executed call settles it, and a click meanwhile is
 * refused by the server.)
 */
export const revertToolApprovalResponse = <T extends UIMessage>(
  messages: T[],
  payload: ToolApprovalRevertPayload,
): T[] =>
  patchToolPart(
    messages,
    payload.messageId,
    payload.toolCallId,
    'approval-responded',
    (part) => ({
      ...part,
      state: 'approval-requested',
      ...(part.approval ? { approval: { id: part.approval.id } } : {}),
    }),
    (part) => sameAnswer(part.approval, payload.approval),
  );
