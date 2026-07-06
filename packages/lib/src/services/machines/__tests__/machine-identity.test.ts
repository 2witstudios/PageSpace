import { describe, it, expect } from 'vitest';
import { deriveMachineKey } from '../machine-identity';

describe('deriveMachineKey', () => {
  it('given an own machine, should key by owner', () => {
    expect(deriveMachineKey({ kind: 'own', ownerId: 'user-1' })).toBe('own:user-1');
  });

  it('given an existing machine, should key by terminal id', () => {
    expect(deriveMachineKey({ kind: 'existing', terminalId: 'page-1' })).toBe('existing:page-1');
  });

  it('given two different owners, should derive different keys', () => {
    expect(deriveMachineKey({ kind: 'own', ownerId: 'user-1' })).not.toBe(
      deriveMachineKey({ kind: 'own', ownerId: 'user-2' }),
    );
  });

  it('given an own and an existing machine, should never collide even with matching ids', () => {
    // Same raw id used for both variants — the kind-prefixed namespace must
    // still keep them distinct.
    expect(deriveMachineKey({ kind: 'own', ownerId: 'shared-id' })).not.toBe(
      deriveMachineKey({ kind: 'existing', terminalId: 'shared-id' }),
    );
  });
});
