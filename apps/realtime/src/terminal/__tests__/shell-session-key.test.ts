import { describe, it } from 'vitest';
import { assert } from './riteway';
import { deriveShellSessionKey } from '../shell-session-key';

describe('deriveShellSessionKey', () => {
  it('derives a stable key with zero I/O from the shellId alone', () => {
    assert({
      given: 'a shell id',
      should: 'encode the shellId into the key with no other component',
      actual: deriveShellSessionKey({ shellId: 'shl-1' }),
      expected: 'shell:shl-1',
    });
  });

  it('is deterministic across repeated derivation (warm reattach)', () => {
    const params = { shellId: 'shl-1' };
    assert({
      given: 'the same shell reopened across connects',
      should: 'produce an identical key each time',
      actual: deriveShellSessionKey(params) === deriveShellSessionKey(params),
      expected: true,
    });
  });

  it('produces distinct keys for distinct shellIds', () => {
    assert({
      given: 'two different shells',
      should: 'produce distinct keys',
      actual: deriveShellSessionKey({ shellId: 'a' }) !== deriveShellSessionKey({ shellId: 'b' }),
      expected: true,
    });
  });

  it('cannot collide with a legacy machine-tuple key even for adversarial ids', () => {
    // Legacy keys have the shape `<machineId>:agent:<scope>:<name>` with every
    // component URI-escaped — so a shellId CONTAINING ':agent:' must still be
    // escaped into a key no legacy derivation can produce.
    const key = deriveShellSessionKey({ shellId: 'm:agent:machine:shell' });
    assert({
      given: 'a shellId spelled like a legacy compound key',
      should: 'escape the separators so the two namespaces cannot collide',
      actual: key,
      expected: `shell:${encodeURIComponent('m:agent:machine:shell')}`,
    });
  });
});
