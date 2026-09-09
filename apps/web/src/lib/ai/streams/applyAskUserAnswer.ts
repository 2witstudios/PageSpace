import type { UIMessage } from 'ai';
import { isPausingToolPartType } from '@/lib/ai/tools/pausing-tools';

type AskUserPart = { type: string; toolCallId?: string; state?: string; output?: unknown };

const patchAskUserPart = <T extends UIMessage>(
  messages: T[],
  messageId: string,
  toolCallId: string,
  patch: (part: AskUserPart) => AskUserPart,
): T[] => {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return messages;

  const message = messages[idx];
  const parts = (message.parts ?? []) as AskUserPart[];
  const partIdx = parts.findIndex((p) => isPausingToolPartType(p.type) && p.toolCallId === toolCallId);
  if (partIdx < 0) return messages;

  const nextParts = parts.slice();
  nextParts[partIdx] = patch(parts[partIdx]);

  const next = messages.slice();
  next[idx] = { ...message, parts: nextParts } as T;
  return next;
};

export interface AskUserAnswerPayload {
  messageId: string;
  toolCallId: string;
  /** The tool's client result: an ask_user answer, or a request_env_approval outcome. */
  output: unknown;
}

/**
 * Optimistically patches one ask_user tool part to output-available with the
 * given output. Returns the input reference unchanged when the messageId or
 * toolCallId is not present. Pure — never mutates input.
 */
export const applyAskUserAnswer = <T extends UIMessage>(messages: T[], payload: AskUserAnswerPayload): T[] =>
  patchAskUserPart(messages, payload.messageId, payload.toolCallId, (part) => ({
    ...part,
    state: 'output-available',
    output: payload.output,
  }));

export interface AskUserAnswerRevertPayload {
  messageId: string;
  toolCallId: string;
}

/**
 * Reverts an optimistic answer back to input-available (a rejected resume
 * POST). Drops `output` entirely rather than setting it undefined, matching
 * the shape of a part that was never answered.
 */
export const revertAskUserAnswer = <T extends UIMessage>(
  messages: T[],
  payload: AskUserAnswerRevertPayload,
): T[] =>
  patchAskUserPart(messages, payload.messageId, payload.toolCallId, (part) => {
    const { output: _output, ...rest } = part;
    return { ...rest, state: 'input-available' };
  });
