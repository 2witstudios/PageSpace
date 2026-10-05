import { describe, it, expect } from 'vitest';
import { filterMembers, inviteStatusLine, memberTabCounts, parseCreditsInput, seatCapsLabel, liveInvitations } from '../org-members';
import type { OrgInvitation, OrgMember } from '../org-api';

const member = (userId: string, role: OrgMember['role'], name: string, email = `${userId}@x.io`): OrgMember => ({ userId, role, name, email, image: null, joinedAt: '2026-09-01T00:00:00Z' });
const invite = (id: string, email: string, expiresAt: string, acceptedAt: string | null = null): OrgInvitation => ({ id, orgId: 'o', email, role: 'MEMBER', invitedBy: 'u_priya', expiresAt, acceptedAt, createdAt: '2026-10-01T00:00:00Z' });
const now = Date.parse('2026-10-05T12:00:00Z');

describe('seatCapsLabel', () => {
  it('UI-7 (partial) UI-12 (partial): caps read as plain credit counts, never dollars', () => {
    expect(seatCapsLabel({ dailyCapCents: null, monthlyCapCents: null })).toBe('No caps');
    expect(seatCapsLabel({ dailyCapCents: 50, monthlyCapCents: null })).toBe('50 a day');
    expect(seatCapsLabel({ dailyCapCents: 20, monthlyCapCents: 100 })).toBe('20 a day · 100 a month');
    expect(seatCapsLabel({ dailyCapCents: null, monthlyCapCents: 1000 })).toBe('1,000 a month');
  });
});

describe('parseCreditsInput', () => {
  it('reads a whole credit count as cents; empty means no cap', () => {
    expect(parseCreditsInput('50')).toEqual({ ok: true, cents: 50 });
    expect(parseCreditsInput(' 1,000 ')).toEqual({ ok: true, cents: 1000 });
    expect(parseCreditsInput('')).toEqual({ ok: true, cents: null });
  });

  it('refuses fractions, negatives and words', () => {
    for (const bad of ['1.5', '-3', 'ten', '1e3']) expect(parseCreditsInput(bad).ok, bad).toBe(false);
  });
});

describe('liveInvitations', () => {
  it('SEAT-3 (partial): only unaccepted, unexpired invitations reserve a seat', () => {
    const live = liveInvitations([invite('i1', 'a@x.io', '2026-10-11T00:00:00Z'), invite('i2', 'b@x.io', '2026-10-01T00:00:00Z'), invite('i3', 'c@x.io', '2026-10-11T00:00:00Z', '2026-10-02T00:00:00Z')], now);
    expect(live.map((i) => i.id)).toEqual(['i1']);
  });
});

describe('memberTabCounts and filterMembers', () => {
  const members = [member('u1', 'OWNER', 'Jono Woodall'), member('u2', 'ADMIN', 'Priya Nair'), member('u3', 'MEMBER', 'Marcus Oyelaran')];
  it('UI-7 (partial): All, Admins (Owner included), Pending and Guests tabs count from the lists', () => {
    expect(memberTabCounts({ members, pending: 2, guests: 3 })).toEqual({ all: 3, admins: 2, pending: 2, guests: 3 });
  });

  it('filters by tab and by name or email', () => {
    expect(filterMembers(members, 'admins', '').map((m) => m.userId)).toEqual(['u1', 'u2']);
    expect(filterMembers(members, 'all', 'marc').map((m) => m.userId)).toEqual(['u3']);
    expect(filterMembers(members, 'all', 'U2@X').map((m) => m.userId)).toEqual(['u2']);
  });
});

describe('inviteStatusLine', () => {
  it('names the inviter, the expiry and the reserved seat', () => {
    expect(inviteStatusLine(invite('i', 'sam@x.io', '2026-10-11T12:00:00Z'), 'Priya Nair', now)).toBe('Invited by Priya Nair · expires in 6 days · seat reserved');
    expect(inviteStatusLine(invite('i', 'sam@x.io', '2026-10-06T00:00:00Z'), null, now)).toBe('Invited · expires in 1 day · seat reserved');
  });
});
