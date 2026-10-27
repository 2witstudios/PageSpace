import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '../../cn';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { listGroupLabelClass } from '../../components/list-group/list-group-class';
import { renderUnreadCount } from '../../components/unread-count/unread-count.render';
import { renderPaneHeader } from '../../frame/pane/pane-header';
import { listBodyClass, listPaneClass } from '../../frame/list-pane/list-pane-class';
import type { ListPane } from '../../frame/stage/stage';
import { messageNameClass, messagesNoteClass } from '../messages-pane/messages-pane-class';
import { renderNewMessageLink } from '../messages-pane/messages-pane.render';
import type { MessageablePerson } from './dm-index-model';

const segment = encodeURIComponent;

/** One conversation row, ready to draw. `when` and `preview` are already text. */
export type DmRowView = {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
  readonly when: string;
  readonly preview: string | null;
  readonly unreadCount: number;
  /** The conversation open as the object. */
  readonly selected: boolean;
};

/** The conversations list: loading, failed, or its rows (already narrowed by the filter). */
export type DmIndexState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly rows: readonly DmRowView[] };

export type DmIndexRenderProps = {
  /** `list` is the 300px stage-2 pane. */
  readonly variant: Exclude<ListPane, 'closed'>;
  /** Close sidebar, drawn by the shell's controls. */
  readonly close: ReactNode;
  readonly state: DmIndexState;
  /** The filter as typed; an empty filter shows every conversation. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
};

/** The people ground's list: loading, failed, none, or the people themselves. */
export type DmGroundState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly people: readonly MessageablePerson[] };

const notes = {
  loading: 'Loading direct messages…',
  error: 'Could not load direct messages.',
  empty: 'No direct messages yet.',
  noMatch: 'No conversations match this filter.',
} as const;

const peopleNotes = {
  loading: 'Loading people…',
  error: 'Could not load people.',
  empty: 'No one to message yet.',
} as const;

/* A row is the other person: a 36px face, the name and @username, the time,
   then the last message and its unread count. The open conversation draws
   no count, as the channel list does; a row holding something unread lifts. */
const rowClass = (selected: boolean, unread: boolean): string =>
  cn(
    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline',
    selected ? 'bg-accent-soft text-ink' : unread ? 'font-medium text-ink hover:bg-surface-overlay' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink',
  );

const renderRow = (row: DmRowView): ReactNode => {
  const unread = row.unreadCount > 0;
  return (
    <li key={row.id}>
      <Link
        href={`/dm/${segment(row.id)}`}
        prefetch
        className={rowClass(row.selected, unread)}
        aria-current={row.selected ? 'page' : undefined}
        aria-label={unread ? `${row.name}, ${row.unreadCount} unread` : row.name}
      >
        {renderAvatar({ name: row.name, size: 'md', src: row.avatarUrl ?? undefined })}
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={messageNameClass}>{row.name}</span>
            {row.username === null ? null : (
              <span className="flex-none whitespace-nowrap text-xs text-ink-faint">{`@${row.username}`}</span>
            )}
            <span className="flex-none whitespace-nowrap text-xs text-ink-faint">{row.when}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{row.preview ?? ''}</span>
            {row.selected ? null : renderUnreadCount({ count: row.unreadCount })}
          </span>
        </span>
      </Link>
    </li>
  );
};

/** The Direct messages pane: its head, the filter and the conversations, or why there are none. */
export function renderDmIndexPane(props: DmIndexRenderProps): ReactNode {
  const { variant, close, state, query, onQueryChange } = props;
  const filtering = query.trim() !== '';
  let body: ReactNode;
  if (state.status === 'loading') body = <p role="status" className={messagesNoteClass}>{notes.loading}</p>;
  else if (state.status === 'error')
    body = (
      <>
        <p role="alert" className={messagesNoteClass}>{notes.error}</p>
        {renderButton({ variant: 'ghost', onClick: state.retry, children: 'Try again' })}
      </>
    );
  else if (state.rows.length === 0) body = <p className={messagesNoteClass}>{filtering ? notes.noMatch : notes.empty}</p>;
  else body = <ul className="flex flex-col gap-px">{state.rows.map(renderRow)}</ul>;

  return (
    <section className={listPaneClass(variant)} aria-label="Direct messages">
      {renderPaneHeader({
        title: 'Direct messages',
        actions: (
          <span className="flex flex-none items-center gap-1">
            {renderNewMessageLink()}
            {close}
          </span>
        ),
      })}
      <div className={listBodyClass}>
        <label className="mx-1 mb-2 flex h-8 items-center gap-2 rounded-lg bg-surface-overlay px-3 text-ink-faint">
          <input
            aria-label="Filter conversations"
            placeholder="Filter conversations"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </label>
        {body}
      </div>
    </section>
  );
}

/**
 * The DM ground: what direct messages are, and the people the viewer can message
 * (GET /api/users/messageable). Each person's source line is left out until the
 * API says which drive or role it is (needs-api: messageable/conversation shared drives and roles).
 */
export function renderDmGround(props: { readonly people: DmGroundState }): ReactNode {
  const { people } = props;
  let list: ReactNode;
  if (people.status === 'loading') list = <p role="status" className={messagesNoteClass}>{peopleNotes.loading}</p>;
  else if (people.status === 'error')
    list = (
      <>
        <p role="alert" className={messagesNoteClass}>{peopleNotes.error}</p>
        {renderButton({ variant: 'ghost', onClick: people.retry, children: 'Try again' })}
      </>
    );
  else if (people.status === 'empty') list = <p className={messagesNoteClass}>{peopleNotes.empty}</p>;
  else
    list = (
      <ul className="grid grid-cols-5 gap-2">
        {people.people.map((person) => (
          <li
            key={person.id}
            className="flex flex-col items-center gap-2 rounded-xl border border-hairline px-2 py-3 text-center"
          >
            {renderAvatar({ name: person.name, size: 'lg', src: person.avatarUrl ?? undefined })}
            <span className="w-full truncate text-sm font-medium text-ink">{person.name}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <section aria-label="Start a conversation" className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6">
      <div className="flex w-full max-w-imago-ground flex-col gap-6 pt-8">
        <div>
          <h2 className="mb-1 text-md font-semibold tracking-tight text-ink">Direct messages</h2>
          <p className="text-sm leading-normal text-ink-muted">
            Private, one-to-one. You can message your connections and anyone who shares a drive with you.
          </p>
        </div>
        <div>
          <h3 className={cn(listGroupLabelClass, 'mb-2 px-0')}>People you can message</h3>
          {list}
        </div>
      </div>
    </section>
  );
}
