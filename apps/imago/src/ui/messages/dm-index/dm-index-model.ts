// The DM ground's people the viewer can message: pure functions over what
// apps/web answers, so the ground draws the same rows the tests check.

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
