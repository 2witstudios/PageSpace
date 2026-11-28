import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { iconButtonClass } from '../../components/icon-button/icon-button-class';
import { renderIcon } from '../../components/icon/icon.render';
import { listGroupRowsClass } from '../../components/list-group/list-group-class';
import { renderUnreadCount } from '../../components/unread-count/unread-count.render';
import { cn } from '../../cn';
import {
  messageGlyphClass,
  messageGroupChevronClass,
  messageGroupToggleClass,
  messageNameClass,
  messageRowClass,
  messagesNoteClass,
} from './messages-pane-class';

/** One channel or DM, ready to draw. */
export type MessageRowView = {
  readonly id: string;
  readonly kind: 'channel' | 'dm';
  readonly name: string;
  /** basePath-relative: Link adds /imago. */
  readonly href: string;
  readonly avatarUrl: string | null;
  readonly unreadCount: number;
  /** The thread open as the object. */
  readonly selected: boolean;
};

/** A group's rows, or why it has none. */
export type MessagesSectionView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly rows: readonly MessageRowView[] };

/** What a group says when it has no rows. */
export type MessagesGroupNotes = Readonly<Record<'loading' | 'error' | 'empty', string>>;

/** One foldable group: a drive's channels, or the viewer's DMs. */
export type MessagesGroupView = {
  /** Stable across routes (message-groups.ts), so a fold follows the viewer. */
  readonly key: string;
  readonly label: string;
  readonly open: boolean;
  /** Void action: fold the group, or open it. */
  readonly toggle: () => void;
  readonly section: MessagesSectionView;
  readonly notes: MessagesGroupNotes;
};

export type MessagesPaneRenderProps = {
  /** The channels groups first, then Direct messages. */
  readonly groups: readonly MessagesGroupView[];
};

export const channelNotes: MessagesGroupNotes = {
  loading: 'Loading channels…',
  error: 'Could not load channels.',
  empty: 'No channels yet.',
};

export const directNotes: MessagesGroupNotes = {
  loading: 'Loading direct messages…',
  error: 'Could not load direct messages.',
  empty: 'No direct messages yet.',
};

/* The list stays calm, as the canvases draw it: a glyph, the name and an
   unread count, with no previews or times. The open thread is being read,
   so it draws no count; its name still carries it. */
const renderRow = ({ id, kind, name, href, avatarUrl, unreadCount, selected }: MessageRowView): ReactNode => {
  const unread = unreadCount > 0;
  return (
    <li key={`${kind}:${id}`}>
      <Link
        href={href}
        prefetch
        className={messageRowClass({ selected, unread })}
        aria-current={selected ? 'page' : undefined}
        aria-label={unread ? `${name}, ${unreadCount} unread` : name}
      >
        {kind === 'channel'
          ? renderIcon({ name: 'hash', className: messageGlyphClass })
          : renderAvatar({ name, size: 'xs', src: avatarUrl ?? undefined })}
        <span className={messageNameClass}>{name}</span>
        {selected ? null : renderUnreadCount({ count: unreadCount })}
      </Link>
    </li>
  );
};

/** The Messages head's + : a new conversation, which the /dm/new page starts. */
export function renderNewMessageLink(): ReactNode {
  return (
    <Link href="/dm/new" aria-label="New message" title="New message" className={iconButtonClass('quiet')}>
      {renderIcon({ name: 'plus' })}
    </Link>
  );
}

/** The unread a folded group hides: every row's count but the open thread's. */
const hiddenUnread = (section: MessagesSectionView): number =>
  section.status === 'ready'
    ? section.rows.reduce((total, row) => total + (row.selected ? 0 : row.unreadCount), 0)
    : 0;

const renderBody = (section: MessagesSectionView, notes: MessagesGroupNotes): ReactNode => {
  if (section.status === 'loading') return <p role="status" className={messagesNoteClass}>{notes.loading}</p>;
  if (section.status === 'error')
    return (
      <>
        <p role="alert" className={messagesNoteClass}>{notes.error}</p>
        {renderButton({ variant: 'ghost', onClick: section.retry, children: 'Try again' })}
      </>
    );
  if (section.rows.length === 0) return <p className={messagesNoteClass}>{notes.empty}</p>;
  return <ul className={listGroupRowsClass}>{section.rows.map(renderRow)}</ul>;
};

/** A group's label is its fold control; folded, it carries what unread the group hides. */
const renderGroup = ({ key, label, open, toggle, section, notes }: MessagesGroupView): ReactNode => {
  const hidden = open ? 0 : hiddenUnread(section);
  return (
    <section key={key} aria-label={label}>
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-label={hidden > 0 ? `${label}, ${hidden} unread` : label}
          className={messageGroupToggleClass}
          onClick={toggle}
        >
          {renderIcon({ name: 'chevronRight', size: 12, className: cn(messageGroupChevronClass, open && 'rotate-90') })}
          <span className={messageNameClass}>{label}</span>
          {renderUnreadCount({ count: hidden })}
        </button>
      </h2>
      {open ? renderBody(section, notes) : null}
    </section>
  );
};

/**
 * The Messages section's list, the same on every Messages route: the channels
 * (the current drive's, or every drive's on Home and the user-level /dm
 * routes, one group per drive), then the viewer's direct messages. Each group
 * folds from its sentence-case label (myimago ADR 0029 decision 11), with a
 * note when it has no rows.
 */
export function renderMessagesPane({ groups }: MessagesPaneRenderProps): ReactNode {
  return <div className="flex flex-col gap-2">{groups.map(renderGroup)}</div>;
}
