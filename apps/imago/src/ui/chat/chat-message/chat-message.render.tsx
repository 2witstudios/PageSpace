import type { ReactNode } from 'react';
import type { ChatDensity } from '../../frame/stage/stage';
import type { ChatMessage } from '../chat-model/chat';
import { ChatProse } from '../chat-prose/chat-prose';
import { messageBlocks } from '../chat-text/chat-text';
import { renderToolSummary } from '../tool-summary/tool-summary.render';
import { chatMessageClass } from './chat-message-class';

export type ChatMessageRenderProps = {
  readonly message: ChatMessage;
  readonly density: ChatDensity;
  /** Who replies, for the sentence assistive technology reads before a reply. */
  readonly assistantName: string;
  /** This reply is still arriving. */
  readonly streaming: boolean;
  /** The drive a cited page opens in. */
  readonly citationDriveId: string | null;
};

/**
 * One message in the thread: the viewer's as an accent-soft card, the
 * assistant's as prose with no bubble, each tool call it made a summary line
 * where it happened.
 */
export function renderChatMessage(props: ChatMessageRenderProps): ReactNode {
  const { message, density, assistantName, streaming, citationDriveId } = props;
  const author = message.role === 'user' ? 'user' : 'assistant';
  return (
    <li
      key={message.id}
      className={chatMessageClass(author, density)}
      data-role={author}
      aria-busy={streaming ? true : undefined}
    >
      <span className="sr-only">{author === 'user' ? 'You said: ' : `${assistantName} said: `}</span>
      {messageBlocks(message.parts).map((block, index) =>
        block.kind === 'tool' ? (
          renderToolSummary(block.tool)
        ) : (
          <ChatProse key={`text-${index}`} text={block.text} streaming={streaming} citationDriveId={citationDriveId} />
        ),
      )}
    </li>
  );
}
