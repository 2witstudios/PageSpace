import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import { renderListGroup } from '../../components/list-group/list-group.render';
import { listBodyClass, listPaneClass } from '../../frame/list-pane/list-pane-class';
import { paneControlClass } from '../../frame/pane/pane-class';
import { renderPaneHeader } from '../../frame/pane/pane-header';
import { chatHistoryNoteClass, chatHistoryRowClass, chatHistoryTitleClass } from './chat-history-class';
import type { HistoryDay } from './history-days';

/** The history's rows, or why there are none. */
export type ChatHistoryList =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly days: readonly HistoryDay[];
      /** The route has older chats than those loaded. */
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
    };

export type ChatHistoryRenderProps = {
  readonly list: ChatHistoryList;
  /** The chat the pane shows; null while a new chat is open. */
  readonly activeId: string | null;
  /** Void action: shows a past chat in the pane. */
  readonly selectConversation: (conversationId: string) => void;
  /** Void action: opens an empty thread. */
  readonly startNewChat: () => void;
  /** Void action: hides the history so the chat takes the frame. */
  readonly hide: () => void;
  readonly loadMore: () => void;
  readonly retry: () => void;
};

/** lucide at stroke 1.5 / 16px (DEC-8); the control carries the name. */
const icon = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

const renderNote = (text: string, role?: 'status' | 'alert'): ReactNode => (
  <p role={role} className={chatHistoryNoteClass}>
    {text}
  </p>
);

const renderDay = ({ label, conversations }: HistoryDay, props: ChatHistoryRenderProps): ReactNode => (
  <div key={label}>
    {renderListGroup({
      label,
      children: conversations.map((conversation) => {
        const selected = conversation.id === props.activeId;
        return (
          <li key={conversation.id}>
            <button
              type="button"
              className={chatHistoryRowClass(selected)}
              aria-current={selected ? 'true' : undefined}
              onClick={() => props.selectConversation(conversation.id)}
            >
              <span className={chatHistoryTitleClass}>{conversation.title}</span>
            </button>
          </li>
        );
      }),
    })}
  </div>
);

const renderRows = (props: ChatHistoryRenderProps): ReactNode => {
  const { list } = props;
  if (list.status === 'loading') return renderNote('Loading chats…', 'status');
  if (list.status === 'error') {
    return (
      <>
        {renderNote('Could not load chats.', 'alert')}
        {renderButton({ variant: 'ghost', onClick: props.retry, children: 'Try again' })}
      </>
    );
  }
  if (list.days.length === 0) return renderNote('No chats yet.');
  return (
    <>
      {list.days.map((day) => renderDay(day, props))}
      {list.hasMore
        ? renderButton({ variant: 'ghost', onClick: props.loadMore, disabled: list.loadingMore, children: 'Show older chats' })
        : null}
    </>
  );
};

/**
 * The chat's own list: the current agent's past chats, filed under the day
 * they were last active. A row switches the one chat beside every stage
 * rather than navigating, so it is a button and the open chat marks itself
 * current. Nowhere to step back to from the chat, so × hides the history
 * rather than closing a stage (myimago ADR 0029 decision 2).
 */
export function renderChatHistory(props: ChatHistoryRenderProps): ReactNode {
  return (
    <section className={listPaneClass('list')} aria-label="Chat history">
      {renderPaneHeader({
        title: 'Chats',
        actions: (
          <>
            <button type="button" aria-label="New chat" className={paneControlClass} onClick={props.startNewChat}>
              <Plus {...icon} />
            </button>
            <button type="button" aria-label="Hide Chat history" className={paneControlClass} onClick={props.hide}>
              <X {...icon} />
            </button>
          </>
        ),
      })}
      <div className={listBodyClass}>{renderRows(props)}</div>
    </section>
  );
}
