import type { ReactNode } from 'react';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderButton } from '../../components/button/button.render';
import { renderIcon } from '../../components/icon/icon.render';
import { formatTime } from '../../time/time';
import type { Post, PostReaction } from '../message-model/post';
import type { PostItem } from '../post-groups/post-groups';
import { mentionsViewer, postParts } from '../post-text/post-text';
import { renderPostComposer, type PostComposerRenderProps } from '../post-composer/post-composer.render';
import {
  dividerClass,
  dividerLabelClass,
  dividerLineClass,
  dividerNewClass,
  editedClass,
  mentionClass,
  olderClass,
  postAuthorClass,
  postBodyClass,
  postClass,
  postFollowTimeClass,
  postTimeClass,
  reactionClass,
  reactionsClass,
  threadClass,
  threadNoteClass,
  threadTitleClass,
  viewOnlyClass,
} from './thread-view-class';

/** What the thread is: a drive's channel, or a DM with one person. */
export type ThreadViewKind = 'channel' | 'dm';

export type ThreadViewRenderProps = {
  readonly kind: ThreadViewKind;
  /** The channel's name, without a `#`, or the other person's in a DM. */
  readonly name: string;
  /** The other person's picture in a DM. */
  readonly image?: string | null;
  readonly viewerId: string;
  readonly status: 'loading' | 'error' | 'ready';
  readonly items: readonly PostItem[];
  /** Earlier posts: none left, ready to load, loading, or failed. */
  readonly older: 'none' | 'idle' | 'loading' | 'error';
  /** Void action: loads the next older page. */
  readonly loadOlder: () => void;
  /**
   * Whether the viewer may post: if not, a view-only notice stands where the
   * composer would. Undefined until apps/web says, when neither shows.
   */
  readonly canPost: boolean | undefined;
  /** The post composer, shown once the thread has loaded. */
  readonly composer: Omit<PostComposerRenderProps, 'label'>;
};

/** What each kind of thread calls itself and its posts. */
const words: Readonly<
  Record<
    ThreadViewKind,
    {
      readonly label: (name: string) => string;
      readonly loading: string;
      readonly error: string;
      readonly empty: (name: string) => string;
      readonly older: Readonly<Record<'idle' | 'loading' | 'error', string>>;
      /** What stands where the composer would, for a viewer who may only read; a DM is always open to post. */
      readonly viewOnly?: string;
    }
  >
> = {
  channel: {
    label: (name) => `# ${name}`,
    loading: 'Loading posts…',
    error: 'Could not load this channel.',
    empty: (name) => `No posts in ${name} yet.`,
    older: { idle: 'Load earlier posts', loading: 'Loading earlier posts…', error: 'Could not load earlier posts. Retry' },
    // Classic ChannelView's notice (getPermissionErrorMessage('send', 'channel')).
    viewOnly: 'View-only access: You need edit permission to send messages in this channel',
  },
  dm: {
    label: (name) => name,
    loading: 'Loading messages…',
    error: 'Could not load this conversation.',
    empty: (name) => `No messages with ${name} yet.`,
    older: {
      idle: 'Load earlier messages',
      loading: 'Loading earlier messages…',
      error: 'Could not load earlier messages. Retry',
    },
  },
};

/* Text stays text: React escapes every run, and only the stored
   @[label](id:type) format becomes a mention. Read-only, so a mention is
   a name, not a link. */
const body = (post: Post, viewerId: string): ReactNode =>
  postParts(post.text, viewerId).map((part, index) =>
    part.kind === 'text' ? (
      part.text
    ) : (
      <span key={index} className={mentionClass(part.you)} data-mention={part.type}>
        @{part.label}
      </span>
    ),
  );

const reactions = (list: readonly PostReaction[]): ReactNode =>
  list.length === 0 ? null : (
    <ul className={reactionsClass} aria-label="Reactions">
      {list.map(({ emoji, count, names, mine }) => (
        <li
          key={emoji}
          className={reactionClass(mine)}
          aria-label={`${emoji} ${count}${mine ? ', including you' : ''}`}
          title={names.join(', ')}
        >
          <span aria-hidden="true">{emoji}</span>
          <span className="font-medium tabular-nums" aria-hidden="true">
            {count}
          </span>
        </li>
      ))}
    </ul>
  );

const gutter = (post: Post, lead: boolean): ReactNode =>
  lead ? (
    renderAvatar({ name: post.authorName, src: post.authorImage ?? undefined, size: 'sm', agent: post.agent })
  ) : (
    <time dateTime={post.at} className={postFollowTimeClass}>
      {formatTime(post.at).replace(/ [AP]M$/, '')}
    </time>
  );

