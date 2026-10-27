/**
 * L2·G2 review (Codex P1) — the advertised limits of a standing
 * generic-request permission are enforced. `decidePolicyUsage` reads the
 * policy from the PLANE's stored scope (a main-DB writer can neither raise the
 * limits nor reset the counts) and the plane's usage ledger, and reports
 * whether the policy still covers one more use: not expired, fewer uses this
 * hour than the cap, fewer in flight than the concurrency cap, and the bytes
 * this request sends still within the hourly byte cap.
 */
import { describe, expect, it } from 'vitest';
import { decidePolicyUsage } from '../decide-policy-usage';

const NOW = 1_800_000_000_000;
const policy = { scope: { origins: [], operations: [], resources: [] }, trigger: 'irreversible_only', duration: null, limits: { maxUsesPerHour: 60, maxBytesOut: 1_000, maxConcurrent: 4 }, approver: 'u1' };
const idle = { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 };

describe('decidePolicyUsage', () => {
  it('given usage under every cap, should cover the use', () => {
    const actual = decidePolicyUsage({ policy, usage: { usesThisHour: 59, bytesOutThisHour: 900, concurrent: 3 }, requestBytes: 100, now: NOW });
    const expected = { expired: false, limitsExceeded: false };
    expect(actual).toEqual(expected);
  });

  it('given the hourly use cap, the concurrency cap, or bytes that would pass the byte cap, should report limits exceeded', () => {
    const actual = [
      decidePolicyUsage({ policy, usage: { ...idle, usesThisHour: 60 }, requestBytes: 0, now: NOW }),
      decidePolicyUsage({ policy, usage: { ...idle, concurrent: 4 }, requestBytes: 0, now: NOW }),
      decidePolicyUsage({ policy, usage: { ...idle, bytesOutThisHour: 950 }, requestBytes: 51, now: NOW }),
    ].map((verdict) => verdict.limitsExceeded);
    const expected = [true, true, true];
    expect(actual).toEqual(expected);
  });

  it('given a policy past its deadline, missing, or not policy-shaped, should report it expired', () => {
    const actual = [
      decidePolicyUsage({ policy: { ...policy, duration: { until: NOW } }, usage: idle, requestBytes: 0, now: NOW }).expired,
      decidePolicyUsage({ policy: null, usage: idle, requestBytes: 0, now: NOW }).expired,
      decidePolicyUsage({ policy: { scope: {} }, usage: idle, requestBytes: 0, now: NOW }).expired,
    ];
    const expected = [true, true, true];
    expect(actual).toEqual(expected);
  });

  it('given limits that are not finite numbers, should report limits exceeded — a malformed cap never means unlimited', () => {
    const actual = decidePolicyUsage({ policy: { ...policy, limits: { maxUsesPerHour: 'lots', maxBytesOut: 1, maxConcurrent: 1 } }, usage: idle, requestBytes: 0, now: NOW }).limitsExceeded;
    const expected = true;
    expect(actual).toEqual(expected);
  });
});
