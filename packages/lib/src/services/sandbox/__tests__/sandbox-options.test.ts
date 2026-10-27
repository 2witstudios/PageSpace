import { describe, it, expect } from 'vitest';
import type { SandboxCreateOptions } from '../sandbox-options';
import { SANDBOX_EGRESS_ALLOWLIST } from '../execution-policy';

describe('SandboxCreateOptions', () => {
  it('should accept a valid options object with only egressAllowlist', () => {
    const options: SandboxCreateOptions = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };
    expect(options.egressAllowlist).toBe(SANDBOX_EGRESS_ALLOWLIST);
  });

  it('should accept an empty egressAllowlist for default-deny configurations', () => {
    const options: SandboxCreateOptions = { egressAllowlist: [] };
    expect(options.egressAllowlist).toHaveLength(0);
  });
});
