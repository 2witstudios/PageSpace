/**
 * The ONE access decision, exhaustively — a session is a drive-level
 * workspace, so access is drive access. Denials must name the FIRST failing
 * gate, and unknown facts must always deny.
 */
import { describe, it, expect } from 'vitest';
import {
  decideAgentSessionAccess,
  decideAgentSessionEndAccess,
  type AgentSessionAccessSubject,
} from '../decide-session-access';

const driveSession: AgentSessionAccessSubject = { sessionId: 'ses-1', ownerId: 'owner-1', driveId: 'drive-1' };
const globalSession: AgentSessionAccessSubject = { sessionId: 'ses-2', ownerId: 'owner-1', driveId: null };

describe('decideAgentSessionAccess — drive sessions', () => {
  it('allows a drive member with the capability', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'member', canRunCode: true }),
    ).toEqual({ allowed: true });
  });

  it('allows the drive owner', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'owner', canRunCode: true }),
    ).toEqual({ allowed: true });
  });

  it('denies a non-member — a drive session is shared through the drive, nothing else', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'none', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('denies an UNRESOLVED membership — unknown is never a grant', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: null, canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('denies even the session OWNER once they lose the drive — a removed member keeps no working context', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'owner-1', session: driveSession, driveMembership: 'none', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('denies a member without the capability, naming the capability', () => {
    // A distinct reason: the requester may legitimately reach this session and
    // still not be allowed a sandbox.
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'member', canRunCode: false }),
    ).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });

  it('names the FIRST failing gate — scope before capability', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'none', canRunCode: false }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });
});

describe('decideAgentSessionAccess — global-assistant sessions', () => {
  it('allows only the owner — no drive to share through', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'owner-1', session: globalSession, driveMembership: null, canRunCode: true }),
    ).toEqual({ allowed: true });
    expect(
      decideAgentSessionAccess({ requesterId: 'user-2', session: globalSession, driveMembership: null, canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'global_assistant_not_owner' });
  });

  it('still gates the owner on the capability', () => {
    expect(
      decideAgentSessionAccess({ requesterId: 'owner-1', session: globalSession, driveMembership: null, canRunCode: false }),
    ).toEqual({ allowed: false, reason: 'code_execution_denied' });
  });
});

describe('decideAgentSessionAccess — degenerate input', () => {
  it('denies an empty requester before anything else', () => {
    expect(
      decideAgentSessionAccess({ requesterId: '', session: driveSession, driveMembership: 'owner', canRunCode: true }),
    ).toEqual({ allowed: false, reason: 'invalid_requester' });
  });
});

describe('decideAgentSessionEndAccess', () => {
  it('lets a member end without the capability — ending is release of compute', () => {
    // An actor who just LOST canRunCode must still be able to stop paying.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'member' }),
    ).toEqual({ allowed: true });
  });

  it('lets the OWNER end even after losing the drive — same principle, scope gate', () => {
    // Use is gone (the main decision denies), but the power to stop paying is not.
    expect(
      decideAgentSessionEndAccess({ requesterId: 'owner-1', session: driveSession, driveMembership: 'none' }),
    ).toEqual({ allowed: true });
  });

  it("still refuses a non-member non-owner — releasing someone else's compute is touching their session", () => {
    expect(
      decideAgentSessionEndAccess({ requesterId: 'user-2', session: driveSession, driveMembership: 'none' }),
    ).toEqual({ allowed: false, reason: 'drive_access_denied' });
  });

  it('refuses an empty requester — the owner short-circuit must not bypass the degenerate gate', () => {
    expect(
      decideAgentSessionEndAccess({ requesterId: '', session: { ...driveSession, ownerId: '' }, driveMembership: 'owner' }),
    ).toEqual({ allowed: false, reason: 'invalid_requester' });
  });
});
