// The /dm index's view of the viewer's conversations and the people they can
// message: pure functions over what apps/web answers, so the pane and the
// ground draw the same rows the tests check.

import type { DirectThread } from '../message-model/message';

/** One person GET /api/users/messageable lists (apps/web's MessageableUser, the fields the ground draws). */
export type MessageableUserResponse = {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly image: string | null;
  readonly avatarUrl: string | null;
};

export type MessageablePerson = {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
};

/** The name a person is drawn with: display name, then name, then username. */
export const personNameOf = (user: { readonly displayName: string | null; readonly name: string | null; readonly username: string | null }): string =>
  user.displayName || user.name || user.username || 'Unknown user';

/** Messageable people as the ground lists them, in the server's order. */
export const messageablePeopleFrom = (users: readonly MessageableUserResponse[]): readonly MessageablePerson[] =>
  users.map((user) => ({
    id: user.id,
    name: personNameOf(user),
    username: user.username,
    avatarUrl: user.avatarUrl ?? user.image,
  }));

/**
 * Whether a conversation matches the filter: the query, trimmed and case-folded,
 * is a substring of the other person's name or username. An empty query matches all.
 */
export const matchesFilter = (thread: Pick<DirectThread, 'name' | 'username'>, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return thread.name.toLowerCase().includes(needle) || (thread.username ?? '').toLowerCase().includes(needle);
};

/** The conversations that match the filter, in the order they came. */
export const filterThreads = (threads: readonly DirectThread[], query: string): readonly DirectThread[] =>
  threads.filter((thread) => matchesFilter(thread, query));
