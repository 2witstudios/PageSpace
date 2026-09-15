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
}

const patchToolPart = <T extends UIMessage>(
  messages: T[],
  messageId: string,
  toolCallId: string,
  patch: (part: ApprovalPart) => ApprovalPart,
): T[] => {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return messages;

  const message = messages[idx];
  const parts = (message.parts ?? []) as ApprovalPart[];
  const partIdx = parts.findIndex((p) => p.type.startsWith('tool-') && p.toolCallId === toolCallId);
  if (partIdx < 0) return messages;

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
  patchToolPart(messages, payload.messageId, payload.toolCallId, (part) => ({
    ...part,
    state: 'approval-responded',
    approval: payload.approval,
  }));

/**
 * Revert an optimistic answer (the resume POST was rejected) back to
 * approval-requested, keeping only the approval id the server issued.
 */
export const revertToolApprovalResponse = <T extends UIMessage>(
  messages: T[],
  payload: ToolApprovalRevertPayload,
): T[] =>
  patchToolPart(messages, payload.messageId, payload.toolCallId, (part) => ({
    ...part,
    state: 'approval-requested',
    ...(part.approval ? { approval: { id: part.approval.id } } : {}),
  }));
