'use client';

import type { ReactNode } from 'react';
import { renderAvatar } from '../components/avatar/avatar.render';
import { useImagoPageId } from '../chat/use-chat-data/use-chat-data';
import type { Post } from '../messages/message-model/post';
import { ImagoOrb } from './imago-orb/imago-orb';

/** Whether an agent's post is Imago's own: its author key names the agent page it posted as. */
export const isImagoPost = (post: Pick<Post, 'agent' | 'authorKey'>, imagoPageId: string | null): boolean =>
  post.agent && imagoPageId !== null && post.authorKey.endsWith(`:agent:${imagoPageId}`);

/** An agent post's face: Imago posts as its orb; any other agent as the agent glyph. */
export function AuthorAvatar({ post }: { readonly post: Post }): ReactNode {
  return isImagoPost(post, useImagoPageId())
    ? <ImagoOrb size="avatar" label={post.authorName} />
    : renderAvatar({ name: post.authorName, src: post.authorImage ?? undefined, size: 'sm', agent: true });
}
