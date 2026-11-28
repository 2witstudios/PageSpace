import type { ReactNode, Ref, UIEventHandler } from 'react';
import type { ChatDensity } from '../../frame/stage/stage';
import { paneHeaderClass } from '../../frame/pane/pane-class';
import { headControlClass } from '../../frame/controls/controls-class';
import { Icon } from '../../components/icon/icon';
import type { ChatMessage } from '../chat-model/chat';
import { renderChatMessage } from '../chat-message/chat-message.render';
import {
  chatChipClass,
  chatEmptyClass,
  chatNoticeClass,
  chatPaneClass,
  chatScrollClass,
  chatThreadClass,
} from './chat-pane-class';

export type ChatPaneRenderProps = {
  readonly density: ChatDensity;
  /** The agent the conversation is with. */
  readonly agentName: string;
  /** The agent picker (IMC-2.1). */
  readonly picker: ReactNode;
  /** The context chip: the bare name of what Imago answers about; none on the chat home. */
  readonly chip?: string | null;
  /** History in the head; pressed while the History view shows. */
  readonly onHistory: () => void;
  readonly historyOpen?: boolean;
  readonly onNewChat: () => void;
  /** Show sidebar, at the start of the head while the pane is closed. */
  readonly leading?: ReactNode;
  /** The head's closing control: Collapse Imago or Close Imago. */
  readonly trailing?: ReactNode;
  readonly source?: ReactNode;
  /** What the agent answers against: the drive, the section, or the open object. */
  readonly contextLabel: string;
  /** Oldest first; undefined while the conversation loads. */
  readonly messages: readonly ChatMessage[] | undefined;
  /** The reply still arriving, if any. */
  readonly streamingMessageId: string | null;
  /** What went wrong, said above the composer. */
  readonly notice: string | null;
  readonly citationDriveId: string | null;
  readonly composer: ReactNode;
  /** Reused complete chat surface, hosted in this one persistent pane. */
  readonly content?: ReactNode;
  /** The scroller, for the container to keep the newest message in view. */
  readonly scrollRef?: Ref<HTMLDivElement>;
  readonly onScroll?: UIEventHandler<HTMLDivElement>;
};

/** The context chip: what Imago answers about, the bare page or screen name (C-Files-Doc head). */
const renderChip = (chip: string | null | undefined): ReactNode =>
  chip === null || chip === undefined || chip === '' ? null : <span className={chatChipClass}>{chip}</span>;

/**
 * Imago's head (SPEC v3 "Assistant column", v3.1, v3.2): [Show sidebar] · the agent picker ·
 * the context chip · History · New chat · Collapse Imago or Close Imago.
 */
const renderHead = (props: ChatPaneRenderProps): ReactNode => (
  <header className={paneHeaderClass}>
    {props.leading ?? null}
    {props.picker}
    {renderChip(props.chip)}
    <span className="flex-1" />
    {props.source ?? null}
    <button
      type="button"
      className={headControlClass}
      aria-label="Chat history"
      title="History"
      aria-pressed={props.historyOpen ?? false}
      onClick={props.onHistory}
    >
      <Icon name="history" size={15} />
    </button>
    <button type="button" className={headControlClass} aria-label="New chat" title="New chat" onClick={props.onNewChat}>
      <Icon name="newChat" size={15} />
    </button>
    {props.trailing ?? null}
  </header>
);

/**
 * The chat column: a header picking the agent and naming what it is
 * answering against, the thread, and the floating composer. Roomy over a drive or a
 * section; dense beside an open object, where the header names the object.
 */
export function renderChatPane(props: ChatPaneRenderProps): ReactNode {
  const { density, agentName, messages, streamingMessageId, notice, citationDriveId, composer, scrollRef, onScroll } =
    props;
  return (
    <aside className={chatPaneClass(density)} aria-label="Imago" data-density={density}>
      {renderHead(props)}
      {props.content !== undefined ? <>{notice === null ? null : <p role="alert" className={chatNoticeClass}>{notice}</p>}{props.content}</> : <>
      <div ref={scrollRef} onScroll={onScroll} className={chatScrollClass}>
        <ol className={chatThreadClass(density)} aria-busy={messages === undefined ? true : undefined}>
          {messages === undefined ? null : messages.length === 0 ? (
            <li className={chatEmptyClass}>{`Ask ${agentName} anything. Open a page only when the work needs it.`}</li>
          ) : (
            messages.map((message) =>
              renderChatMessage({
                message,
                density,
                assistantName: agentName,
                streaming: message.id === streamingMessageId,
                citationDriveId,
              }),
            )
          )}
          {notice === null ? null : (
            <li role="alert" className={chatNoticeClass}>
              {notice}
            </li>
          )}
        </ol>
      </div>
      {composer}
      </>}
    </aside>
  );
}
