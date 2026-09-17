/**
 * ADR 0007 Decisions 3/7/8 — the claim ceremony decisions, in the shape of
 * decideDevicePoll / decideDeviceApproval (code-lifecycle.ts). A claim mints
 * for the AGENT; approval links a HUMAN owner. The human-only rule and
 * already_claimed are mutation-checked.
 */
import { describe, it, expect } from 'vitest';
import {
  decideClaimPoll,
  decideClaimApproval,
  CLAIM_TTL_SECONDS,
  CLAIM_POLL_INTERVAL_SECONDS,
  type ClaimRecord,
  type Claimer,
} from '../claim-decision';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const HUMAN: Claimer = { userId: 'human-1', accountType: 'human' };
const AGENT_CLAIMER: Claimer = { userId: 'agent-2', accountType: 'agent' };

function pending(overrides: Partial<Extract<ClaimRecord, { status: 'pending' }>> = {}): ClaimRecord {
  return {
    status: 'pending',
    agentUserId: 'agent-1',
    agentOwnerUserId: null,
    expiresAt: new Date(NOW.getTime() + 900_000),
    lastPolledAt: null,
    pollIntervalSeconds: 5,
    ...overrides,
  };
}

describe('policy constants', () => {
  it('claims live 15 minutes and poll every 5 seconds (RFC 8628 vocabulary)', () => {
    expect(CLAIM_TTL_SECONDS).toBe(900);
    expect(CLAIM_POLL_INTERVAL_SECONDS).toBe(5);
  });
});

describe('decideClaimPoll', () => {
  it('returns authorization_pending on the very first poll of a pending claim', () => {
    expect(decideClaimPoll(pending(), NOW)).toEqual({ status: 'authorization_pending' });
  });

  it('returns slow_down when polled strictly faster than pollIntervalSeconds', () => {
    const rec = pending({ lastPolledAt: new Date(NOW.getTime() - 4_999) });
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'slow_down' });
  });

  it('allows a poll exactly at the interval (only strictly-less-than throttles)', () => {
    const rec = pending({ lastPolledAt: new Date(NOW.getTime() - 5_000) });
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'authorization_pending' });
  });

  it('returns expired_token at and after expiry', () => {
    expect(decideClaimPoll(pending({ expiresAt: NOW }), NOW)).toEqual({ status: 'expired_token' });
    expect(decideClaimPoll(pending({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toEqual({
      status: 'expired_token',
    });
  });

  it('returns access_denied for a denied claim', () => {
    const rec: ClaimRecord = { ...pending(), status: 'denied' };
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'access_denied' });
  });

  it('returns ok with the agent + owner grant for an approved claim, ignoring the poll throttle', () => {
    const rec: ClaimRecord = {
      ...pending({ lastPolledAt: new Date(NOW.getTime() - 1), agentOwnerUserId: 'human-1' }),
      status: 'approved',
      ownerUserId: 'human-1',
    };
    expect(decideClaimPoll(rec, NOW)).toEqual({
      status: 'ok',
      grant: { agentUserId: 'agent-1', ownerUserId: 'human-1' },
    });
  });

  it('returns access_denied when the approving owner has since unlinked (current owner null) — never a stale grant', () => {
    const rec: ClaimRecord = {
      ...pending({ agentOwnerUserId: null }),
      status: 'approved',
      ownerUserId: 'human-1',
    };
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'access_denied' });
  });

  it('returns access_denied when the current owner differs from the approving owner', () => {
    const rec: ClaimRecord = {
      ...pending({ agentOwnerUserId: 'human-9' }),
      status: 'approved',
      ownerUserId: 'human-1',
    };
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'access_denied' });
  });

  it('returns ok only when the approving owner is still the CURRENT owner', () => {
    const rec: ClaimRecord = {
      ...pending({ agentOwnerUserId: 'human-1' }),
      status: 'approved',
      ownerUserId: 'human-1',
    };
    expect(decideClaimPoll(rec, NOW).status).toBe('ok');
  });

  it('returns already_redeemed for a claim whose grant was exchanged, even after expiry', () => {
    const rec: ClaimRecord = { ...pending({ expiresAt: new Date(NOW.getTime() - 1) }), status: 'redeemed' };
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'already_redeemed' });
  });

  it('expiry beats a settled denial (an expired claim is dead whatever happened to it)', () => {
    const rec: ClaimRecord = { ...pending({ expiresAt: NOW }), status: 'denied' };
    expect(decideClaimPoll(rec, NOW)).toEqual({ status: 'expired_token' });
  });
});

