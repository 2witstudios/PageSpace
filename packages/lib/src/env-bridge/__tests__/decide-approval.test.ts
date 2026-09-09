/**
 * GA wave 2, leaf 2 — the pure approval matcher. An approval is keyed on
 * `(envId, userId, op, subject)`: the resolved program for `exec`, a policy
 * root for file operations — never a session. The matcher has no I/O: the
 * program resolver and the clock are injected.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVAL_SCOPES,
  DEFAULT_APPROVAL_SCOPE,
  THIRTY_DAYS_MS,
  approvalExpiry,
  approvalSubjects,
  isDurableScope,
  matchApproval,
  parseApprovalsFile,
  shellCommandWords,
  type ApprovalMatchDeps,
  type DurableApproval,
} from '../decide-approval';
import type { Grant } from '../grant';
import type { NormalizedRequest } from '../decide-execution';

const ROOT = '/home/u/proj';
const OTHER_ROOT = '/srv/data';
const NOW = 1_800_000_000_000;

const BIN: Record<string, string> = { git: '/usr/bin/git', ls: '/bin/ls', rm: '/bin/rm', node: '/usr/local/bin/node', sh: '/bin/sh', bash: '/bin/bash', find: '/usr/bin/find' };
const deps: ApprovalMatchDeps = { resolveArgv0: (name) => BIN[name] ?? null, roots: [ROOT, OTHER_ROOT] };

const grant: Grant = { grantId: 'g1', envId: 'env1', principal: { userId: 'user_1', sessionId: 's1', conversationId: 'c1' }, op: 'exec', argsHash: 'h', iat: NOW - 1000, exp: NOW + 30_000, nonce: 'n1' };

const exec = (cmd: string, args: readonly string[] = []): NormalizedRequest => ({ op: 'exec', cmd, args, cwd: ROOT, paths: [], env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false });
const shell = (script: string): NormalizedRequest => exec('sh', ['-c', script]);
const fsRead = (...paths: string[]): NormalizedRequest => ({ op: 'fs_read', cwd: ROOT, paths, env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false });

function approval(over: Partial<DurableApproval> = {}): DurableApproval {
  return { approvalId: 'a1', envId: 'env1', userId: 'user_1', op: 'exec', subject: 'exec:/usr/bin/git', scope: '30d', createdAt: NOW - 1000, expiresAt: NOW + THIRTY_DAYS_MS, ...over };
}

describe('approvalSubjects — what an approval is keyed on', () => {
  it('given an exec whose command is a program, should key on the RESOLVED program path (an approval of `git status` covers `git …`)', () => {
    expect(approvalSubjects(exec('git', ['status']), deps)).toEqual(['exec:/usr/bin/git']);
    expect(approvalSubjects(exec('git', ['push', '--force']), deps)).toEqual(['exec:/usr/bin/git']);
  });

  it('given an exec that cannot be resolved to a program, should yield null — never a subject a later request could ride', () => {
    expect(approvalSubjects(exec('nosuchtool'), deps)).toBeNull();
  });

  it('given `sh -c <script>` (what the bash tool always sends), should key on EVERY program the script names, never on the shell itself', () => {
    expect(approvalSubjects(shell('git status'), deps)).toEqual(['exec:/usr/bin/git']);
    expect(approvalSubjects(shell('git status && ls -la | rm -rf x'), deps)).toEqual(['exec:/usr/bin/git', 'exec:/bin/ls', 'exec:/bin/rm']);
    expect(approvalSubjects(shell('cd src; git log'), deps)).toEqual(['builtin:cd', 'exec:/usr/bin/git']);
  });

  it('given a script the lexer cannot attribute to programs (substitution, eval, a nested shell, find -exec), should yield null so it is asked about every time', () => {
    for (const script of ['git $(rm -rf x)', '`rm -rf x`', 'eval "rm -rf x"', 'sh -c "rm -rf x"', 'bash -lc "rm x"', 'exec rm x', 'source ./x.sh', '. ./x.sh', 'find . -exec rm {} \\;', 'xargs rm', 'sudo rm x', '"$CMD" x', '$X', 'case $x in a) rm x;; esac']) {
      expect(approvalSubjects(shell(script), deps), script).toBeNull();
    }
  });

  it('given a script with env assignments, wrappers and control keywords, should still find the programs', () => {
    expect(approvalSubjects(shell('CI=1 FOO=bar git status'), deps)).toEqual(['exec:/usr/bin/git']);
    expect(approvalSubjects(shell('if git diff --quiet; then ls; else rm x; fi'), deps)).toEqual(['exec:/usr/bin/git', 'exec:/bin/ls', 'exec:/bin/rm']);
    expect(approvalSubjects(shell('for f in a b; do ls $f; done'), deps)).toEqual(['exec:/bin/ls']);
    expect(approvalSubjects(shell('env FOO=1 git status'), deps)).toEqual(['exec:/usr/bin/git']);
    expect(approvalSubjects(shell('! git diff --quiet'), deps)).toEqual(['exec:/usr/bin/git']);
    expect(approvalSubjects(shell('(cd x && ls) > out.txt 2>&1'), deps)).toEqual(['builtin:cd', 'exec:/bin/ls']);
    expect(approvalSubjects(shell('echo "a; rm x" | ls'), deps)).toEqual(['builtin:echo', 'exec:/bin/ls']);
  });

  it('given a file op, should key on the policy ROOT each path resolves inside (one subject per root touched)', () => {
    expect(approvalSubjects(fsRead(`${ROOT}/a.txt`, `${ROOT}/b/c.txt`), deps)).toEqual([`root:${ROOT}`]);
    expect(approvalSubjects(fsRead(`${ROOT}/a.txt`, `${OTHER_ROOT}/x`), deps)).toEqual([`root:${ROOT}`, `root:${OTHER_ROOT}`]);
  });

  it('given a file op path outside every root (cannot happen after confinePath, pinned anyway), should yield null', () => {
    expect(approvalSubjects(fsRead('/etc/passwd'), deps)).toBeNull();
    // A sibling directory that merely shares the root as a string prefix is NOT inside it.
    expect(approvalSubjects(fsRead(`${ROOT}-other/x`), deps)).toBeNull();
  });

  it('given a pty_open, should yield null (no durable approval for a PTY)', () => {
    expect(approvalSubjects({ ...exec('bash'), op: 'pty_open' }, deps)).toBeNull();
  });
});

describe('shellCommandWords — the conservative lexer behind exec subjects', () => {
  it('should split on ; && || | & and newlines, outside quotes only', () => {
    expect(shellCommandWords('a; b && c || d | e & f\ng')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(shellCommandWords('a "x; y" \'p && q\'')).toEqual(['a']);
  });
  it('should return null for anything it cannot attribute to a program name', () => {
    expect(shellCommandWords('')).toBeNull();
    expect(shellCommandWords('   ')).toBeNull();
    expect(shellCommandWords('a $(b)')).toBeNull();
    expect(shellCommandWords('${CMD}')).toBeNull();
    expect(shellCommandWords("'quoted' x")).toBeNull();
    expect(shellCommandWords('a <(b)')).toBeNull();
  });
});

describe('matchApproval — covered | ask | expired, keyed (envId, userId, op, subject), never the session', () => {
  it('given a live approval for the subject, should be covered — from ANY session or conversation', () => {
    expect(matchApproval([approval()], grant, exec('git', ['status']), NOW, deps)).toBe('covered');
    expect(matchApproval([approval()], { ...grant, principal: { userId: 'user_1', sessionId: 'another', conversationId: 'new-chat' } }, exec('git', ['push']), NOW, deps)).toBe('covered');
  });

  it('given an approval of git, should NOT cover rm (subject differs) — ask', () => {
    expect(matchApproval([approval()], grant, exec('rm', ['-rf', 'x']), NOW, deps)).toBe('ask');
    expect(matchApproval([approval()], grant, shell('git status && rm -rf x'), NOW, deps)).toBe('ask');
  });

  it('given approvals for every program a script names, should cover the script', () => {
    const both = [approval(), approval({ approvalId: 'a2', subject: 'exec:/bin/rm' })];
    expect(matchApproval(both, grant, shell('git status && rm -rf x'), NOW, deps)).toBe('covered');
  });

  it('given a different env, user or op, should ask — the key is all four parts', () => {
    expect(matchApproval([approval({ envId: 'env2' })], grant, exec('git'), NOW, deps)).toBe('ask');
    expect(matchApproval([approval({ userId: 'user_2' })], grant, exec('git'), NOW, deps)).toBe('ask');
    expect(matchApproval([approval({ op: 'fs_read' })], grant, exec('git'), NOW, deps)).toBe('ask');
  });

  it('given a grant whose op differs from the request op, should ask (the approval is for the grant\'s op)', () => {
    expect(matchApproval([approval()], { ...grant, op: 'fs_read' }, exec('git'), NOW, deps)).toBe('ask');
  });

  it('given only an expired approval for the subject, should report expired (the daemon prunes it and asks)', () => {
    expect(matchApproval([approval({ expiresAt: NOW - 1 })], grant, exec('git'), NOW, deps)).toBe('expired');
    expect(matchApproval([approval({ expiresAt: NOW })], grant, exec('git'), NOW, deps)).toBe('expired');
  });

  it('given an expired and a live approval for the same subject, should be covered', () => {
    expect(matchApproval([approval({ expiresAt: NOW - 1 }), approval({ approvalId: 'a2' })], grant, exec('git'), NOW, deps)).toBe('covered');
  });

  it('given an until_revoked approval (no expiry), should be covered at any time', () => {
    expect(matchApproval([approval({ scope: 'until_revoked', expiresAt: null })], grant, exec('git'), NOW + 10 * THIRTY_DAYS_MS, deps)).toBe('covered');
  });

  it('given a request whose subjects are unresolvable, should ask even when approvals exist for everything', () => {
    expect(matchApproval([approval(), approval({ approvalId: 'a2', subject: 'exec:/bin/rm' })], grant, shell('git $(rm x)'), NOW, deps)).toBe('ask');
  });

  it('given a file op inside an approved root, should be covered; outside it, ask', () => {
    const rootApproval = approval({ op: 'fs_read', subject: `root:${ROOT}` });
    expect(matchApproval([rootApproval], { ...grant, op: 'fs_read' }, fsRead(`${ROOT}/a`), NOW, deps)).toBe('covered');
    expect(matchApproval([rootApproval], { ...grant, op: 'fs_read' }, fsRead(`${ROOT}/a`, `${OTHER_ROOT}/b`), NOW, deps)).toBe('ask');
  });

  it('given no approvals, should ask', () => {
    expect(matchApproval([], grant, exec('git'), NOW, deps)).toBe('ask');
  });
});

describe('scopes and expiry', () => {
  it('should offer once | session | 30d | until_revoked, defaulting to 30d', () => {
    expect([...APPROVAL_SCOPES]).toEqual(['once', 'session', '30d', 'until_revoked']);
    expect(DEFAULT_APPROVAL_SCOPE).toBe('30d');
    expect(THIRTY_DAYS_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('approvalExpiry: 30d ⇒ now + 30 days; until_revoked and session ⇒ null; once ⇒ null', () => {
    expect(approvalExpiry('30d', NOW)).toBe(NOW + THIRTY_DAYS_MS);
    expect(approvalExpiry('until_revoked', NOW)).toBeNull();
    expect(approvalExpiry('session', NOW)).toBeNull();
    expect(approvalExpiry('once', NOW)).toBeNull();
  });
  it('isDurableScope: only 30d and until_revoked reach the file; once is not remembered, session lives in the daemon process', () => {
    expect(APPROVAL_SCOPES.filter(isDurableScope)).toEqual(['30d', 'until_revoked']);
  });
});

describe('parseApprovalsFile — strict; ANY defect ⇒ null (empty), never a partial list', () => {
  const valid = { version: 1, approvals: [approval()] };

  it('given a valid file, should return the approvals', () => {
    expect(parseApprovalsFile(valid)).toEqual([approval()]);
    expect(parseApprovalsFile({ version: 1, approvals: [] })).toEqual([]);
  });

  it.each([
    ['not an object', 'nope'],
    ['wrong version', { ...valid, version: 2 }],
    ['extra top-level key', { ...valid, extra: 1 }],
    ['extra entry key', { version: 1, approvals: [{ ...approval(), isAdmin: true }] }],
    ['an op outside the union', { version: 1, approvals: [approval({ op: 'root' as never })] }],
    ['a once scope in the file', { version: 1, approvals: [approval({ scope: 'once', expiresAt: null })] }],
    ['a session scope in the file', { version: 1, approvals: [approval({ scope: 'session', expiresAt: null })] }],
    ['30d without an expiry', { version: 1, approvals: [approval({ expiresAt: null })] }],
    ['until_revoked WITH an expiry', { version: 1, approvals: [approval({ scope: 'until_revoked', expiresAt: NOW })] }],
    ['an empty subject', { version: 1, approvals: [approval({ subject: '' })] }],
    ['a subject with no namespace', { version: 1, approvals: [approval({ subject: '/usr/bin/git' })] }],
    ['one bad entry among good ones', { version: 1, approvals: [approval(), { approvalId: 'x' }] }],
  ])('given %s, should return null — the WHOLE file is ignored', (_label, input) => {
    expect(parseApprovalsFile(input)).toBeNull();
  });
});

describe('purity', () => {
  it('decide-approval.ts performs no I/O and reads no clock', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'decide-approval.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:|from 'fs'|from 'ws'|child_process|Date\.now|new Date\(|Math\.random|crypto/);
  });
});
