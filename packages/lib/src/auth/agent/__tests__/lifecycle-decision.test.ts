/**
 * ADR 0007 Decision 13 / [D-30] — an unclaimed agent that never authenticated
 * after signup is deleted after 30 days; anything else is kept.
 */
import { describe, it, expect } from 'vitest';
import { decideAgentLifecycle, AGENT_UNAUTHENTICATED_TTL_MS } from '../lifecycle-decision';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('decideAgentLifecycle', () => {
  it('the TTL is 30 days', () => {
    expect(AGENT_UNAUTHENTICATED_TTL_MS).toBe(30 * DAY);
  });

  it('deletes an unclaimed, never-authenticated agent exactly 30 days old', () => {
    const row = { ownerUserId: null, lastAuthAt: null, createdAt: new Date(NOW.getTime() - 30 * DAY) };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'delete' });
  });

  it('deletes one older than 30 days', () => {
    const row = { ownerUserId: null, lastAuthAt: null, createdAt: new Date(NOW.getTime() - 400 * DAY) };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'delete' });
  });

  it('keeps one a millisecond short of 30 days', () => {
    const row = { ownerUserId: null, lastAuthAt: null, createdAt: new Date(NOW.getTime() - 30 * DAY + 1) };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'keep' });
  });

  it('keeps a claimed agent forever, even if it never authenticated', () => {
    const row = { ownerUserId: 'human-1', lastAuthAt: null, createdAt: new Date(NOW.getTime() - 400 * DAY) };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'keep' });
  });

  it('keeps an agent that ever signed in, forever (no TTL)', () => {
    const row = {
      ownerUserId: null,
      lastAuthAt: new Date(NOW.getTime() - 399 * DAY),
      createdAt: new Date(NOW.getTime() - 400 * DAY),
    };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'keep' });
  });

  it('keeps a brand-new unclaimed agent', () => {
    const row = { ownerUserId: null, lastAuthAt: null, createdAt: NOW };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'keep' });
  });

  it('keeps a row whose createdAt is in the future (clock skew never deletes)', () => {
    const row = { ownerUserId: null, lastAuthAt: null, createdAt: new Date(NOW.getTime() + DAY) };
    expect(decideAgentLifecycle(row, NOW)).toEqual({ action: 'keep' });
  });
});
