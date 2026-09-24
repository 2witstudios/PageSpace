import { describe, it, expect } from 'vitest';
import {
  decideDriveDirectoryEntry,
  decideJoinRequest,
  decideJoinRequestApprover,
  decideJoinRequestDecision,
  decideJoinRequestStaysOpen,
  decideJoinRequestWithdrawal,
  type JoinDrive,
  type RequesterRow,
} from '../drive-join-requests';
import { driveMembershipRole } from '../drive-member-role';

// Northwind Labs (Sequence Spec Part 2): Jono owns the org, Priya is an Admin, Marcus and Lena
// are members, Chris is outside the org.
const JONO = 'jono';
const PRIYA = 'priya';
const MARCUS = 'marcus';
const LENA = 'lena';
const CHRIS = 'chris';

const drive = (over: Partial<JoinDrive> = {}): JoinDrive => ({
  ownerId: MARCUS,
  orgId: 'org_northwind',
  orgVisibility: 'RESTRICTED',
  isTrashed: false,
  ...over,
});

const accepted: RequesterRow = { role: 'MEMBER', source: 'invite', accepted: true };
const pendingInvite: RequesterRow = { role: 'ADMIN', source: 'invite', accepted: false };
const staleOrgRow: RequesterRow = { role: 'MEMBER', source: 'org', accepted: true };
// D-OW-24: the accepted row a redeemed page share link leaves. Built through the same mapping the
// loaders use, so this is exactly what a GUEST row reads as once master syncs the enum value in.
const guestRow: RequesterRow = { role: driveMembershipRole('GUEST'), source: 'invite', accepted: true };

describe('decideJoinRequest', () => {
  it('DRV-6 (partial) an org member without a row on a Restricted drive may request to join', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: false,
    })).toEqual({ ok: true, action: 'create' });
  });

  it('DRV-6 (partial) a second request while one is open is idempotent: it returns the open one, never a second row', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: true,
    })).toEqual({ ok: true, action: 'existing' });
  });

  it('DRV-6 (partial) a stale org row left by a visibility change is no membership, so its holder may request', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: staleOrgRow, hasPendingRequest: false,
    })).toEqual({ ok: true, action: 'create' });
  });

  it('DRV-6 (partial) someone outside the org learns nothing: the drive is not found', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: CHRIS, requesterOrgRole: null, requesterRow: null, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404 });
  });

  it('DRV-7 (partial) a Private drive cannot be requested and is not revealed to a plain member', () => {
    expect(decideJoinRequest({
      drive: drive({ orgVisibility: 'PRIVATE' }), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404 });
  });

  it('DRV-6 (partial) a personal drive, a missing drive and a trashed drive are not found', () => {
    for (const d of [drive({ orgId: null }), null, drive({ isTrashed: true })]) {
      expect(decideJoinRequest({
        drive: d, requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: false,
      })).toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND' });
    }
  });

  it('DRV-5 (partial) an Open drive needs no request: every org member is already in', () => {
    expect(decideJoinRequest({
      drive: drive({ orgVisibility: 'OPEN' }), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'ALREADY_MEMBER', status: 409 });
  });

  it('DRV-6 (partial) the lead and a joined member are already members', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: MARCUS, requesterOrgRole: 'MEMBER', requesterRow: null, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' });
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: accepted, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' });
  });

  it('DRV-6 (partial) a pending direct invitation is answered by accepting it, not by a request', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: pendingInvite, hasPendingRequest: false,
    })).toMatchObject({ ok: false, code: 'PENDING_INVITE', status: 409 });
  });
});

