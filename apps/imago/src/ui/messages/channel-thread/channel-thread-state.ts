// The open channel's posts as pure transitions. Every answer names the channel
// it is for, so one that lands after the viewer has moved on changes nothing.

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
  readonly posts: readonly Post[];
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
  | { readonly type: 'olderFailed'; readonly pageId: string };

export const initialThreadState = (pageId: string): ThreadState => ({
  pageId,
  status: 'loading',
  posts: [],
  lastReadAt: null,
  nextCursor: null,
  older: 'idle',
});

export const threadReducer = (state: ThreadState, action: ThreadAction): ThreadState => {
  if (action.type === 'opened') return initialThreadState(action.pageId);
  if (action.pageId !== state.pageId) return state;
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        status: 'ready',
        posts: action.page.posts,
        lastReadAt: action.page.lastReadAt,
        nextCursor: action.page.nextCursor,
        older: 'idle',
      };
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
  }
};
