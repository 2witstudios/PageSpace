/** Members & seats (UI-7, canvas Members): the page's pure pieces. Credits are counts (UI-12). */
import { centsFromCredits, formatCreditCount } from '@pagespace/lib/billing/money-model';
import { orgRoleAtLeast } from '@pagespace/lib/organizations/org-roles';
import type { OrgGuest, OrgInvitation, OrgMember } from './org-api';

export function seatCapsLabel(caps: { dailyCapCents: number | null; monthlyCapCents: number | null }): string {
  const parts: string[] = [];
  if (caps.dailyCapCents !== null) parts.push(`${formatCreditCount(caps.dailyCapCents)} a day`);
  if (caps.monthlyCapCents !== null) parts.push(`${formatCreditCount(caps.monthlyCapCents)} a month`);
  return parts.length === 0 ? 'No caps' : parts.join(' · ');
}

/** A cap field: a whole number of credits (thousands separators allowed), or empty for no cap. */
export function parseCreditsInput(text: string): { ok: true; cents: number | null } | { ok: false } {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return { ok: true, cents: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, cents: centsFromCredits(Number(trimmed)) };
}

/** SEAT-3: an invitation reserves a seat while it is open and unexpired. */
export const liveInvitations = (invitations: readonly OrgInvitation[], nowMs: number): OrgInvitation[] =>
  invitations.filter((i) => !i.acceptedAt && Date.parse(i.expiresAt) > nowMs);

export type MemberTab = 'all' | 'admins' | 'pending' | 'guests';

export function memberTabCounts(input: { members: readonly OrgMember[]; pending: number; guests: number }): Record<MemberTab, number> {
  return {
    all: input.members.length,
    admins: input.members.filter((m) => orgRoleAtLeast(m.role, 'ADMIN')).length,
    pending: input.pending,
    guests: input.guests,
  };
}

export function filterMembers(members: readonly OrgMember[], tab: MemberTab, query: string): OrgMember[] {
  const q = query.trim().toLowerCase();
  return members.filter((m) => {
    if (tab === 'admins' && !orgRoleAtLeast(m.role, 'ADMIN')) return false;
    if (!q) return true;
    return (m.name ?? '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  });
}

const DAY_MS = 86_400_000;

export function inviteStatusLine(invitation: OrgInvitation, inviterName: string | null, nowMs: number): string {
  const days = Math.max(1, Math.ceil((Date.parse(invitation.expiresAt) - nowMs) / DAY_MS));
  const by = inviterName ? `Invited by ${inviterName}` : 'Invited';
  return `${by} · expires in ${days} ${days === 1 ? 'day' : 'days'} · seat reserved`;
}

const countOf = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * DRV-8: how a guest reaches the org, for the Guests list. Each drive says its source ("invited", marked pending
 * until accepted, or "page link") and any pages held there; the summary counts drives and pages.
 */
export function guestAccessLine(drives: OrgGuest['drives']): string {
  const pages = drives.reduce((sum, d) => sum + d.pageCount, 0);
  const summary = [countOf(drives.length, 'drive'), pages > 0 ? countOf(pages, 'page') : null].filter(Boolean).join(' · ');
  const each = drives.map((d) => {
    const how = [
      d.source === 'page_link' ? 'page link' : 'invited',
      d.pending ? 'pending' : null,
      d.pageCount > 0 ? countOf(d.pageCount, 'page') : null,
    ].filter(Boolean);
    return `${d.name} (${how.join(', ')})`;
  });
  return `${summary} · in ${each.join(', ')}`;
}
