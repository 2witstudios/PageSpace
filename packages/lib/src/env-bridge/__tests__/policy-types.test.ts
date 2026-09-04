import { describe, it, expect } from 'vitest';
import { parseMachinePolicy, DEFAULT_MAX_BYTES, DEFAULT_MAX_TIMEOUT_MS } from '../policy-types';

const VALID = {
  mode: 'allowlist',
  principals: ['user_1'],
  ops: ['exec', 'fs_read'],
  roots: ['/home/u/proj'],
  envAllowlist: ['LANG'],
  maxBytes: 1024,
  maxTimeoutMs: 30_000,
};

describe('parseMachinePolicy — the daemon policy file, parsed without trust (invariant 5)', () => {
  it('given a valid policy, should return it typed', () => {
    expect(parseMachinePolicy(VALID)).toEqual(VALID);
  });

  it('given maxBytes / maxTimeoutMs omitted, should apply the documented defaults', () => {
    const { maxBytes: _b, maxTimeoutMs: _t, ...rest } = VALID;
    expect(parseMachinePolicy(rest)).toEqual({ ...rest, maxBytes: DEFAULT_MAX_BYTES, maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'allow everything'],
    ['an array', []],
    ['an unknown mode', { ...VALID, mode: 'yolo' }],
    ['an op outside the closed union', { ...VALID, ops: ['exec', 'rm_rf'] }],
    ['a relative root', { ...VALID, roots: ['proj'] }],
    ['an empty root', { ...VALID, roots: [''] }],
    ['a non-array principals', { ...VALID, principals: 'user_1' }],
    ['a negative maxBytes', { ...VALID, maxBytes: -1 }],
    ['a zero maxTimeoutMs', { ...VALID, maxTimeoutMs: 0 }],
    ['an extra field', { ...VALID, allowEverything: true }],
    ['an env allowlist entry that is not a valid variable name', { ...VALID, envAllowlist: ['LD_PRELOAD=1'] }],
  ])('given %s, should return null (a missing or invalid policy is deny-all) and never throw', (_label, input) => {
    expect(() => parseMachinePolicy(input)).not.toThrow();
    expect(parseMachinePolicy(input)).toBeNull();
  });

  it('given mode deny with no principals/ops/roots, should still parse (deny-all is a legal explicit policy)', () => {
    expect(parseMachinePolicy({ mode: 'deny', principals: [], ops: [], roots: [], envAllowlist: [] })).not.toBeNull();
  });
});
