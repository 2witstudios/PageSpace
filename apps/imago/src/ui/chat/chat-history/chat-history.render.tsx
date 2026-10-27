import { PanelLeftClose, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { renderButton } from '../../components/button/button.render';
import { renderListGroup } from '../../components/list-group/list-group.render';
import { listBodyClass, listPaneClass } from '../../frame/list-pane/list-pane-class';
import { paneControlClass } from '../../frame/pane/pane-class';
import { renderPaneHeader } from '../../frame/pane/pane-header';
import { chatHistoryFilterClass, chatHistoryNoteClass, chatHistoryRowClass, chatHistoryTimeClass, chatHistoryTitleClass } from './chat-history-class';
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
  /** "Search chats": filters the loaded rows by title. */
  readonly filter: string;
  readonly onFilter: (value: string) => void;
  /** A row's time beside its title: now, 9:40, Sun, Oct 8. */
  readonly timeOf: (iso: string) => string;
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
              aria-current={selected ? 'page' : undefined}
              onClick={() => props.selectConversation(conversation.id)}
            >
              <span className={chatHistoryTitleClass}>{conversation.title}</span>
              <span className={chatHistoryTimeClass}>{props.timeOf(conversation.updatedAt)}</span>
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
  if (list.days.length === 0) return renderNote(props.filter.trim() === '' ? 'No chats yet.' : 'No chats match.');
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
 * current. Like every left pane it collapses with Close sidebar (SPEC v3.2).
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
            <button type="button" aria-label="Close sidebar" title="Close sidebar" className={paneControlClass} onClick={props.hide}>
              <PanelLeftClose {...icon} />
            </button>
          </>
        ),
      })}
      <div className={listBodyClass}>
        <label className={chatHistoryFilterClass}>
          <Search {...icon} />
          <input
            aria-label="Search chats"
            placeholder="Search chats"
            value={props.filter}
            onChange={(event) => props.onFilter(event.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        {renderRows(props)}
      </div>
    </section>
  );
}