describe('decideJoinRequestDecision', () => {
  const pending = { userId: LENA, status: 'pending' as const };
  const base = {
    drive: drive(),
    request: pending,
    requesterOrgRole: 'MEMBER' as const,
    requesterRow: null,
  };

  it('DRV-6 (partial) the drive lead may approve, and approval admits the requester', () => {
    expect(decideJoinRequestDecision({ ...base, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER' }))
      .toEqual({ ok: true, action: 'approve', admit: true });
  });

  it('DRV-6 (partial) an org Owner or Admin may approve or deny', () => {
    for (const [actorId, actorOrgRole] of [[JONO, 'OWNER'], [PRIYA, 'ADMIN']] as const) {
      expect(decideJoinRequestDecision({ ...base, decision: 'approve', actorId, actorOrgRole }))
        .toEqual({ ok: true, action: 'approve', admit: true });
      expect(decideJoinRequestDecision({ ...base, decision: 'deny', actorId, actorOrgRole }))
        .toEqual({ ok: true, action: 'deny' });
    }
  });

  it('DRV-6 (partial) a plain org member who does not lead the drive cannot approve or deny', () => {
    for (const decision of ['approve', 'deny'] as const) {
      expect(decideJoinRequestDecision({ ...base, decision, actorId: 'dana', actorOrgRole: 'MEMBER' }))
        .toMatchObject({ ok: false, code: 'NOT_APPROVER', status: 403 });
    }
  });

  it('DRV-6 (partial) nobody approves their own request, not even an org Admin', () => {
    expect(decideJoinRequestDecision({
      ...base, request: { userId: PRIYA, status: 'pending' }, requesterOrgRole: 'ADMIN',
      decision: 'approve', actorId: PRIYA, actorOrgRole: 'ADMIN',
    })).toMatchObject({ ok: false, code: 'SELF_DECISION', status: 403 });
  });

  it('DRV-6 (partial) someone outside the org learns nothing about the request', () => {
    expect(decideJoinRequestDecision({ ...base, decision: 'approve', actorId: CHRIS, actorOrgRole: null }))
      .toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND', status: 404 });
  });

  it('DRV-6 (partial) a request already decided or withdrawn cannot be decided again', () => {
    for (const status of ['approved', 'denied', 'withdrawn'] as const) {
      expect(decideJoinRequestDecision({
        ...base, request: { userId: LENA, status }, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER',
      })).toMatchObject({ ok: false, code: 'NOT_PENDING', status: 409 });
    }
  });

  it('DRV-6 (partial) approval grants nothing once the drive stopped being Restricted (a Private drive is invite only)', () => {
    for (const orgVisibility of ['OPEN', 'PRIVATE'] as const) {
      expect(decideJoinRequestDecision({
        ...base, drive: drive({ orgVisibility }), decision: 'approve', actorId: PRIYA, actorOrgRole: 'ADMIN',
      })).toMatchObject({ ok: false, code: 'NOT_RESTRICTED', status: 409 });
    }
    // A stale request can still be denied, so it does not sit pending forever.
    expect(decideJoinRequestDecision({
      ...base, drive: drive({ orgVisibility: 'PRIVATE' }), decision: 'deny', actorId: PRIYA, actorOrgRole: 'ADMIN',
    })).toEqual({ ok: true, action: 'deny' });
  });

  it('DRV-6 (partial) a requester who has left the org is not admitted', () => {
    expect(decideJoinRequestDecision({
      ...base, requesterOrgRole: null, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER',
    })).toMatchObject({ ok: false, code: 'REQUESTER_NOT_ORG_MEMBER', status: 409 });
  });

  it('DRV-6 (partial) approval never accepts a pending invitation on the requester\'s behalf', () => {
    expect(decideJoinRequestDecision({
      ...base, requesterRow: pendingInvite, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER',
    })).toMatchObject({ ok: false, code: 'PENDING_INVITE', status: 409 });
  });

  it('DRV-6 (partial) approving someone who already holds a membership closes the request without a second row', () => {
    expect(decideJoinRequestDecision({
      ...base, requesterRow: accepted, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER',
    })).toEqual({ ok: true, action: 'approve', admit: false });
    // A stale org row is no membership: approval admits.
    expect(decideJoinRequestDecision({
      ...base, requesterRow: staleOrgRow, decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER',
    })).toEqual({ ok: true, action: 'approve', admit: true });
  });

  it('DRV-6 (partial) the lead approves only while still an org member', () => {
    expect(decideJoinRequestDecision({ ...base, decision: 'approve', actorId: MARCUS, actorOrgRole: null }))
      .toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
  });
});

describe('decideJoinRequestApprover', () => {
  it('DRV-6 (partial) the lead in the org, the org Owner and an org Admin may list and answer requests; a plain member and an outsider may not', () => {
    expect(decideJoinRequestApprover({ actorId: MARCUS, actorOrgRole: 'MEMBER', drive: drive() })).toEqual({ ok: true, drive: drive() });
    expect(decideJoinRequestApprover({ actorId: JONO, actorOrgRole: 'OWNER', drive: drive() })).toEqual({ ok: true, drive: drive() });
    expect(decideJoinRequestApprover({ actorId: PRIYA, actorOrgRole: 'ADMIN', drive: drive() })).toEqual({ ok: true, drive: drive() });
    expect(decideJoinRequestApprover({ actorId: LENA, actorOrgRole: 'MEMBER', drive: drive() })).toMatchObject({ ok: false, code: 'NOT_APPROVER' });
    expect(decideJoinRequestApprover({ actorId: CHRIS, actorOrgRole: null, drive: drive() })).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
    expect(decideJoinRequestApprover({ actorId: PRIYA, actorOrgRole: 'ADMIN', drive: null })).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
  });
});

describe('decideJoinRequestWithdrawal', () => {
  it('DRV-6 (partial) the requester may withdraw their own pending request, so they can ask again later', () => {
    expect(decideJoinRequestWithdrawal({ actorId: LENA, request: { userId: LENA, status: 'pending' } })).toEqual({ ok: true });
  });

  it('DRV-6 (partial) nobody else withdraws it, and a decided request stays decided', () => {
    expect(decideJoinRequestWithdrawal({ actorId: PRIYA, request: { userId: LENA, status: 'pending' } }))
      .toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND', status: 404 });
    expect(decideJoinRequestWithdrawal({ actorId: LENA, request: { userId: LENA, status: 'approved' } }))
      .toMatchObject({ ok: false, code: 'NOT_PENDING', status: 409 });
  });
});

describe('decideDriveDirectoryEntry', () => {
  const entry = (over: Partial<Parameters<typeof decideDriveDirectoryEntry>[0]>) => decideDriveDirectoryEntry({
    viewerId: LENA, viewerOrgRole: 'MEMBER', drive: drive(), viewerRow: null, hasPendingRequest: false, ...over,
  });

  it('DRV-6 (partial) a Restricted drive is listed for every org member, not joined until a row admits them', () => {
    expect(entry({})).toEqual({ joined: false, joinRequest: null, canRequest: true });
    expect(entry({ viewerRow: accepted })).toEqual({ joined: true, joinRequest: null, canRequest: false });
  });

  it('DRV-6 (partial) an open request shows as pending and cannot be repeated from the directory', () => {
    expect(entry({ hasPendingRequest: true })).toEqual({ joined: false, joinRequest: 'pending', canRequest: false });
  });

  it('DRV-6 (partial) a pending invitation is not a membership and not requestable', () => {
    expect(entry({ viewerRow: pendingInvite })).toEqual({ joined: false, joinRequest: null, canRequest: false });
  });

  it('DRV-6 (partial) a stale org row does not make a Restricted drive joined', () => {
    expect(entry({ viewerRow: staleOrgRow })).toEqual({ joined: false, joinRequest: null, canRequest: true });
  });

  it('DRV-5 (partial) an Open drive is joined for every org member', () => {
    expect(entry({ drive: drive({ orgVisibility: 'OPEN' }) })).toEqual({ joined: true, joinRequest: null, canRequest: false });
  });

  it('DRV-7 (partial) a Private drive never appears for a plain member without a row', () => {
    expect(entry({ drive: drive({ orgVisibility: 'PRIVATE' }) })).toBeNull();
  });

  it('DRV-7 (partial) a Private drive appears for the org Owner and Admins, and for its lead and invited members', () => {
    const priv = drive({ orgVisibility: 'PRIVATE' });
    expect(entry({ drive: priv, viewerId: JONO, viewerOrgRole: 'OWNER' })).toEqual({ joined: false, joinRequest: null, canRequest: false });
    expect(entry({ drive: priv, viewerId: PRIYA, viewerOrgRole: 'ADMIN' })).toEqual({ joined: false, joinRequest: null, canRequest: false });
    expect(entry({ drive: priv, viewerId: MARCUS })).toEqual({ joined: true, joinRequest: null, canRequest: false });
    expect(entry({ drive: priv, viewerRow: accepted })).toEqual({ joined: true, joinRequest: null, canRequest: false });
    expect(entry({ drive: priv, viewerRow: pendingInvite })).toBeNull();
    expect(entry({ drive: priv, viewerRow: staleOrgRow })).toBeNull();
  });

  it('DRV-6 (partial) a non-member of the org sees no directory, and a trashed or personal drive is never listed', () => {
    expect(entry({ viewerId: CHRIS, viewerOrgRole: null, viewerRow: accepted })).toBeNull();
    expect(entry({ drive: drive({ isTrashed: true }) })).toBeNull();
    expect(entry({ drive: drive({ orgId: null }) })).toBeNull();
  });

  it('DRV-6 (partial) the lead of a Restricted drive sees it joined', () => {
    expect(entry({ viewerId: MARCUS })).toEqual({ joined: true, joinRequest: null, canRequest: false });
  });
});

describe('D-OW-24 a GUEST row (redeemed page share link) is never drive membership', () => {
  const entry = (over: Partial<Parameters<typeof decideDriveDirectoryEntry>[0]>) => decideDriveDirectoryEntry({
    viewerId: LENA, viewerOrgRole: 'MEMBER', drive: drive(), viewerRow: guestRow, hasPendingRequest: false, ...over,
  });

  it('DRV-6 (partial) an org member holding only a GUEST row may still request a Restricted drive', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: guestRow, hasPendingRequest: false,
    })).toEqual({ ok: true, action: 'create' });
  });

  it('DRV-6 (partial) a non-membership row not yet accepted invites to nothing: its holder may still request', () => {
    expect(decideJoinRequest({
      drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: { ...guestRow, accepted: false }, hasPendingRequest: false,
    })).toEqual({ ok: true, action: 'create' });
  });

  it('DRV-6 (partial) approving a requester who holds only a GUEST row admits them', () => {
    expect(decideJoinRequestDecision({
      decision: 'approve', actorId: MARCUS, actorOrgRole: 'MEMBER', drive: drive(),
      request: { userId: LENA, status: 'pending' }, requesterOrgRole: 'MEMBER', requesterRow: guestRow,
    })).toEqual({ ok: true, action: 'approve', admit: true });
  });

  it('DRV-6 (partial) a GUEST row does not make a Restricted drive joined in the directory', () => {
    expect(entry({})).toEqual({ joined: false, joinRequest: null, canRequest: true });
  });

  it('DRV-7 (partial) a Private drive is never listed to a plain org member holding only a GUEST row', () => {
    expect(entry({ drive: drive({ orgVisibility: 'PRIVATE' }) })).toBeNull();
  });

  it('DRV-7 (partial) an org Admin holding a GUEST row sees a Private drive through org power only, not joined', () => {
    expect(entry({ drive: drive({ orgVisibility: 'PRIVATE' }), viewerId: PRIYA, viewerOrgRole: 'ADMIN' }))
      .toEqual({ joined: false, joinRequest: null, canRequest: false });
  });
});

