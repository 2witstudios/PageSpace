import type { Post } from '../message-model/post';
import { dayLabel, dayOf } from '../../time/time';

export type PostItem =
  | {
      readonly kind: 'day';
      readonly id: string;
      readonly label: string;
      /** The day starts with the first unread post: one divider says both. */
      readonly unread: boolean;
    }
  | { readonly kind: 'new'; readonly id: string }
  | {
      readonly kind: 'post';
      readonly id: string;
      readonly post: Post;
      /** The first post of a group carries the face, name and time. */
      readonly lead: boolean;
    };

export type GroupOptions = {
  /** YYYY-MM-DD: the injected clock the day labels read. */
  readonly today: string;
  /** UTC ISO: the viewer had read every post up to here; null if never. */
  readonly lastReadAt: string | null;
};

/** A group holds one author's posts while each follows within five minutes. */
const groupGapMs = 5 * 60_000;

const unread = (post: Post, lastReadAt: string | null): boolean =>
  post.countsAsUnread && (lastReadAt === null || Date.parse(post.at) > Date.parse(lastReadAt));

/**
 * A channel as the rows it renders, oldest first: a divider at each UTC day,
 * one New divider before the first unread post (folded into the day divider
 * when both fall on the same post), and each post marked as the lead of its
 * group or a follow-up. A divider always starts a new group.
 */
export const groupPosts = (posts: readonly Post[], { today, lastReadAt }: GroupOptions): readonly PostItem[] => {
  const firstUnread = posts.find((post) => unread(post, lastReadAt));
  return posts.flatMap((post, index): PostItem[] => {
    const previous = posts[index - 1];
    const newDay = previous === undefined || dayOf(previous.at) !== dayOf(post.at);
    const firstOfUnread = post === firstUnread;
    const dividers: PostItem[] = newDay
      ? [{ kind: 'day', id: `day-${post.id}`, label: dayLabel(post.at, today), unread: firstOfUnread }]
      : firstOfUnread
        ? [{ kind: 'new', id: 'new' }]
        : [];
    const lead =
      previous === undefined ||
      dividers.length > 0 ||
      previous.authorKey !== post.authorKey ||
      Date.parse(post.at) - Date.parse(previous.at) > groupGapMs;
    return [...dividers, { kind: 'post', id: post.id, post, lead }];
  });
};
