import type { CreateUIMessage, FileUIPart, UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

export interface BuildUserMessageInput {
  /** Client-minted id. Only the parts-form send honors this (see PR 3 board, Assumption B) — never send via the `{text, files}` shorthand. */
  id: string;
  text?: string;
  /** Pre-converted file parts — callers running `convertFileListToFileUIParts` keep this function pure and synchronous. */
  files?: FileUIPart[];
  metadata?: UIMessage['metadata'];
}

/**
 * Builds a parts-form `CreateUIMessage` payload for `Chat.sendMessage`, the
 * only send shape that preserves a caller-supplied id end to end. Pure —
 * never mutates `files`.
 */
export const buildUserMessage = ({
  id,
  text,
  files,
  metadata,
}: BuildUserMessageInput): CreateUIMessage<UIMessage> => {
  const parts: UIMessagePart[] = [
    ...(files ?? []),
    ...(text != null ? [{ type: 'text' as const, text }] : []),
  ];
  return {
    id,
    role: 'user',
    parts,
    ...(metadata !== undefined ? { metadata } : {}),
  };
};
