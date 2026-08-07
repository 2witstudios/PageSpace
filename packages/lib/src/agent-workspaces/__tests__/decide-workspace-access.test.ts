/**
 * The ONE access decision, exhaustively — a session is a drive-level
 * workspace, so access is drive access. Denials must name the FIRST failing
 * gate, and unknown facts must always deny.
 *
 * The session SURFACE decision is capability-free (review #2326: sessions,
 * chat and panes are open to every drive member — only the sandbox itself is
 * gated, at the compute chokepoints). The END decision still weighs
 * `canRunCode` for non-owners (review H3: destroying live compute is not part
 * of the free surface).
 */
import { describe, it, expect } from 'vitest';
import {
  decideAgentSessionAccess,
  decideAgentSessionEndAccess,
  type AgentSessionAccessSubject,
} from '../decide-workspace-access';

const driveSession: AgentSessionAccessSubject = { ownerId: 'owner-1', driveId: 'drive-1' };
const globalSession: AgentSessionAccessSubject = { ownerId: 'owner-1', driveId: null };

describe('decideAgentSessionAccess — drive sessions', () => {
  it('allows a drive member', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'member' }),
    ).toEqual({ allowed: true });
  });

  it('allows the drive owner', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'owner' }),
    ).toEqual({ allowed: true });
  });

  it('denies a non-member — a drive session is shared through the drive, nothing else', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'none' }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('denies an UNRESOLVED membership — unknown is never a grant', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: null }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('denies even the session OWNER once they lose the drive — a removed member keeps no working context', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'owner-1', session: driveSession, driveMembership: 'none' }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });
});

describe('decideAgentSessionAccess — global-assistant sessions', () => {
  it('allows only the owner — no drive to share through', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'owner-1', session: globalSession, driveMembership: null }),
    ).toEqual({ allowed: true });
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: globalSession, driveMembership: null }),
    ).toEqual({ allowed: false, reason: 'global_assistant_not_owner' });
  });
});

describe('decideAgentSessionAccess — degenerate input', () => {
  it('denies an empty requester before anything else', () => {
    expect(
      decideAgentSessionAccess({ requesterId: '', session: driveSession, driveMembership: 'owner' }),
    ).toEqual({ allowed: false, reason: 'invalid_requester' });
  });
});

describe('decideAgentSessionEndAccess', () => {
  it('lets the OWNER end without the capability — release of compute is the owner\'s emergency exit', () => {
    // An owner who just LOST canRunCode must still be able to stop paying.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'owner-1', session: driveSession, driveMembership: 'member', canRunCode: false }),
    ).toEqual({ allowed: true });
  });

  it('lets the OWNER end even after losing the drive — same principle, scope gate', () => {
    // Use is gone (the main decision denies), but the power to stop paying is not.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'owner-1', session: driveSession, driveMembership: 'none', canRunCode: false }),
    ).toEqual({ allowed: true });
  });

  it('refuses a plain MEMBER even WITH the capability — ending another member\'s session needs delete authority (codex round 12)', () => {
    // canRunCode widened to every edit-access member (review #2326), so the
    // capability alone no longer implies delete authority; drive-root
    // permissions give non-admin members canDelete: false.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'member', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'delete_authority_required' });
  });

  it('lets a drive ADMIN with the capability end — delete authority plus the capability gate', () => {
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'admin', canRunCode: true }),
    ).toEqual({ allowed: true });
  });

  it('refuses a drive ADMIN WITHOUT the capability — review H3: destroying compute is not release, for a non-owner', () => {
    // The surface decision is capability-free, but ending stays gated: an
    // admin with no code-execution rights must not kill other members'
    // sessions and shells.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'admin', canRunCode: false }),
    ).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it("still refuses a non-member non-owner — releasing someone else's compute is touching their session", () => {
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'none', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('refuses an empty requester — the owner short-circuit must not bypass the degenerate gate', () => {
    expect(
      decideAgentSessionEndAccess({ requesterId: '', session: { ...driveSession, ownerId: '' }, driveMembership: 'owner', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'invalid_requester' });
  });
});
