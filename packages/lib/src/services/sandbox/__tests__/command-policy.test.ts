import { describe, it, expect } from 'vitest';
import { evaluateCommandPolicy, MAX_COMMAND_BYTES } from '../command-policy';

describe('evaluateCommandPolicy', () => {
  it('given a normal command, should allow it', () => {
    expect(evaluateCommandPolicy({ command: 'echo hello' })).toEqual({ ok: true });
  });

  it('given an empty command, should deny with empty_command', () => {
    expect(evaluateCommandPolicy({ command: '   ' })).toEqual({
      ok: false,
      reason: 'empty_command',
    });
  });

  it('given no input at all, should deny with empty_command rather than throw', () => {
    expect(evaluateCommandPolicy()).toEqual({ ok: false, reason: 'empty_command' });
  });

  it('given a command larger than the byte cap, should deny with command_too_large', () => {
    const command = 'a'.repeat(MAX_COMMAND_BYTES + 1);
    expect(evaluateCommandPolicy({ command })).toEqual({
      ok: false,
      reason: 'command_too_large',
    });
  });

  it('given a custom byte cap, should enforce it', () => {
    expect(evaluateCommandPolicy({ command: 'abcdef', maxBytes: 3 })).toEqual({
      ok: false,
      reason: 'command_too_large',
    });
  });

  it('given a command reaching the cloud metadata IP, should deny with blocked_metadata_access', () => {
    expect(
      evaluateCommandPolicy({ command: 'curl http://169.254.169.254/latest/meta-data/' }),
    ).toEqual({ ok: false, reason: 'blocked_metadata_access' });
  });

  it('given the metadata IP in decimal encoding, should still deny', () => {
    expect(evaluateCommandPolicy({ command: 'curl http://2852039166/' })).toEqual({
      ok: false,
      reason: 'blocked_metadata_access',
    });
  });

  it('given the metadata IP in hex encoding, should still deny', () => {
    expect(evaluateCommandPolicy({ command: 'wget http://0xA9FEA9FE/' })).toEqual({
      ok: false,
      reason: 'blocked_metadata_access',
    });
  });
});

describe('evaluateCommandPolicy — github-over-bash redirect', () => {
  // bash has no GitHub credentials; these must redirect to the dedicated tools.
  const denied = [
    'gh',
    'gh pr list',
    'gh pr create --title x --body y',
    'git push',
    'git push origin main',
    'git push --force-with-lease',
    'git clone https://github.com/o/r.git',
    'git fetch origin',
    'git pull --rebase',
  ];
  for (const command of denied) {
    it(`given "${command}" in bash, should deny with github_over_bash`, () => {
      expect(evaluateCommandPolicy({ command })).toEqual({
        ok: false,
        reason: 'github_over_bash',
      });
    });
  }

  // Local, credential-free git works fine in bash — do not block it.
  const allowed = [
    'git status',
    'git status --porcelain',
    'git log --oneline',
    'git add -A',
    'git commit -m "msg"',
    'git diff --cached',
    'echo gh', // gh as an argument, not a command
    'echo git push', // not at a command boundary
    'github --help', // not the gh CLI
    'legit push', // git inside a word
  ];
  for (const command of allowed) {
    it(`given "${command}", should allow it (credential-free)`, () => {
      expect(evaluateCommandPolicy({ command })).toEqual({ ok: true });
    });
  }

  it('given a GitHub op after a command separator, should still deny (chained)', () => {
    expect(evaluateCommandPolicy({ command: 'cd repo && gh pr create' })).toEqual({
      ok: false,
      reason: 'github_over_bash',
    });
    expect(evaluateCommandPolicy({ command: 'echo hi; git push' })).toEqual({
      ok: false,
      reason: 'github_over_bash',
    });
    expect(evaluateCommandPolicy({ command: 'foo | git fetch' })).toEqual({
      ok: false,
      reason: 'github_over_bash',
    });
  });

  it('given a pathological input (under the size cap), should terminate (ReDoS-safe) and return a decision', () => {
    // Stay under MAX_COMMAND_BYTES so the size guard doesn't short-circuit before
    // the regex runs — this exercises the matcher's linear scan on a long input.
    const command = ' '.repeat(10_000) + 'git status';
    expect(evaluateCommandPolicy({ command })).toEqual({ ok: true });
  });
});