describe('D-OW-25 who the directory lists a Private drive to: only people who can already open it', () => {
  const priv = drive({ orgVisibility: 'PRIVATE' });
  const entry = (over: Partial<Parameters<typeof decideDriveDirectoryEntry>[0]>) => decideDriveDirectoryEntry({
    viewerId: LENA, viewerOrgRole: 'MEMBER', drive: priv, viewerRow: null, hasPendingRequest: false, ...over,
  });

  it('DRV-7 (partial) the org Owner', () => {
    expect(entry({ viewerId: JONO, viewerOrgRole: 'OWNER' })).toEqual({ joined: false, joinRequest: null, canRequest: false });
  });

  it('DRV-7 (partial) an org Admin', () => {
    expect(entry({ viewerId: PRIYA, viewerOrgRole: 'ADMIN' })).toEqual({ joined: false, joinRequest: null, canRequest: false });
  });

  it('DRV-7 (partial) its lead', () => {
    expect(entry({ viewerId: MARCUS })).toEqual({ joined: true, joinRequest: null, canRequest: false });
  });

  it('DRV-7 (partial) an accepted invited member', () => {
    expect(entry({ viewerRow: accepted })).toEqual({ joined: true, joinRequest: null, canRequest: false });
  });

  it('DRV-7 (partial) never a plain member with no row, a pending invitee, a stale org row, a GUEST, or someone outside the org', () => {
    expect(entry({})).toBeNull();
    expect(entry({ viewerRow: pendingInvite })).toBeNull();
    expect(entry({ viewerRow: staleOrgRow })).toBeNull();
    expect(entry({ viewerRow: guestRow })).toBeNull();
    expect(entry({ viewerId: CHRIS, viewerOrgRole: null, viewerRow: accepted })).toBeNull();
  });
});

