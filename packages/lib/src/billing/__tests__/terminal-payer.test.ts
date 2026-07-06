import { describe, it, expect } from 'vitest';
import { resolveTerminalPayerId } from '../terminal-payer';

describe('resolveTerminalPayerId', () => {
  it('resolves the payer to the given tenantId (the drive owner by construction)', () => {
    expect(resolveTerminalPayerId({ tenantId: 'owner-1' })).toBe('owner-1');
  });

  it('is a pure passthrough — a single named seam, not inlined logic', () => {
    expect(resolveTerminalPayerId({ tenantId: 'a' })).not.toBe(resolveTerminalPayerId({ tenantId: 'b' }));
  });
});
