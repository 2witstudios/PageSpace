import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { renderIcon } from '../../components/icon/icon.render';
import { renderSegmentedControl } from '../../components/segmented-control/segmented-control.render';
import { renderUnreadCount } from '../../components/unread-count/unread-count.render';
import { cn } from '../../cn';
import type { InboxFilter, InboxRowView } from './inbox-rows';
import { messageGlyphClass, messagesNoteClass } from './messages-pane-class';

export type InboxPaneRenderProps = {
  /** Loading and failed carry no rows; a ready list may still be empty under its filter. */
  readonly status: 'loading' | 'error' | 'ready';
  readonly filter: InboxFilter;
  readonly onFilter: (filter: InboxFilter) => void;
  readonly retry: () => void;
  readonly rows: readonly InboxRowView[];
};

const filters: readonly { readonly value: InboxFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'channels', label: 'Channels' },
  { value: 'direct', label: 'Direct' },
];

/** What an empty list under each filter says. */
const emptyNote: Readonly<Record<InboxFilter, string>> = {
  all: 'No conversations yet.',
  channels: 'No channels yet.',
  direct: 'No direct messages yet.',
};

const rowClass = (unread: boolean): string =>
  cn(
    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm no-underline transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:no-underline',
    unread ? 'text-ink' : 'text-ink-muted hover:text-ink',
  );

/** One row: the glyph or face, the name and time, then the "Sender: preview" line with its unread pill. */
const renderRow = (row: InboxRowView): ReactNode => (
  <li key={`${row.kind}:${row.id}`}>
    <Link
      href={row.href}
      prefetch
      className={rowClass(row.unreadCount > 0)}
      aria-label={row.unreadCount > 0 ? `${row.name}, ${row.unreadCount} unread` : row.name}
    >
      {row.kind === 'channel'
        ? renderIcon({ name: 'hash', className: cn(messageGlyphClass, 'size-8 justify-center') })
        : renderAvatar({ name: row.name, size: 'md', src: row.avatarUrl ?? undefined })}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate', row.unreadCount > 0 ? 'font-medium' : 'font-normal')}>{row.name}</span>
          <span className="flex-none text-xs text-ink-faint tabular-nums">{row.when}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{row.preview}</span>
          {renderUnreadCount({ count: row.unreadCount })}
        </span>
      </span>
    </Link>
  </li>
);

/** A status line for the list, with Try again when the load failed. */
const renderNote = (text: string, role: 'status' | 'alert' | undefined, retry?: () => void): ReactNode => (
  <>
    <p role={role} className={messagesNoteClass}>
      {text}
    </p>
    {retry === undefined ? null : renderButton({ variant: 'ghost', onClick: retry, children: 'Try again' })}
  </>
);

/**
 * The Messages index's pane: a segmented Show filter (All, Channels, Direct) over the viewer's
 * channels and DMs merged newest first, each row with its name, time, "Sender: preview" and unread
 * count, and a footer naming the scope.
 */
export function renderInboxPane(props: InboxPaneRenderProps): ReactNode {
  const { filter, onFilter, retry } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3 pt-2">
      {renderSegmentedControl({ label: 'Show', segments: filters, value: filter, select: onFilter })}
      {props.status === 'loading'
        ? renderNote('Loading messages…', 'status')
        : props.status === 'error'
          ? renderNote('Could not load messages.', 'alert', retry)
          : props.rows.length === 0
            ? renderNote(emptyNote[filter], undefined)
            : <ul className="flex flex-col gap-1">{props.rows.map(renderRow)}</ul>}
      <p className="px-2 pt-2 text-xs text-ink-faint">Showing all drives</p>
    </div>
  );
}