describe('decideJoinRequestApprover: no existence oracle for a Private drive', () => {
  it('DRV-7 (partial) a plain member who cannot answer gets the same not-found as a missing drive, not a 403 that confirms it', () => {
    const missing = decideJoinRequestApprover({ actorId: LENA, actorOrgRole: 'MEMBER', drive: null });
    expect(decideJoinRequestApprover({ actorId: LENA, actorOrgRole: 'MEMBER', drive: drive({ orgVisibility: 'PRIVATE' }) })).toEqual(missing);
    expect(missing).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND', status: 404 });
  });

  it('DRV-6 (partial) on a Restricted drive, which every org member already sees in the directory, the refusal still says why', () => {
    expect(decideJoinRequestApprover({ actorId: LENA, actorOrgRole: 'MEMBER', drive: drive() }))
      .toMatchObject({ ok: false, code: 'NOT_APPROVER', status: 403 });
  });

  it('DRV-7 (partial) the lead and org Admins still answer on a Private drive', () => {
    const priv = drive({ orgVisibility: 'PRIVATE' });
    expect(decideJoinRequestApprover({ actorId: MARCUS, actorOrgRole: 'MEMBER', drive: priv })).toEqual({ ok: true, drive: priv });
    expect(decideJoinRequestApprover({ actorId: PRIYA, actorOrgRole: 'ADMIN', drive: priv })).toEqual({ ok: true, drive: priv });
  });
});

