import { describe, it } from 'vitest';

// Threat model A5, B-13 (ASI07). The database is the single-use ledger.

describe('adversarial: replay-across-replicas', () => {
  it.todo('given one grant presented to two verifier replicas concurrently, should consume the nonce exactly once (one ok, one replayed)');
  it.todo('given a grant presented, a process restart, and the same grant presented again, should return replayed');
  it.todo('given a grant failing bad_signature, should leave the nonce unconsumed and a later valid presentation should succeed');
  it.todo('given the replay store unreachable, should return replay_store_unavailable and not act');
  it.todo('given a captured grant raced against the legitimate presenter, should succeed only for the presenter whose key signs the use (presenter binding)');
});
