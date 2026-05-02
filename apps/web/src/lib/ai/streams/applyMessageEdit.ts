import type { UIMessage } from 'ai';

export interface MessageEditPayload {
  messageId: string;
  parts: UIMessage['parts'];
  editedAt: Date;
}

type EditableMessage = UIMessage & { editedAt?: Date | null };

/**
 * Apply a remote edit broadcast to a local messages array. Returns a new array
 * with the matched message's `parts` replaced and `editedAt` set. Returns the
 * input reference unchanged when the messageId is not present. Pure — never
 * mutates input.
 */
export const applyMessageEdit = <T extends EditableMessage>(
  messages: T[],
  payload: MessageEditPayload,
): T[] => {
  const idx = messages.findIndex((m) => m.id === payload.messageId);
  if (idx < 0) return messages;
  const next = messages.slice();
  next[idx] = { ...messages[idx], parts: payload.parts, editedAt: payload.editedAt } as T;
  return next;
};
