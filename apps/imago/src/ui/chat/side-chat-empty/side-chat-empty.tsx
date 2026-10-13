'use client';

import type { ReactNode } from 'react';
import { dispatch, transactions } from '@/ui/store/transactions';

/** The two suggestions an empty side chat offers (C-Files-AiChat, Imago column). */
export const SIDE_CHAT_SUGGESTIONS: readonly string[] = ['Summarize this conversation', 'What are you working on?'];

/** The empty side chat's invitation: what the column is, and how to get Imago back. */
export const sideChatLine = (agentName: string): string =>
  `Side chat with ${agentName} — handy when the main chat is busy. Switch to Imago from the name above.`;

const chipClass =
  'inline-flex h-7 cursor-pointer items-center rounded-round border border-hairline bg-fill px-3 text-xs text-ink-muted hover:text-ink';

/**
 * The side chat with an agent before its first message: the invitation line and the suggestion
 * chips. A chip seeds the composer with its text; it does not send.
 */
export function SideChatEmpty({ agentName }: { readonly agentName: string }): ReactNode {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm text-ink-muted">
      <p className="m-0">{sideChatLine(agentName)}</p>
      <div className="flex flex-wrap gap-2">
        {SIDE_CHAT_SUGGESTIONS.map((text) => (
          <button key={text} type="button" className={chipClass} onClick={() => dispatch(transactions.setChatDraft, text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
