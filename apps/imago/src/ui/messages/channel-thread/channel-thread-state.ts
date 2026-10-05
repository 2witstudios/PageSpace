// The open channel's posts as pure transitions. Every answer names the channel
// it is for, so one that lands after the viewer has moved on changes nothing.
//
// The viewer's own posts show as sending until apps/web answers. The answer
// to the POST and realtime's broadcast of the same post can land in either
// order: whichever comes first retires the sending post its nonce names, and
// the second finds the post already held by id and changes nothing.

import type { Post } from '../message-model/post';

/** One page of posts, oldest first, as imago reads it. */
export type ChannelPage = {
  readonly posts: readonly Post[];
  /** Reaches the next older page; null at the channel's first post. */
  readonly nextCursor: string | null;
  readonly lastReadAt: string | null;
};

export type ThreadState = {
  readonly pageId: string;
  readonly status: 'loading' | 'ready' | 'error';
  /** Stored posts, oldest first. */
  readonly posts: readonly Post[];
  /** The viewer's posts not yet stored, in the order they were sent; each id is `temp-<nonce>`. */
  readonly sending: readonly Post[];
  /** How many posts from others have arrived live: each one is read again once seen. */
  readonly heard: number;
  /** Where unread began when the channel was opened; fixed for the open. */
  readonly lastReadAt: string | null;
  readonly nextCursor: string | null;
  readonly older: 'idle' | 'loading' | 'error';
};

export type ThreadAction =
  | { readonly type: 'opened'; readonly pageId: string }
  | { readonly type: 'loaded'; readonly pageId: string; readonly page: ChannelPage }
  | { readonly type: 'failed'; readonly pageId: string }
  | { readonly type: 'olderRequested'; readonly pageId: string }
  | { readonly type: 'olderLoaded'; readonly pageId: string; readonly page: ChannelPage }
  | { readonly type: 'olderFailed'; readonly pageId: string }
  | { readonly type: 'sent'; readonly pageId: string; readonly post: Post }
  | {
      readonly type: 'received';
      readonly pageId: string;
      readonly post: Post;
      /** The nonce apps/web echoed, if any. */
      readonly nonce?: string;
      /** The viewer posted it; another member's post never retires the viewer's. */
      readonly mine: boolean;
    }
  | { readonly type: 'sendFailed'; readonly pageId: string; readonly nonce: string };

/** The id a sending post carries until apps/web stores it. */
export const pendingId = (nonce: string): string => `temp-${nonce}`;

/** Time order, keeping arrival order for posts at the same instant. */
const byTime = (posts: readonly Post[]): readonly Post[] =>
  posts
    .map((post, index) => ({ post, index, at: Date.parse(post.at) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ post }) => post);

/** Every post to draw: the stored ones, then the viewer's still sending. */
export const threadPosts = (state: ThreadState): readonly Post[] => [...state.posts, ...state.sending];

export const initialThreadState = (pageId: string): ThreadState => ({
  pageId,
  status: 'loading',
  posts: [],
  sending: [],
  heard: 0,
  lastReadAt: null,
  nextCursor: null,
  older: 'idle',
});

export const threadReducer = (state: ThreadState, action: ThreadAction): ThreadState => {
  if (action.type === 'opened') return initialThreadState(action.pageId);
  if (action.pageId !== state.pageId) return state;
  switch (action.type) {
    case 'loaded': {
      // A post that arrived live while the page loaded may be newer than it.
      const paged = new Set(action.page.posts.map((post) => post.id));
      const live = state.posts.filter((post) => !paged.has(post.id));
      return {
        ...state,
        status: 'ready',
        posts: byTime([...action.page.posts, ...live]),
        lastReadAt: action.page.lastReadAt,
        nextCursor: action.page.nextCursor,
        older: 'idle',
      };
    }
    case 'failed':
      return { ...state, status: 'error' };
    case 'olderRequested':
      return { ...state, older: 'loading' };
    case 'olderLoaded': {
      // A post sent while paging shifts the cursor's window: keep each once.
      const held = new Set(state.posts.map((post) => post.id));
      const older = action.page.posts.filter((post) => !held.has(post.id));
      return { ...state, posts: [...older, ...state.posts], nextCursor: action.page.nextCursor, older: 'idle' };
    }
    case 'olderFailed':
      return { ...state, older: 'error' };
    case 'sent':
      return { ...state, sending: [...state.sending, action.post] };
    case 'received': {
      const nonce = action.mine ? action.nonce : undefined;
      const retired = nonce === undefined ? state.sending : state.sending.filter((post) => post.id !== pendingId(nonce));
      const held = state.posts.some((post) => post.id === action.post.id);
      if (held) return retired === state.sending ? state : { ...state, sending: retired };
      return {
        ...state,
        posts: byTime([...state.posts, action.post]),
        sending: retired,
        heard: action.mine ? state.heard : state.heard + 1,
      };
    }
    case 'sendFailed':
      return { ...state, sending: state.sending.filter((post) => post.id !== pendingId(action.nonce)) };
  }
};
