import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderErrorState } from '../../frame/edge-state/edge-state.render';
import type { MemberGroup } from './members-roster';
import type { MembersDirectory, PendingInvite } from './members-api';
import { memberGroupCountClass, memberGroupRowClass, membersPaneMessageClass } from './members-pane-class';

export type MembersPaneBodyProps = {
  readonly driveId: string;
  /** The groups with their counts; undefined while the roster loads. */
  readonly groups: readonly MemberGroup[] | undefined;
  readonly error: boolean;
  readonly retry: () => void;
};

/** The Members screen, where the group rows jump to their sections. */
const membersScreen = (driveId: string): string => `/${encodeURIComponent(driveId)}/members/all`;

/** Where the Manage rows go: the invite form, and the drive settings' roles screen. */
export const membersManageHrefs = (driveId: string) => ({
  invite: `/${encodeURIComponent(driveId)}/members/invite`,
  roles: `/${encodeURIComponent(driveId)}/settings/roles`,
});

/** The pane's body: the group rows that jump to their sections, then Manage. */
export function renderMembersPaneBody({ driveId, groups, error, retry }: MembersPaneBodyProps): ReactNode {
  if (error) return renderErrorState({ title: 'Could not load members', retry });
  if (groups === undefined) {
    return (
      <p role="status" className={membersPaneMessageClass}>
        Loading members…
      </p>
    );
  }
  const manage = membersManageHrefs(driveId);
  return (
    <>
      <ul aria-label="Member groups" className="flex flex-col gap-1">
        {groups.map((group) => (
          <li key={group.id}>
            <Link href={`${membersScreen(driveId)}${group.anchor}`} className={memberGroupRowClass}>
              <span className="min-w-0 truncate">{group.label}</span>
              <span className={memberGroupCountClass}>{group.count ?? ''}</span>
            </Link>
          </li>
        ))}
      </ul>
      <section aria-label="Manage" className="mt-4 flex flex-col gap-1">
        <h2 className="px-2 pb-1 text-2xs font-semibold tracking-wide text-ink-faint">Manage</h2>
        <Link href={manage.invite} className={memberGroupRowClass}>
          Invite someone
        </Link>
        <Link href={manage.roles} className={memberGroupRowClass}>
          Roles &amp; permissions
        </Link>
      </section>
    </>
  );
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** A waiting invite's line: its role, then when it expires (C-Members-Invite: "Reviewer · expires Oct 16"). */
export function pendingInviteLine(invite: PendingInvite, now: Date): string {
  const role = invite.customRoleName ?? (invite.role === 'ADMIN' ? 'Admin' : 'Member');
  if (invite.expiresAt === null) return `${role} · no expiry`;
  const expiresAt = new Date(invite.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) return `${role} · expired`;
  return `${role} · expires ${dateFormat.format(expiresAt)}`;
}

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

const groupHeadingClass = 'px-2 pb-1 pt-3 text-2xs font-semibold tracking-wide text-ink-faint';
const backRowClass = memberGroupRowClass;

export type PaneDirectoryProps = {
  readonly driveId: string;
  readonly directory: MembersDirectory | undefined;
  readonly error: boolean;
  readonly retry: () => void;
};

/** The profile pane: back to All members, then People, Agents and Guests; the member the URL names is aria-current. */
export function renderProfilePaneBody({ driveId, currentUserId, ...rest }: PaneDirectoryProps & { readonly currentUserId: string }): ReactNode {
  if (rest.error) return renderErrorState({ title: 'Could not load members', retry: rest.retry });
  if (rest.directory === undefined) return <p role="status" className={membersPaneMessageClass}>Loading members…</p>;
  const { directory } = rest;
  return (
    <>
      <Link href={membersScreen(driveId)} className={backRowClass}>
        All members
      </Link>
      <h2 className={groupHeadingClass}>People</h2>
      <ul aria-label="People" className="flex flex-col gap-1">
        {directory.people.map((person) => {
          const current = person.userId === currentUserId;
          return (
            <li key={person.userId}>
              <Link
                href={`/${encodeURIComponent(driveId)}/members/${encodeURIComponent(person.userId)}`}
                aria-current={current ? 'page' : undefined}
                className={`${memberGroupRowClass} ${current ? 'bg-surface-overlay text-ink' : ''}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="grid size-6 flex-none place-items-center rounded-full bg-fill font-mono text-2xs text-ink-muted">{initialsOf(person.name)}</span>
                  <span className="min-w-0 truncate">{person.name}</span>
                </span>
                <span className={memberGroupCountClass}>{person.role === 'ADMIN' ? 'Admin' : person.role === 'OWNER' ? 'Owner' : 'Member'}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <h2 className={groupHeadingClass}>Agents</h2>
      <ul aria-label="Agents" className="flex flex-col gap-1">
        {directory.agents.map((name, index) => (
          <li key={`${name}-${index}`} className={`${memberGroupRowClass} cursor-default`}>
            <span className="min-w-0 truncate">{name}</span>
          </li>
        ))}
      </ul>
      <h2 className={groupHeadingClass}>Guests</h2>
      <ul aria-label="Guests" className="flex flex-col gap-1">
        {directory.guests.map((guest) => (
          <li key={guest.userId} className={`${memberGroupRowClass} cursor-default`}>
            <span className="min-w-0 truncate">{guest.name}</span>
            <span className={memberGroupCountClass}>Guest</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The invite pane: back to All members, Waiting to join with each invite's expiry, then Or share a link. */
export function renderInvitePaneBody({ driveId, ...rest }: PaneDirectoryProps): ReactNode {
  if (rest.error) return renderErrorState({ title: 'Could not load invites', retry: rest.retry });
  if (rest.directory === undefined) return <p role="status" className={membersPaneMessageClass}>Loading invites…</p>;
  const now = new Date();
  const { pendingInvites } = rest.directory;
  return (
    <>
      <Link href={membersScreen(driveId)} className={backRowClass}>
        All members
      </Link>
      <h2 className={groupHeadingClass}>Waiting to join</h2>
      {pendingInvites.length === 0 ? (
        <p className={membersPaneMessageClass}>Nobody is waiting to join.</p>
      ) : (
        <ul aria-label="Waiting to join" className="flex flex-col gap-1">
          {pendingInvites.map((invite) => (
            <li key={invite.id} className="px-2 py-1">
              <p className="truncate text-sm text-ink">{invite.email}</p>
              <p className="truncate text-xs text-ink-muted">{pendingInviteLine(invite, now)}</p>
            </li>
          ))}
        </ul>
      )}
      <h2 className={groupHeadingClass}>Or share a link</h2>
      <p className={membersPaneMessageClass}>
        Invite links let anyone join with a set role.{' '}
        <Link href={`${membersScreen(driveId)}#links`} className="text-accent-deep">
          Manage links
        </Link>
      </p>
    </>
  );
}
