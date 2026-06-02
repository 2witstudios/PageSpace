import { describe, it, expect } from 'vitest';
import { mapPolicyToSandboxOptions } from '../sandbox-options';
import {
  resolveExecutionPolicy,
  SAFE_MINIMUM_PROFILE,
  type ExecutionPolicy,
} from '../execution-policy';

describe('mapPolicyToSandboxOptions', () => {
  it('given the default policy, should map every bound onto sandbox create options', () => {
    const policy = resolveExecutionPolicy({ profile: 'default' });
    const options = mapPolicyToSandboxOptions({ policy });
    expect(options).toEqual({
      timeoutMs: policy.timeoutMs,
      vcpus: policy.vcpus,
      memoryMb: policy.memoryMb,
      storageGb: policy.storageGb,
      persistent: policy.persistent,
      region: policy.region,
      egressAllowlist: policy.egressAllowlist,
    });
  });

  it('given the default policy, should carry through an explicit storage cap', () => {
    const policy = resolveExecutionPolicy({ profile: 'default' });
    expect(mapPolicyToSandboxOptions({ policy }).storageGb).toBe(policy.storageGb);
    expect(mapPolicyToSandboxOptions({ policy }).storageGb).toBeGreaterThan(0);
  });

  it('given any v1 policy, should carry through an empty (default-deny) egress allowlist', () => {
    expect(mapPolicyToSandboxOptions({ policy: resolveExecutionPolicy() }).egressAllowlist).toEqual(
      [],
    );
  });

  it('given the safe-minimum policy, should map its more restrictive bounds', () => {
    const options = mapPolicyToSandboxOptions({ policy: SAFE_MINIMUM_PROFILE });
    expect(options.timeoutMs).toBe(SAFE_MINIMUM_PROFILE.timeoutMs);
    expect(options.vcpus).toBe(SAFE_MINIMUM_PROFILE.vcpus);
    expect(options.memoryMb).toBe(SAFE_MINIMUM_PROFILE.memoryMb);
  });

  it('given any policy, should never enable persistence in v1 (ephemeral by default)', () => {
    const options = mapPolicyToSandboxOptions({ policy: resolveExecutionPolicy() });
    expect(options.persistent).toBe(false);
  });

  it('given an explicit region in the policy, should carry it through unchanged', () => {
    const policy: ExecutionPolicy = { ...SAFE_MINIMUM_PROFILE, region: 'iad' };
    expect(mapPolicyToSandboxOptions({ policy }).region).toBe('iad');
  });

  it('given no policy, should fall back to the safe-minimum bounds (SDA default)', () => {
    const options = mapPolicyToSandboxOptions();
    expect(options.timeoutMs).toBe(SAFE_MINIMUM_PROFILE.timeoutMs);
    expect(options.persistent).toBe(false);
  });
});
