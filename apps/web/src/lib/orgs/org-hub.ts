/**
 * The org settings hub's rows (UI-1, canvas Main), by the viewer's role (UI-11). Pure: the page
 * renders exactly these, so what a plain Member can reach is decided and tested here.
 */
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import type { OrgRole } from './org-api';

export type OrgHubIcon =
  | 'guests' | 'automation' | 'general' | 'members' | 'drives' | 'policies' | 'security' | 'audit'
  | 'plan' | 'usage' | 'backups' | 'danger' | 'leave';

export interface OrgHubRow {
  title: string;
  description: string;
  icon: OrgHubIcon;
  /** Where the row goes; absent for an action row. */
  href?: string;
  /** An action the hub performs in place instead of navigating. */
  action?: 'leave';
  badge?: string;
  available: boolean;
}

export interface OrgHubSection {
  title: string;
  rows: OrgHubRow[];
}

/** Counts the hub shows; any that have not loaded are absent and never guessed. */
export interface OrgHubCounts {
  members?: number;
  pendingInvites?: number;
  guests?: number;
  drives?: number;
  guestApprovals?: number;
  ownerLeftAutomations?: number;
}

export interface OrgHubInput {
  orgId: string;
  orgName: string;
  role: OrgRole;
  counts: OrgHubCounts;
  /** Billing is off in onprem and tenant modes (SEAT-6); the Billing group is hidden then. */
  billingEnabled: boolean;
  /** "Renews Oct 1", once the subscription's period end is known. */
  renewalLabel?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function membersDescription(orgName: string, c: OrgHubCounts): string {
  if (c.members === undefined) return `Who is in ${orgName}, invitations, and guests`;
  const parts = [plural(c.members, 'member')];
  if (c.pendingInvites !== undefined) parts.push(plural(c.pendingInvites, 'pending invite'));
  if (c.guests !== undefined) parts.push(plural(c.guests, 'guest'));
  return parts.join(', ');
}

export function orgHubSections({ orgId, orgName, role, counts, billingEnabled, renewalLabel }: OrgHubInput): OrgHubSection[] {
  const base = `/orgs/${orgId}/settings`;
  const leave: OrgHubSection = {
    title: 'Membership',
    rows: [{ title: `Leave ${orgName}`, description: 'Lose access to its drives unless you were invited to them directly', icon: 'leave', action: 'leave', available: true }],
  };

  if (!orgRoleAtLeast(role, 'ADMIN')) return [leave];

  const sections: OrgHubSection[] = [];

  const attention: OrgHubRow[] = [];
  if (counts.guestApprovals) {
    attention.push({
      title: 'Guest approvals',
      description: `Drive leads asked to bring in people from outside ${orgName}`,
      icon: 'guests',
      href: `${base}/attention#guests`,
      badge: `${counts.guestApprovals} waiting`,
      available: true,
    });
  }
  if (counts.ownerLeftAutomations) {
    attention.push({
      title: 'Automations whose owner left',
      description: 'Disabled until an admin reassigns or deletes them',
      icon: 'automation',
      href: `${base}/attention#automations`,
      badge: `${counts.ownerLeftAutomations} disabled`,
      available: true,
    });
  }
  if (attention.length > 0) sections.push({ title: 'Needs your attention', rows: attention });

  sections.push({
    title: 'Organization',
    rows: [
      { title: 'General', description: `Name, URL, and who owns ${orgName}`, icon: 'general', href: `${base}/general`, available: true },
      {
        title: 'Members & seats',
        description: membersDescription(orgName, counts),
        icon: 'members',
        href: `${base}/members`,
        ...(counts.pendingInvites ? { badge: `${counts.pendingInvites} pending` } : {}),
        available: true,
      },
      {
        title: 'Drives',
        description: counts.drives === undefined
          ? `Drives owned by ${orgName} and who can see them`
          : `${plural(counts.drives, 'drive')} owned by ${orgName} and who can see them`,
        icon: 'drives',
        href: `${base}/drives`,
        available: true,
      },
    ],
  });

  sections.push({
    title: 'Controls',
    rows: [
      { title: 'Policies', description: 'Sharing, membership, AI, and compute rules for every org drive', icon: 'policies', href: `${base}/policies`, available: true },
      { title: 'Security', description: 'Verified domains and sign-in requirements', icon: 'security', href: `${base}/security`, available: true },
      { title: 'Audit log', description: `Who changed what across ${orgName}`, icon: 'audit', href: `${base}/audit`, available: true },
    ],
  });

  if (billingEnabled) {
    sections.push({
      title: 'Billing',
      rows: [
        { title: 'Plan & seats', description: 'Business plan · 5 seats included, extra seats added as people join', icon: 'plan', href: `${base}/billing`, ...(renewalLabel ? { badge: renewalLabel } : {}), available: true },
        { title: 'Usage', description: 'Credits pool and drive wallets across org drives', icon: 'usage', href: `${base}/billing#pool`, available: true },
      ],
    });
  }

  sections.push({
    title: 'Data',
    rows: [{ title: 'Backups', description: 'Scheduled snapshots of every org drive', icon: 'backups', available: false }],
  });

  if (orgRoleAtLeast(role, 'OWNER')) {
    sections.push({
      title: 'Administration',
      rows: [{ title: 'Danger Zone', description: `Transfer ownership or delete ${orgName}`, icon: 'danger', href: `${base}/danger`, available: true }],
    });
  } else {
    sections.push(leave);
  }

  return sections;
}
