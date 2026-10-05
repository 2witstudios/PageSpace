import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { renderIcon } from '../../components/icon/icon.render';
import { listGroupLabelClass } from '../../components/list-group/list-group-class';
import { renderListGroup } from '../../components/list-group/list-group.render';
import { renderUnreadCount } from '../../components/unread-count/unread-count.render';
import { messageGlyphClass, messageNameClass, messageRowClass, messagesNoteClass } from './messages-pane-class';

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

/** A section's rows, or why it has none. `no-drive` is the channels section on a user-level route. */
export type MessagesSectionView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly retry: () => void }
  | { readonly status: 'no-drive' }
  | { readonly status: 'ready'; readonly rows: readonly MessageRowView[] };

export type MessagesPaneRenderProps = {
  /** The current drive's CHANNEL pages. */
  readonly channels: MessagesSectionView;
  /** The viewer's DMs, the same in every drive. */
  readonly direct: MessagesSectionView;
};

type Notes = Readonly<Record<'loading' | 'error' | 'empty' | 'no-drive', string>>;

const sections: readonly { readonly key: keyof MessagesPaneRenderProps; readonly label: string; readonly notes: Notes }[] = [
  {
    key: 'channels',
    label: 'Channels',
    notes: {
      loading: 'Loading channels…',
      error: 'Could not load channels.',
      empty: 'No channels in this drive yet.',
      'no-drive': 'Open a drive to see its channels.',
    },
  },
  {
    key: 'direct',
    label: 'Direct messages',
    notes: {
      loading: 'Loading direct messages…',
      error: 'Could not load direct messages.',
      empty: 'No direct messages yet.',
      // DMs are user-level: they never wait on a drive.
      'no-drive': 'No direct messages yet.',
    },
  },
];

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

/** A labelled section that has no rows, saying why; a failed one offers to ask again. */
const renderNote = (label: string, text: string, role?: 'status' | 'alert', retry?: () => void): ReactNode => (
  <section key={label} aria-label={label}>
    <h2 className={listGroupLabelClass}>{label}</h2>
    <p role={role} className={messagesNoteClass}>
      {text}
    </p>
    {retry === undefined ? null : renderButton({ variant: 'ghost', onClick: retry, children: 'Try again' })}
  </section>
);

/**
 * The Messages section's list: the current drive's channels, then the
 * viewer's direct messages, each under a sentence-case label (myimago ADR
 * 0029 decision 11). Both sections always show, with a note when empty.
 */
export function renderMessagesPane(props: MessagesPaneRenderProps): ReactNode {
  return sections.map(({ key, label, notes }) => {
    const view = props[key];
    if (view.status === 'loading') return renderNote(label, notes.loading, 'status');
    if (view.status === 'error') return renderNote(label, notes.error, 'alert', view.retry);
    if (view.status === 'no-drive') return renderNote(label, notes['no-drive']);
    if (view.rows.length === 0) return renderNote(label, notes.empty);
    return <Fragment key={label}>{renderListGroup({ label, children: view.rows.map(renderRow) })}</Fragment>;
  });
}