const renderPost = (post: Post, lead: boolean, viewerId: string): ReactNode => (
  <li
    key={post.id}
    className={postClass({ lead, mentioned: mentionsViewer(post.text, viewerId), pending: post.pending === true })}
    aria-busy={post.pending ? true : undefined}
    data-pending={post.pending ? '' : undefined}
  >
    {gutter(post, lead)}
    <div className="min-w-0 flex-1">
      {lead ? (
        <p className="flex items-baseline gap-2">
          <b className={postAuthorClass}>{post.authorName}</b>
          <time dateTime={post.at} className={postTimeClass}>
            {formatTime(post.at)}
          </time>
          {post.edited ? (
            <span className={editedClass} data-edited="">
              (edited)
            </span>
          ) : null}
        </p>
      ) : (
        <>
          <span className="sr-only">{`${post.authorName} said: `}</span>
          {post.edited ? (
            <span className={editedClass} data-edited="">
              (edited)
            </span>
          ) : null}
        </>
      )}
      <p className={postBodyClass}>{body(post, viewerId)}</p>
      {reactions(post.reactions)}
    </div>
  </li>
);

const divider = (id: string, day: string | undefined, unread: boolean): ReactNode => (
  <li
    key={id}
    role="separator"
    aria-label={[day, unread ? 'New' : undefined].filter(Boolean).join(', ')}
    className={dividerClass}
    data-new={unread ? '' : undefined}
  >
    <span className={dividerLineClass(unread)} />
    {day === undefined ? null : <span className={dividerLabelClass}>{day}</span>}
    {day === undefined ? null : <span className={dividerLineClass(unread)} />}
    {unread ? <span className={dividerNewClass}>New</span> : null}
  </li>
);

const renderItem = (item: PostItem, viewerId: string): ReactNode => {
  if (item.kind === 'day') return divider(item.id, item.label, item.unread);
  if (item.kind === 'new') return divider(item.id, undefined, true);
  return renderPost(item.post, item.lead, viewerId);
};

const olderButton = (kind: ThreadViewKind, older: ThreadViewRenderProps['older'], loadOlder: () => void): ReactNode =>
  older === 'none'
    ? null
    : renderButton({
        variant: 'ghost',
        className: olderClass,
        disabled: older === 'loading',
        onClick: loadOlder,
        children: words[kind].older[older],
      });

const note = ({ kind, status, name }: ThreadViewRenderProps): ReactNode => {
  if (status === 'loading')
    return (
      <p role="status" className={threadNoteClass}>
        {words[kind].loading}
      </p>
    );
  if (status === 'error')
    return (
      <p role="alert" className={threadNoteClass}>
        {words[kind].error}
      </p>
    );
  return <p className={threadNoteClass}>{words[kind].empty(name)}</p>;
};

const glyph = (kind: ThreadViewKind, name: string, image: string | null | undefined): ReactNode =>
  kind === 'channel'
    ? renderIcon({ name: 'hash', className: 'flex-none text-ink-faint' })
    : // The name follows in the title: the face's own name would say it twice.
      <span aria-hidden="true" className="contents">
        {renderAvatar({ name, src: image ?? undefined, size: 'xs' })}
      </span>;

const composerOrNotice = ({ kind, name, canPost, composer }: ThreadViewRenderProps): ReactNode =>
  canPost === undefined ? null : canPost ? (
    renderPostComposer({ ...composer, label: `Message ${words[kind].label(name)}` })
  ) : (
    <p className={viewOnlyClass} data-view-only="">
      {renderIcon({ name: 'lock', className: 'flex-none' })}
      <span>{words[kind].viewOnly}</span>
    </p>
  );

/**
 * A channel or a DM opened as the object: its flat posts oldest first,
 * grouped and divided by day, with where unread began, and the composer
 * below — or, for a viewer who may not post, a view-only notice. Mentions and
 * reactions show but do nothing. The viewer's posts not yet stored are
 * marked busy until apps/web answers.
 */
export function renderThreadView(props: ThreadViewRenderProps): ReactNode {
  const { kind, name, image, viewerId, status, items, older, loadOlder } = props;
  return (
    <section className={threadClass} aria-label={words[kind].label(name)}>
      <h1 className={threadTitleClass}>
        {glyph(kind, name, image)}
        <span>{name}</span>
      </h1>
      {status === 'ready' && items.length > 0 ? (
        <>
          {olderButton(kind, older, loadOlder)}
          <ol>{items.map((item) => renderItem(item, viewerId))}</ol>
        </>
      ) : (
        note(props)
      )}
      {status === 'ready' ? composerOrNotice(props) : null}
    </section>
  );
}
