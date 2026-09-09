/**
 * GA wave 2, leaf 4 — the challenge store: a frozen request under an id whose
 * TTL is the grant's `exp`, bounded and evicted synchronously like the nonce
 * store, reusing the id for a repeat of the same subject.
 */
import { describe, expect, it } from 'vitest';
import type { Grant } from '@pagespace/lib/env-bridge/grant';
import type { NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { createChallengeStore, MAX_PENDING_CHALLENGES } from '../challenge-store.js';

const NOW = 1_800_000_000_000;
const grant = (over: Partial<Grant> = {}): Grant => ({ grantId: 'g1', envId: 'env_1', principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' }, op: 'exec', argsHash: 'h1', iat: NOW - 1000, exp: NOW + 30_000, nonce: 'n1', ...over });
const request: NormalizedRequest = { op: 'exec', cmd: 'git', args: ['status'], cwd: '/p', paths: [], env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false };

function store(max?: number) {
  let n = 0;
  return createChallengeStore({ newId: () => `ch_${++n}`, ...(max !== undefined && { max }) });
}

describe('issue / take', () => {
  it('given an ask, should freeze the request under a new id with TTL = the grant exp', () => {
    const s = store();
    const g = grant();
    const pending = s.issue({ grant: g, request, subjects: ['exec:/usr/bin/git'] }, NOW);
    expect(pending).toMatchObject({ id: 'ch_1', exp: NOW + 30_000, issuedAt: NOW, request, subjects: ['exec:/usr/bin/git'] });
    expect(pending!.grant).toBe(g);
    expect(s.size()).toBe(1);
    expect(s.peek('ch_1', NOW)).toBe(pending);
    expect(s.take('ch_1', NOW)).toBe(pending);
    expect(s.size()).toBe(0);
    expect(s.take('ch_1', NOW)).toBeUndefined();
  });

  it('given a second ask for the SAME subject while one is pending, should reuse the id and the FIRST frozen request, not grow the map', () => {
    const s = store();
    const first = s.issue({ grant: grant(), request, subjects: ['exec:/usr/bin/git'] }, NOW);
    const second = s.issue({ grant: grant({ grantId: 'g2', argsHash: 'h2', nonce: 'n2' }), request: { ...request, args: ['log'] }, subjects: ['exec:/usr/bin/git'] }, NOW + 1000);
    expect(second).toBe(first);
    expect(s.size()).toBe(1);
  });

  it('given a different subject, user or op, should issue a new id', () => {
    const s = store();
    s.issue({ grant: grant(), request, subjects: ['exec:/usr/bin/git'] }, NOW);
    expect(s.issue({ grant: grant(), request: { ...request, cmd: 'rm' }, subjects: ['exec:/bin/rm'] }, NOW)!.id).toBe('ch_2');
    expect(s.issue({ grant: grant({ principal: { userId: 'u2', sessionId: 's', conversationId: 'c' } }), request, subjects: ['exec:/usr/bin/git'] }, NOW)!.id).toBe('ch_3');
    expect(s.issue({ grant: grant({ op: 'fs_read' }), request: { ...request, op: 'fs_read' }, subjects: ['exec:/usr/bin/git'] }, NOW)!.id).toBe('ch_4');
    expect(s.size()).toBe(4);
  });

  it('given an unresolvable request (subjects null), should key the reuse on the exact args hash', () => {
    const s = store();
    const a = s.issue({ grant: grant({ argsHash: 'hA' }), request, subjects: null }, NOW);
    expect(s.issue({ grant: grant({ argsHash: 'hA' }), request, subjects: null }, NOW)).toBe(a);
    expect(s.issue({ grant: grant({ argsHash: 'hB' }), request, subjects: null }, NOW)!.id).toBe('ch_2');
  });
});

describe('expiry and bound — evicted synchronously like the nonce store', () => {
  it('given a challenge past its grant exp, should refuse to hand it back (expired challenge is refused) and forget it', () => {
    const s = store();
    s.issue({ grant: grant(), request, subjects: ['exec:/usr/bin/git'] }, NOW);
    expect(s.peek('ch_1', NOW + 30_000)).toBeDefined();
    expect(s.take('ch_1', NOW + 30_001)).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it('after an expired challenge is evicted, the same subject gets a NEW id', () => {
    const s = store();
    s.issue({ grant: grant(), request, subjects: ['exec:/usr/bin/git'] }, NOW);
    expect(s.issue({ grant: grant({ exp: NOW + 90_000 }), request, subjects: ['exec:/usr/bin/git'] }, NOW + 60_000)!.id).toBe('ch_2');
    expect(s.size()).toBe(1);
  });

  it('clear() (a verified STOP) should drop EVERY entry — live ones included — and free their reuse keys, reporting the count', () => {
    let n = 0;
    const s = createChallengeStore({ newId: () => `ch_${++n}` });
    const a = s.issue({ grant: grant(), request, subjects: ['exec:/a'] }, NOW);
    s.issue({ grant: grant({ grantId: 'g2', nonce: 'n2' }), request, subjects: ['exec:/b'] }, NOW);
    expect(s.size()).toBe(2);
    expect(s.clear()).toBe(2);
    expect(s.size()).toBe(0);
    expect(s.peek(a!.id, NOW)).toBeUndefined();
    // A re-issue after the clear is a NEW question, not the old id.
    expect(s.issue({ grant: grant(), request, subjects: ['exec:/a'] }, NOW)?.id).toBe('ch_3');
    expect(s.clear()).toBe(1);
  });

  it('evictExpired(now) should drop only the expired entries', () => {
    const s = store();
    s.issue({ grant: grant({ exp: NOW + 1000 }), request, subjects: ['a'] }, NOW);
    s.issue({ grant: grant({ exp: NOW + 60_000 }), request, subjects: ['b'] }, NOW);
    s.evictExpired(NOW + 2000);
    expect(s.size()).toBe(1);
    expect(s.peek('ch_2', NOW + 2000)).toBeDefined();
  });

  it('should hold at most MAX_PENDING_CHALLENGES live entries — a further ask is refused (null), never evicted early', () => {
    const s = store(3);
    for (let i = 0; i < 3; i += 1) expect(s.issue({ grant: grant(), request, subjects: [`s${i}`] }, NOW)).not.toBeNull();
    expect(s.issue({ grant: grant(), request, subjects: ['s99'] }, NOW)).toBeNull();
    expect(s.size()).toBe(3);
    // A repeat of a pending subject is still answered from the map when full.
    expect(s.issue({ grant: grant(), request, subjects: ['s0'] }, NOW)!.id).toBe('ch_1');
    expect(MAX_PENDING_CHALLENGES).toBe(64);
  });
});
