/**
 * GA wave 2 — the server-side memory of a machine's `ask_pending` answer:
 * what re-issuing the identical request needs, under the machine's id, for as
 * long as the machine itself holds it. Bounded, TTL'd, consumed once.
 */
import { describe, it, expect } from 'vitest';
import { createPendingApprovalStore, type PendingEnvApproval } from '../pending-approvals';

const NOW = 1_800_000_000_000;
const entry = (over: Partial<PendingEnvApproval> = {}): PendingEnvApproval => ({
  challengeId: 'ch_1',
  envId: 'env_1',
  frame: { type: 'grant_exec', cmd: 'sh', args: ['-c', 'git status'] },
  principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' },
  expiresAt: NOW + 30_000,
  pending: { challengeId: 'ch_1', expiresAt: NOW + 30_000, request: { op: 'exec', cmd: 'sh', args: ['-c', 'git status'], cwd: '/p', paths: [], env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false } },
  createdAt: NOW,
  ...over,
});

describe('pending approvals (server side)', () => {
  it('remembers under the machine\'s id, hands it back until taken, then forgets', () => {
    const s = createPendingApprovalStore();
    expect(s.remember(entry(), NOW)).toBe(true);
    expect(s.get('ch_1', NOW)).toMatchObject({ envId: 'env_1' });
    expect(s.take('ch_1', NOW)).toMatchObject({ envId: 'env_1' });
    expect(s.get('ch_1', NOW)).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it('refuses an already-expired entry and evicts on the machine\'s TTL (the grant exp)', () => {
    const s = createPendingApprovalStore();
    expect(s.remember(entry({ expiresAt: NOW - 1 }), NOW)).toBe(false);
    s.remember(entry(), NOW);
    expect(s.get('ch_1', NOW + 30_000)).toBeDefined();
    expect(s.get('ch_1', NOW + 30_001)).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it('is bounded: a full store refuses to remember rather than evicting a live question; a repeat of a remembered id is a no-op', () => {
    const s = createPendingApprovalStore(2);
    expect(s.remember(entry({ challengeId: 'a' }), NOW)).toBe(true);
    expect(s.remember(entry({ challengeId: 'b' }), NOW)).toBe(true);
    expect(s.remember(entry({ challengeId: 'c' }), NOW)).toBe(false);
    expect(s.remember(entry({ challengeId: 'a', envId: 'env_other' }), NOW)).toBe(true);
    expect(s.get('a', NOW)?.envId).toBe('env_1');
    expect(s.size()).toBe(2);
  });
});
