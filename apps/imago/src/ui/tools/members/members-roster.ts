// Who has access to a drive, by kind (C-Members). The counts come from the
// routes apps/web already has: drives/[driveId]/members (people, page-link
// guests, pending invites), agents/members, apps/members and share-links.

/** The role apps/web gives a row redeemed through a page share link. */
export const PAGE_LINK_GUEST_ROLE = 'GUEST';

export type RosterCounts = {
  readonly people: number;
  /** Page-link guests: the only guests apps/web knows today (drive guests need PR #2871). */
  readonly guests: number;
  readonly agents: number;
  readonly apps: number;
  readonly pendingInvites: number;
  /** undefined when the viewer may not see the drive's invite links. */
  readonly inviteLinks: number | undefined;
};

export type MemberGroupId = 'everyone' | 'people' | 'guests' | 'agents' | 'apps' | 'pending' | 'links';

export type MemberGroup = {
  readonly id: MemberGroupId;
  readonly label: string;
  /** undefined while the counts load: a count is never guessed. */
  readonly count: number | undefined;
  /** The section on the Members page this row jumps to. */
  readonly anchor: string;
};

/** Splits a drive's members into people and page-link guests, by role. */
export function partitionMembers<T extends { readonly role: string }>(
  members: readonly T[],
): { readonly people: readonly T[]; readonly guests: readonly T[] } {
  return {
    people: members.filter((member) => member.role !== PAGE_LINK_GUEST_ROLE),
    guests: members.filter((member) => member.role === PAGE_LINK_GUEST_ROLE),
  };
}

/** Everyone with access: people, guests, agents and apps. */
export const everyoneCount = (counts: RosterCounts): number =>
  counts.people + counts.guests + counts.agents + counts.apps;

/** The pane's group rows, in board order, each with its live count. */
export function memberGroups(counts: RosterCounts | undefined): readonly MemberGroup[] {
  const count = (value: (roster: RosterCounts) => number | undefined): number | undefined =>
    counts === undefined ? undefined : value(counts);
  return [
    { id: 'everyone', label: 'Everyone', count: count(everyoneCount), anchor: '#everyone' },
    { id: 'people', label: 'People', count: count((c) => c.people), anchor: '#people' },
    { id: 'guests', label: 'Guests', count: count((c) => c.guests), anchor: '#page-link-guests' },
    { id: 'agents', label: 'Agents', count: count((c) => c.agents), anchor: '#agents' },
    { id: 'apps', label: 'Apps', count: count((c) => c.apps), anchor: '#apps' },
    { id: 'pending', label: 'Pending invites', count: count((c) => c.pendingInvites), anchor: '#pending' },
    { id: 'links', label: 'Invite links', count: count((c) => c.inviteLinks), anchor: '#links' },
  ];
}
