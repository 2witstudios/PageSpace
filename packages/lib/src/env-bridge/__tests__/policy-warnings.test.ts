/**
 * `policyWarnings` (GA wave 3, leaf 7; Codex P1 on #2584): the pure decision
 * behind the daemon's loud lines. `exec` in an allowlist policy means every
 * exec grant runs WITHOUT the owner's click — the one edit that silently
 * removes Tier B — so it must be said, in one line, with the way back. The
 * wave 1 principals warning lives here too, so every surface prints the same
 * words.
 */
import { describe, it, expect } from 'vitest';
import { policyWarnings, EXEC_ALLOWLISTED_WARNING, type PolicyWarningInput } from '../policy-warnings';
import type { MachinePolicy } from '../policy-types';

const HOME = '/home/u';
// `roots` joined the input for A6, so every fixture carries an ordinary
// project root; the existing rows must keep saying exactly what they said.
const base: PolicyWarningInput = { mode: 'allowlist', ops: ['fs_read', 'fs_write'], principals: ['owner'], roots: [`${HOME}/proj`] };

describe('policyWarnings', () => {
  it('given mode allowlist with exec in ops, should warn exec_allowlisted naming the consequence (no click) and the way back (remove exec from ops)', () => {
    const warnings = policyWarnings({ ...base, ops: ['fs_read', 'exec'] });
    expect(warnings.map((w) => w.code)).toEqual(['exec_allowlisted']);
    expect(warnings[0]!.message).toBe(EXEC_ALLOWLISTED_WARNING);
    expect(warnings[0]!.message).toMatch(/without a click/);
    expect(warnings[0]!.message).toMatch(/remove exec from ops/);
  });

  const quiet: Array<[string, PolicyWarningInput]> = [
    ['ask mode with exec (every exec still asks)', { ...base, mode: 'ask', ops: ['exec'] }],
    ['deny mode with exec (nothing runs)', { ...base, mode: 'deny', ops: ['exec'] }],
    ['allowlist without exec (the scaffold)', { ...base, ops: ['fs_read', 'fs_write'] }],
    ['allowlist with no ops', { ...base, ops: [] }],
  ];
  it.each(quiet)('given %s, should say nothing', (_label, policy) => {
    expect(policyWarnings(policy)).toEqual([]);
  });

  it('given more than one principal, should carry the wave 1 [D-6] warning naming every principal', () => {
    const warnings = policyWarnings({ ...base, principals: ['owner', 'guest'] });
    expect(warnings.map((w) => w.code)).toEqual(['principals_widen_d6']);
    expect(warnings[0]!.message).toMatch(/^\[D-6\]/);
    expect(warnings[0]!.message).toContain('owner, guest');
    expect(policyWarnings({ ...base, principals: ['owner'] })).toEqual([]);
    expect(policyWarnings({ ...base, principals: [] })).toEqual([]);
  });

  it('given both, should carry both, principals first, one line each', () => {
    const warnings = policyWarnings({ mode: 'allowlist', ops: ['exec'], principals: ['a', 'b'], roots: [`${HOME}/proj`] });
    expect(warnings.map((w) => w.code)).toEqual(['principals_widen_d6', 'exec_allowlisted']);
    for (const warning of warnings) expect(warning.message).not.toContain('\n');
  });
});

describe('A6: root_is_home — enrolling from $HOME scopes an agent to .ssh and every project at once', () => {
  const withRoots = (roots: string[]) => policyWarnings({ ...base, roots }, { homedir: HOME });

  it('given a root that IS the home directory, should warn root_is_home, naming the consequence and the way to narrow it', () => {
    const warnings = withRoots([HOME]);
    expect(warnings.map((w) => w.code)).toEqual(['root_is_home']);
    expect(warnings[0]!.message).toContain(HOME);
    expect(warnings[0]!.message).toMatch(/\.ssh/);
    expect(warnings[0]!.message).toMatch(/roots/);
    expect(warnings[0]!.message).not.toContain('\n');
  });

  it.each([`${HOME}/`, '/home', '/'])('given the root %s (home itself with a trailing slash, or an ancestor of it), should warn the same way', (root) => {
    expect(withRoots([root]).map((w) => w.code)).toEqual(['root_is_home']);
  });

  it.each([`${HOME}/proj`, `${HOME}/a/b`, '/srv/app', '/home/other'])('given the ordinary project root %s, should say nothing', (root) => {
    expect(withRoots([root])).toEqual([]);
  });

  it('given several roots of which ONE is home, should warn once', () => {
    expect(withRoots([`${HOME}/proj`, HOME, '/srv/app']).map((w) => w.code)).toEqual(['root_is_home']);
  });

  it('given no homedir to compare against, should say nothing rather than guess', () => {
    expect(policyWarnings({ ...base, roots: [HOME] })).toEqual([]);
    expect(policyWarnings({ ...base, roots: [HOME] }, { homedir: null })).toEqual([]);
    expect(policyWarnings({ ...base, roots: [HOME] }, { homedir: '' })).toEqual([]);
  });

  it('given every warning at once, should carry them in one fixed order, one line each', () => {
    const warnings = policyWarnings({ mode: 'allowlist', ops: ['exec'], principals: ['a', 'b'], roots: [HOME] }, { homedir: HOME });
    expect(warnings.map((w) => w.code)).toEqual(['principals_widen_d6', 'exec_allowlisted', 'root_is_home']);
    for (const warning of warnings) expect(warning.message).not.toContain('\n');
  });
});
