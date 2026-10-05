'use client';

import { useEffect, useRef, useState } from 'react';
import type { Post } from '../message-model/post';
import type { ThreadState } from '../thread/thread-state';
import type { SendResult } from '../thread/use-thread';
import { groupPosts } from '../post-groups/post-groups';
import { renderThreadView, type ThreadViewKind } from './thread-view.render';

export type ThreadObjectProps = {
  readonly kind: ThreadViewKind;
  readonly name: string;
  readonly image?: string | null;
  readonly viewerId: string;
  readonly state: ThreadState;
  /** Every post to draw, oldest first: the thread's stored and sending posts. */
  readonly posts: readonly Post[];
  readonly loadOlder: () => void;
  readonly send: (content: string) => Promise<SendResult>;
  /** Whether the viewer may post; undefined until apps/web says, when neither composer nor notice shows. */
  readonly canPost: boolean | undefined;
  /** The day the dividers count from, UTC `YYYY-MM-DD`. */
  readonly today: string;
};

/** Each thread's unsent text and last send error, for as long as the object is mounted. */
type Drafts = Readonly<Record<string, { readonly draft: string; readonly error: string | null }>>;

const blank = { draft: '', error: null };

/**
 * An open thread in the object slot, channel or DM alike: lands where unread
 * begins, keeps a draft per thread, and sends it. A send that fails gives the
 * text back with why, unless the viewer has typed anew since.
 */
export function ThreadObject({ kind, name, image, viewerId, state, posts, loadOlder, send, canPost, today }: ThreadObjectProps) {
  const { threadId } = state;
  const [drafts, setDrafts] = useState<Drafts>({});
  const { draft, error } = drafts[threadId] ?? blank;
  const keep = (thread: string, next: { readonly draft: string; readonly error: string | null }) =>
    setDrafts((all) => ({ ...all, [thread]: next }));

  // Opening a thread lands where unread begins, else at its newest post;
  // once per open, so loading earlier posts never jumps the view.
  const thread = useRef<HTMLDivElement>(null);
  const placed = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== 'ready' || placed.current === threadId) return;
    placed.current = threadId;
    const unread = thread.current?.querySelector('[data-new]');
    if (unread) unread.scrollIntoView?.({ block: 'start' });
    else thread.current?.querySelector('ol > li:last-child')?.scrollIntoView?.({ block: 'end' });
  }, [state.status, threadId]);

  // The viewer's own post goes on screen at the foot of the thread.
  const sending = state.sending.length;
  useEffect(() => {
    if (sending > 0) thread.current?.querySelector('ol > li:last-child')?.scrollIntoView?.({ block: 'end' });
  }, [sending]);

  const sendDraft = () => {
    const sentFrom = threadId;
    const content = draft;
    keep(sentFrom, blank);
    void send(content).then((result) => {
      // Not sent: the text comes back, unless the viewer has typed anew.
      if (!result.sent)
        setDrafts((all) => {
          const current = all[sentFrom] ?? blank;
          return { ...all, [sentFrom]: { draft: current.draft === '' ? content : current.draft, error: result.error } };
        });
    });
  };

  return (
    <div ref={thread}>
      {renderThreadView({
        kind,
        name,
        image,
        viewerId,
        // Its parent draws a not-found thread itself and never mounts this for it.
        status: state.status === 'not-found' ? 'error' : state.status,
        items: groupPosts(posts, { today, lastReadAt: state.lastReadAt }),
        older: state.nextCursor === null ? 'none' : state.older,
        loadOlder,
        canPost,
        composer: {
          draft,
          error,
          typeDraft: (next) => keep(threadId, { draft: next, error }),
          send: sendDraft,
        },
      })}
    </div>
  );
}