describe('decideJoinRequestStaysOpen: a pending request closes when what it asked for is gone', () => {
  const open = (over: Partial<Parameters<typeof decideJoinRequestStaysOpen>[0]> = {}) => decideJoinRequestStaysOpen({
    drive: drive(), requesterId: LENA, requesterOrgRole: 'MEMBER', requesterRow: null, ...over,
  });

  it('DRV-6 (partial) stays open on a Restricted org drive while the requester is in the org and does not lead it', () => {
    expect(open()).toBe(true);
  });

  it('DRV-6 (partial) closes once the drive is no longer Restricted (Open or Private)', () => {
    expect(open({ drive: drive({ orgVisibility: 'OPEN' }) })).toBe(false);
    expect(open({ drive: drive({ orgVisibility: 'PRIVATE' }) })).toBe(false);
  });

  it('DRV-6 (partial) closes once the requester left the org', () => {
    expect(open({ requesterOrgRole: null })).toBe(false);
  });

  it('DRV-6 (partial) closes once the drive moved out of the org', () => {
    expect(open({ drive: drive({ orgId: null }) })).toBe(false);
  });

  it('DRV-6 (partial) closes once the requester became the lead', () => {
    expect(open({ requesterId: MARCUS })).toBe(false);
  });

  it('DRV-6 (partial) closes once the requester became a member another way (an accepted invitation)', () => {
    expect(open({ requesterRow: accepted })).toBe(false);
  });

  it('DRV-6 (partial) stays open beside a row that is no membership: a GUEST row, a stale org row, a pending invitation', () => {
    expect(open({ requesterRow: guestRow })).toBe(true);
    expect(open({ requesterRow: staleOrgRow })).toBe(true);
    expect(open({ requesterRow: pendingInvite })).toBe(true);
  });
});