describe('decideClaimApproval', () => {
  it('approves a pending, unexpired claim for a human claimer, stamping the owner and time', () => {
    expect(decideClaimApproval(pending(), 'approve', HUMAN, NOW)).toEqual({
      status: 'approved',
      agentUserId: 'agent-1',
      ownerUserId: 'human-1',
      approvedAt: NOW,
    });
  });

  it('denies a pending claim on deny, stamping the time', () => {
    expect(decideClaimApproval(pending(), 'deny', HUMAN, NOW)).toEqual({ status: 'denied', deniedAt: NOW });
  });

  it('refuses a non-human claimer with not_human (an agent cannot own an agent)', () => {
    expect(decideClaimApproval(pending(), 'approve', AGENT_CLAIMER, NOW)).toEqual({ status: 'not_human' });
  });

  it('refuses a non-human claimer even on deny, and before every other check', () => {
    expect(decideClaimApproval(pending(), 'deny', AGENT_CLAIMER, NOW)).toEqual({ status: 'not_human' });
    const settledClaimed: ClaimRecord = {
      ...pending({ agentOwnerUserId: 'human-9', expiresAt: NOW }),
      status: 'denied',
    };
    expect(decideClaimApproval(settledClaimed, 'approve', AGENT_CLAIMER, NOW)).toEqual({ status: 'not_human' });
  });

  it('returns already_claimed when the agent already has an owner, naming that owner', () => {
    expect(decideClaimApproval(pending({ agentOwnerUserId: 'human-9' }), 'approve', HUMAN, NOW)).toEqual({
      status: 'already_claimed',
      ownerUserId: 'human-9',
    });
  });

  it('already_claimed wins over a settled record and over expiry', () => {
    const rec: ClaimRecord = {
      ...pending({ agentOwnerUserId: 'human-9', expiresAt: NOW }),
      status: 'approved',
      ownerUserId: 'human-9',
    };
    expect(decideClaimApproval(rec, 'approve', HUMAN, NOW)).toEqual({ status: 'already_claimed', ownerUserId: 'human-9' });
  });

  it('returns already_settled for a settled record whose agent is (still) unowned', () => {
    const denied: ClaimRecord = { ...pending(), status: 'denied' };
    expect(decideClaimApproval(denied, 'approve', HUMAN, NOW)).toEqual({
      status: 'already_settled',
      existingStatus: 'denied',
    });
    const redeemed: ClaimRecord = { ...pending(), status: 'redeemed' };
    expect(decideClaimApproval(redeemed, 'deny', HUMAN, NOW)).toEqual({
      status: 'already_settled',
      existingStatus: 'redeemed',
    });
  });

  it('a settled record wins over expiry', () => {
    const rec: ClaimRecord = { ...pending({ expiresAt: NOW }), status: 'denied' };
    expect(decideClaimApproval(rec, 'approve', HUMAN, NOW)).toEqual({
      status: 'already_settled',
      existingStatus: 'denied',
    });
  });

  it('fails closed exactly at expiry for a pending record', () => {
    expect(decideClaimApproval(pending({ expiresAt: NOW }), 'approve', HUMAN, NOW)).toEqual({ status: 'expired' });
    expect(decideClaimApproval(pending({ expiresAt: NOW }), 'deny', HUMAN, NOW)).toEqual({ status: 'expired' });
  });

  it('approves one millisecond before expiry', () => {
    const rec = pending({ expiresAt: new Date(NOW.getTime() + 1) });
    expect(decideClaimApproval(rec, 'approve', HUMAN, NOW).status).toBe('approved');
  });
});
