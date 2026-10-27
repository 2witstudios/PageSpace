import { describe, it, expect } from 'vitest';
import { decideReplay } from '../../decide-replay';
import { decideRetry } from '../../decide-retry';

// Threat model A5, B-13 (ASI07). The database is the single-use ledger.
// The pure rows live here; the rows that need the real ledger run in
// `replay-across-replicas.integration.test.ts` beside this file (same
// harness, DB-backed file naming per vitest.config exclude).

const NOW = 1_800_000_000_000;

describe('adversarial: replay-across-replicas', () => {
  it.todo('given one grant presented to two verifier replicas concurrently, should consume the nonce exactly once (one ok, one replayed) — DB row, see replay-across-replicas.integration.test.ts');
  it.todo('given a grant presented, a process restart, and the same grant presented again, should return replayed — DB row, see replay-across-replicas.integration.test.ts');
  it.todo('given a grant failing bad_signature, should leave the nonce unconsumed and a later valid presentation should succeed — verifyGrant + ledger row, lands with the grant gate (awaiting the amended pu/g1a-freeze shapes)');

  it('given the replay store unreachable, should decide replay_store_unavailable input (unknown) and never fresh', () => {
    const actual = decideReplay({ lookup: { ok: false }, now: NOW });
    expect(actual).toBe('unknown');
  });

  it('given a recorded nonce, should decide consumed regardless of whether the recorded grant has expired', () => {
    const actual = [
      decideReplay({ lookup: { ok: true, recorded: { grantId: 'g', expiresAt: NOW + 1, consumedAt: NOW } }, now: NOW }),
      decideReplay({ lookup: { ok: true, recorded: { grantId: 'g', expiresAt: NOW - 1, consumedAt: NOW - 10 } }, now: NOW }),
    ];
    expect(actual).toEqual(['consumed', 'consumed']);
  });

  it('given a timeout after a non-idempotent write was sent, should report unknown rather than re-present or re-issue automatically (replay ≠ idempotency)', () => {
    const actual = decideRetry({ operationClass: 'write', failure: { kind: 'timeout_after_send' }, attempt: 1, maxAttempts: 3 });
    expect(actual).toEqual({ action: 'report', outcome: { kind: 'unknown' } });
  });

  it.todo('given a captured grant raced against the legitimate presenter, should succeed only for the presenter whose key signs the use (presenter binding) — verifyGrant row, lands with the grant gate (awaiting the amended pu/g1a-freeze shapes)');
});
