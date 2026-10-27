import { describe, it, expect } from 'vitest';
import { parseMachinePolicy, parseServerPolicy, DEFAULT_MAX_BYTES, DEFAULT_MAX_TIMEOUT_MS } from '../policy-types';

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
    ['the filesystem root / (confinement would be vacuous)', { ...VALID, roots: ['/'] }],
    ['a root containing a .. segment', { ...VALID, roots: ['/home/u/../etc'] }],
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

describe('parseServerPolicy — the stored serverPolicy jsonb, trusted only when fully recognized', () => {
  it('given a well-formed policy, should return it', () => {
    expect(parseServerPolicy({ ops: ['exec', 'fs_read'], checkpoint: false })).toEqual({ ops: ['exec', 'fs_read'], checkpoint: false });
  });

  it('given the deny-all backstop, should return it (an empty op set is valid; decideSign is what denies on it)', () => {
    expect(parseServerPolicy({ ops: [], checkpoint: false })).toEqual({ ops: [], checkpoint: false });
  });

  it.each([
    ['an op outside the closed union', { ops: ['exec', 'rm_rf'], checkpoint: false }],
    ['a missing checkpoint', { ops: ['exec'] }],
    ['a missing ops', { checkpoint: false }],
    ['a stray field', { ops: ['exec'], checkpoint: false, roots: ['/'] }],
    ['a non-object', 'exec'],
    ['null', null],
    ['ops as a string', { ops: 'exec', checkpoint: false }],
  ])('given %s, should return null — drift can only make the server more restrictive', (_label, input) => {
    expect(parseServerPolicy(input)).toBeNull();
  });
});
