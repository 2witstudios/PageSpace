import { describe, it, expect } from 'vitest';
import { stampColumns, revivedAgentSessionColumns } from '../agent-sessions-store';
import { NOW } from './fakes';

/**
 * The two pure halves of the store: how a lifecycle verdict's stamps become
 * columns, and what recording a live Sprite writes. Both exist so that no call
 * site re-derives "which columns does this verdict touch" — the mistake that
 * lets a row end up carrying a new identity with the previous generation's
 * teardown marks still on it.
 */
describe('stampColumns', () => {
  it('given no stamps, should write nothing — an empty verdict must not clobber columns', () => {
    expect(stampColumns({})).toEqual({});
  });

  it('given an explicit null, should CLEAR the column', () => {
    expect(stampColumns({ endedAt: null })).toEqual({ endedAt: null });
  });

  it('should distinguish "clear it" from "leave it alone"', () => {
    // The whole encoding: absent ≠ null. Spreading the stamps object wholesale is
    // what would collapse these two into one.
    const cleared = stampColumns({ teardownRequestedAt: null });
    expect(cleared).toHaveProperty('teardownRequestedAt');
    expect(cleared).not.toHaveProperty('spriteTornDownAt');
  });

  it('given a full revive verdict, should carry every column it names', () => {
    expect(
      stampColumns({
        lastActiveAt: NOW,
        endedAt: null,
        teardownRequestedAt: null,
        spriteTornDownAt: null,
        storageMeasuredBytes: null,
        storageMeasuredAt: null,
      }),
    ).toEqual({
      lastActiveAt: NOW,
      endedAt: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });
  });

  it('given a teardown verdict, should carry its three stamps and nothing else', () => {
    expect(stampColumns({ teardownRequestedAt: NOW, spriteTornDownAt: NOW, endedAt: NOW })).toEqual({
      teardownRequestedAt: NOW,
      spriteTornDownAt: NOW,
      endedAt: NOW,
    });
  });
});

describe('revivedAgentSessionColumns', () => {
  const base = {
    sessionKey: 'pgs-ses-new',
    sandboxId: 'pgs-ses-new',
    spriteInstanceId: 'inst-new',
    egressPolicyToken: 'tok',
    now: NOW,
  };

  it('should record the new Sprite identity', () => {
    const columns = revivedAgentSessionColumns({ ...base, stamps: {} });
    expect(columns.sessionKey).toBe('pgs-ses-new');
    expect(columns.sandboxId).toBe('pgs-ses-new');
    expect(columns.spriteInstanceId).toBe('inst-new');
    expect(columns.egressPolicyToken).toBe('tok');
    expect(columns.updatedAt).toEqual(NOW);
  });

  it('should RESTART the storage accounting period — a new VM is a new, empty disk', () => {
    // Not a lifecycle stamp, which is why it lives here: billing the elapsed
    // window against the dead generation's measured size would charge for a
    // filesystem that no longer exists.
    const columns = revivedAgentSessionColumns({ ...base, stamps: {} });
    expect(columns.storageLastBilledAt).toEqual(NOW);
  });

  it('should apply the verdict\'s stamps alongside the identity, in ONE write', () => {
    const columns = revivedAgentSessionColumns({
      ...base,
      stamps: { lastActiveAt: NOW, endedAt: null, teardownRequestedAt: null, spriteTornDownAt: null },
    });
    expect(columns).toMatchObject({
      sandboxId: 'pgs-ses-new',
      lastActiveAt: NOW,
      endedAt: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
    });
  });

  it('should carry a null spriteInstanceId through (the driver could not report one)', () => {
    expect(revivedAgentSessionColumns({ ...base, spriteInstanceId: null, stamps: {} }).spriteInstanceId).toBeNull();
  });
});
