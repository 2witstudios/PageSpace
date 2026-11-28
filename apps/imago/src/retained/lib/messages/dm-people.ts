/** One row of GET /api/users/messageable. */
export interface MessageablePerson {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  source: 'connection' | 'drive';
  sharedDriveCount: number;
}

export const SHARED_DRIVE_GROUP = 'Shares a drive with you';
export const CONNECTIONS_GROUP = 'Connections';

export type PersonGroup = { readonly title: string; readonly people: readonly MessageablePerson[] };

const matches = (person: MessageablePerson, query: string): boolean => {
  if (query === '') return true;
  const name = (person.displayName || person.name || '').toLowerCase();
  const username = (person.username || '').toLowerCase();
  return name.includes(query) || username.includes(query);
};

/**
 * The picker's groups: people who share a drive with the viewer, then connections, each
 * filtered by a name or @username query. A group with no people is left out. The server
 * reports `connection` for someone who is both, so they sit under Connections.
 */
export const groupPeople = (people: readonly MessageablePerson[], search: string): readonly PersonGroup[] => {
  const query = search.trim().replace(/^@/, '').toLowerCase();
  const visible = people.filter((person) => matches(person, query));
  const groups: PersonGroup[] = [
    { title: SHARED_DRIVE_GROUP, people: visible.filter((person) => person.source === 'drive') },
    { title: CONNECTIONS_GROUP, people: visible.filter((person) => person.source === 'connection') },
  ];
  return groups.filter((group) => group.people.length > 0);
};

/** The line under a person's name in the picker. */
export const sourceLabelOf = (person: MessageablePerson): string =>
  person.source === 'connection'
    ? 'Connection'
    : person.sharedDriveCount === 1
      ? '1 shared drive'
      : `${person.sharedDriveCount} shared drives`;
