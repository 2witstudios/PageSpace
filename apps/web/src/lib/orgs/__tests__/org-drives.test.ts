import { describe, it, expect } from 'vitest';
import { directoryAction, directorySections, driveMembersLabel, mayAnswerJoinRequests, VISIBILITY_COPY, movableDrives } from '../org-drives';
import type { OrgDriveDirectoryEntry } from '../org-api';

const entry = (over: Partial<OrgDriveDirectoryEntry>): OrgDriveDirectoryEntry => ({
  id: 'd',
  name: 'Drive',
  slug: 'drive',
  orgVisibility: 'OPEN',
  lead: { id: 'u_lead', name: 'Lead', image: null },
  joined: true,
  joinRequest: null,
  canRequest: false,
  ...over,
});

describe('directoryAction', () => {
  it('DRV-6 (partial): a joined drive opens, a Restricted one is requested, a sent request waits, an invitation is accepted elsewhere', () => {
    expect(directoryAction(entry({ orgVisibility: 'OPEN', joined: true }))).toBe('open');
    expect(directoryAction(entry({ orgVisibility: 'RESTRICTED', joined: true }))).toBe('open');
    expect(directoryAction(entry({ orgVisibility: 'RESTRICTED', joined: false, canRequest: true }))).toBe('request');
    expect(directoryAction(entry({ orgVisibility: 'RESTRICTED', joined: false, joinRequest: 'pending' }))).toBe('requested');
    expect(directoryAction(entry({ orgVisibility: 'RESTRICTED', joined: false, canRequest: false }))).toBe('invited');
  });

  it('a Private drive an admin is not on is managed, never requested', () => {
    expect(directoryAction(entry({ orgVisibility: 'PRIVATE', joined: false }))).toBe('manage');
    expect(directoryAction(entry({ orgVisibility: 'PRIVATE', joined: true }))).toBe('open');
  });
});

describe('mayAnswerJoinRequests', () => {
  const restricted = { orgId: 'org_1', orgVisibility: 'RESTRICTED' as const, isOwned: false };

  it('DRV-6 (partial): on a Restricted drive its lead and the org Owner and Admins answer requests; a plain member does not', () => {
    expect(mayAnswerJoinRequests({ ...restricted, isOwned: true }, 'MEMBER')).toBe(true);
    expect(mayAnswerJoinRequests(restricted, 'ADMIN')).toBe(true);
    expect(mayAnswerJoinRequests(restricted, 'OWNER')).toBe(true);
    expect(mayAnswerJoinRequests(restricted, 'MEMBER')).toBe(false);
    expect(mayAnswerJoinRequests(restricted, undefined)).toBe(false);
  });

  it('an Open or Private drive and a personal drive have no requests to answer', () => {
    expect(mayAnswerJoinRequests({ ...restricted, orgVisibility: 'OPEN', isOwned: true }, 'ADMIN')).toBe(false);
    expect(mayAnswerJoinRequests({ ...restricted, orgVisibility: 'PRIVATE', isOwned: true }, 'ADMIN')).toBe(false);
    expect(mayAnswerJoinRequests({ orgId: null, isOwned: true }, undefined)).toBe(false);
  });
});

describe('directorySections', () => {
  it('DRV-6 (partial): my drives first, then the Restricted drives I can ask to join, then Private drives only an admin manages', () => {
    const open = entry({ id: 'open', orgVisibility: 'OPEN' });
    const joinedRestricted = entry({ id: 'jr', orgVisibility: 'RESTRICTED' });
    const askable = entry({ id: 'ask', orgVisibility: 'RESTRICTED', joined: false, canRequest: true });
    const pending = entry({ id: 'pend', orgVisibility: 'RESTRICTED', joined: false, joinRequest: 'pending' });
    const privateJoined = entry({ id: 'pj', orgVisibility: 'PRIVATE' });
    const privateAdmin = entry({ id: 'pa', orgVisibility: 'PRIVATE', joined: false });
    const sections = directorySections([open, askable, privateAdmin, joinedRestricted, pending, privateJoined]);
    expect(sections.map((s) => [s.kind, s.drives.map((d) => d.id)])).toEqual([
      ['mine', ['open', 'jr', 'pj']],
      ['restricted', ['ask', 'pend']],
      ['admin', ['pa']],
    ]);
  });

  it('leaves out an empty section', () => {
    expect(directorySections([entry({ id: 'open' })]).map((s) => s.kind)).toEqual(['mine']);
    expect(directorySections([])).toEqual([]);
  });
});

describe('driveMembersLabel', () => {
  it('UI-7 (partial): people in the drive, and how many are guests (canvas "12 · 1 guest")', () => {
    expect(driveMembersLabel({ memberCount: 12, guestCount: 1 })).toBe('12 · 1 guest');
    expect(driveMembersLabel({ memberCount: 5, guestCount: 2 })).toBe('5 · 2 guests');
    expect(driveMembersLabel({ memberCount: 3, guestCount: 0 })).toBe('3');
    expect(driveMembersLabel(undefined)).toBe('');
  });
});

describe('VISIBILITY_COPY', () => {
  it('DRV-4 (partial): explains Open, Restricted and Private as the canvas card does', () => {
    expect(Object.keys(VISIBILITY_COPY)).toEqual(['OPEN', 'RESTRICTED', 'PRIVATE']);
    expect(VISIBILITY_COPY.OPEN.label).toBe('Open');
    expect(VISIBILITY_COPY.RESTRICTED.description).toMatch(/drive lead approves/);
    expect(VISIBILITY_COPY.PRIVATE.description).toMatch(/audit log/);
  });
});

describe('movableDrives', () => {
  it('DRV-2 (partial): only personal drives I own and have not trashed can move in; Home never', () => {
    const drives = [
      { id: 'a', name: 'Side', isOwned: true, orgId: null, isTrashed: false, kind: 'STANDARD' as const },
      { id: 'h', name: 'Home', isOwned: true, orgId: null, isTrashed: false, kind: 'HOME' as const },
      { id: 'o', name: 'Org', isOwned: true, orgId: 'org', isTrashed: false },
      { id: 's', name: 'Shared', isOwned: false, orgId: null, isTrashed: false },
      { id: 't', name: 'Trash', isOwned: true, orgId: null, isTrashed: true },
    ];
    expect(movableDrives(drives).map((d) => d.id)).toEqual(['a']);
  });
});
