import { describe, it, expect } from 'vitest';
import { afterEach } from 'vitest';
import {
  parseContainmentProbe,
  assessContainment,
  decideFullEgressEnablement,
  isContainmentVerified,
  REQUIRED_CONTAINMENT_TARGETS,
  type RawProbe,
  type ProbeResult,
} from '../containment';

const allUnreachable = (): ProbeResult[] =>
  REQUIRED_CONTAINMENT_TARGETS.map((target) => ({ target, reachable: false }));

const base: RawProbe = { target: '_api.internal:4280', exitCode: 0 };

describe('parseContainmentProbe', () => {
  it('given an exitCode 0 connect, should mark the target reachable', () => {
    expect(parseContainmentProbe({ ...base, exitCode: 0 })).toEqual({
      target: '_api.internal:4280',
      reachable: true,
    });
  });

  it('given output containing an HTTP status line, should mark reachable even on a non-zero exit', () => {
    expect(
      parseContainmentProbe({
        target: '169.254.169.254',
        exitCode: 22, // curl --fail on 4xx
        stdout: 'HTTP/1.1 401 Unauthorized',
      }).reachable,
    ).toBe(true);
  });

  it('given a connection refused, should mark the target NOT reachable', () => {
    expect(
      parseContainmentProbe({
        target: '_api.internal:4280',
        exitCode: 7,
        stderr: 'curl: (7) Failed to connect: Connection refused',
      }).reachable,
    ).toBe(false);
  });

  it('given a DNS resolution failure, should mark the target NOT reachable', () => {
    expect(
      parseContainmentProbe({
        target: 'flycast',
        exitCode: 6,
        stderr: 'curl: (6) Could not resolve host',
      }).reachable,
    ).toBe(false);
  });

  it('given a timeout, should mark the target NOT reachable', () => {
    expect(
      parseContainmentProbe({
        target: 'tigris',
        exitCode: 28,
        stderr: 'curl: (28) Connection timed out after 5000 ms',
      }).reachable,
    ).toBe(false);
  });

  it('given a "no route to host" error, should mark the target NOT reachable', () => {
    expect(
      parseContainmentProbe({
        target: '6pn-peer',
        exitCode: 7,
        stderr: 'connect: No route to host',
      }).reachable,
    ).toBe(false);
  });

  it('given a non-zero exit with NO recognizable signature, should fail-closed (reachable: true)', () => {
    // An unparseable failure is NOT proof of containment.
    expect(
      parseContainmentProbe({ target: 'tigris', exitCode: 1, stderr: 'weird' }).reachable,
    ).toBe(true);
  });

  it('given malformed input (no numeric exitCode), should fail-closed (reachable: true)', () => {
    expect(
      parseContainmentProbe({ target: 'tigris', exitCode: NaN }).reachable,
    ).toBe(true);
    expect(
      parseContainmentProbe({ exitCode: undefined as unknown as number, target: 'x' }).reachable,
    ).toBe(true);
  });

  it('given an empty target, should fail-closed (reachable: true)', () => {
    expect(parseContainmentProbe({ target: '', exitCode: 0 }).reachable).toBe(true);
  });
});

describe('assessContainment', () => {
  it('given every required target unreachable, should be contained with no breaches', () => {
    expect(assessContainment(allUnreachable())).toEqual({ contained: true, breaches: [] });
  });

  it('given a reachable internal target, should NOT be contained and name it as a breach', () => {
    const results = allUnreachable().map((r) =>
      r.target === '_api.internal:4280' ? { ...r, reachable: true } : r,
    );
    const verdict = assessContainment(results);
    expect(verdict.contained).toBe(false);
    expect(verdict.breaches).toContain('_api.internal:4280');
  });

  it('given a required target MISSING from the evidence, should NOT be contained (absence ≠ proof)', () => {
    const partial = allUnreachable().filter((r) => r.target !== 'tigris');
    const verdict = assessContainment(partial);
    expect(verdict.contained).toBe(false);
    expect(verdict.breaches).toContain('tigris');
  });

  it('given no evidence at all, should breach on every required target', () => {
    const verdict = assessContainment([]);
    expect(verdict.contained).toBe(false);
    expect(verdict.breaches).toEqual([...REQUIRED_CONTAINMENT_TARGETS]);
  });
});

describe('decideFullEgressEnablement', () => {
  it('given the admin gate is off, should deny regardless of containment (gate precedence)', () => {
    expect(
      decideFullEgressEnablement({ adminGateEnabled: false, containment: { contained: true } }),
    ).toEqual({ ok: false, reason: 'code_execution_disabled' });
  });

  it('given the gate on but containment unverified (null), should refuse with containment_unverified', () => {
    expect(
      decideFullEgressEnablement({ adminGateEnabled: true, containment: null }),
    ).toEqual({ ok: false, reason: 'containment_unverified' });
  });

  it('given the gate on but containment breached, should refuse with containment_unverified', () => {
    expect(
      decideFullEgressEnablement({ adminGateEnabled: true, containment: { contained: false } }),
    ).toEqual({ ok: false, reason: 'containment_unverified' });
  });

  it('given the gate on and containment verified, should allow', () => {
    expect(
      decideFullEgressEnablement({ adminGateEnabled: true, containment: { contained: true } }),
    ).toEqual({ ok: true });
  });
});

describe('isContainmentVerified', () => {
  const prev = process.env.SANDBOX_CONTAINMENT_VERIFIED;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_CONTAINMENT_VERIFIED;
    else process.env.SANDBOX_CONTAINMENT_VERIFIED = prev;
  });

  it('is false (fail-closed) when the env flag is unset', () => {
    delete process.env.SANDBOX_CONTAINMENT_VERIFIED;
    expect(isContainmentVerified()).toBe(false);
  });

  it('is false for any value other than the exact string "true"', () => {
    process.env.SANDBOX_CONTAINMENT_VERIFIED = '1';
    expect(isContainmentVerified()).toBe(false);
    process.env.SANDBOX_CONTAINMENT_VERIFIED = 'TRUE';
    expect(isContainmentVerified()).toBe(false);
  });

  it('is true only for the exact opt-in string "true"', () => {
    process.env.SANDBOX_CONTAINMENT_VERIFIED = 'true';
    expect(isContainmentVerified()).toBe(true);
  });
});
