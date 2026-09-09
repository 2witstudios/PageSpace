import { describe, it, expect } from 'vitest';
import { decideExecution, type NormalizedRequest } from '../decide-execution';
import { canonicalizeArgs, type Grant } from '../grant';
import type { MachinePolicy, ServerPolicy, AdvertisedCapabilities } from '../policy-types';
import type { PathProbe } from '../confine-path';
import type { DurableApproval } from '../decide-approval';

const ROOT = '/home/u/proj';
const identityProbe: PathProbe = { realpath: (p) => p, isSymlink: () => false };

const grant: Grant = {
  grantId: 'g1',
  envId: 'env1',
  principal: { userId: 'user_1', sessionId: 's1', conversationId: 'c1' },
  op: 'exec',
  argsHash: 'h',
  iat: 0,
  exp: 60_000,
  nonce: 'n1',
};

const machine: MachinePolicy = {
  mode: 'allowlist',
  principals: ['user_1'],
  ops: ['exec', 'fs_read', 'fs_write'],
  roots: [ROOT],
  envAllowlist: ['LANG'],
  maxBytes: 4096,
  maxTimeoutMs: 30_000,
};

const server: ServerPolicy = { ops: ['exec', 'fs_read', 'fs_write', 'pty_open'], checkpoint: false };
const advertised: AdvertisedCapabilities = { shell: true, pty: true, fs: true, checkpoint: false };

const request = { op: 'exec' as const, cmd: 'ls', args: ['-la'], cwd: `${ROOT}/src`, env: { LANG: 'C', LD_PRELOAD: '/evil.so' }, timeoutMs: 10_000, maxBytes: 1024 };

const NORMALIZED: NormalizedRequest = {
  op: 'exec',
  cmd: 'ls',
  args: ['-la'],
  cwd: `${ROOT}/src`,
  paths: [],
  env: { LANG: 'C' },
  timeoutMs: 10_000,
  maxBytes: 1024,
  clamped: false,
};

function decide(overrides: Partial<Parameters<typeof decideExecution>[0]> = {}) {
  return decideExecution({ grant, request, machinePolicy: machine, serverPolicy: server, capabilities: advertised, probe: identityProbe, ...overrides });
}

describe('decideExecution — the daemon is the policy enforcement point (invariant 4); server policy is necessary, never sufficient', () => {
  it('given machinePolicy === null (missing or unparseable), should deny no_policy regardless of everything else', () => {
    expect(decide({ machinePolicy: null })).toEqual({ kind: 'deny', reason: 'no_policy' });
  });

  it('given mode deny, should deny policy_deny for every op', () => {
    for (const op of ['exec', 'fs_read', 'fs_write', 'pty_open'] as const) {
      // Well-formed per op (fs ops need paths) so the shape gate is not what denies.
      expect(decide({ machinePolicy: { ...machine, mode: 'deny', ops: [op] }, grant: { ...grant, op }, request: { ...request, op, paths: [`${ROOT}/f`] } })).toEqual({ kind: 'deny', reason: 'policy_deny' });
    }
  });

  it('given the grant principal not in machinePolicy.principals, should deny principal_not_allowed (the machine owner decides who may drive it)', () => {
    expect(decide({ grant: { ...grant, principal: { ...grant.principal, userId: 'user_admin' } } })).toEqual({ kind: 'deny', reason: 'principal_not_allowed' });
  });

  it('given the request op differs from the grant op, should deny op_mismatch (defense in depth behind verifyGrant)', () => {
    expect(decide({ request: { ...request, op: 'fs_read', paths: [`${ROOT}/f`] } })).toEqual({ kind: 'deny', reason: 'op_mismatch' });
  });

  it('given op not advertised by the machine, should deny op_not_advertised', () => {
    expect(decide({ capabilities: { ...advertised, shell: false } })).toEqual({ kind: 'deny', reason: 'op_not_advertised' });
  });

  it('given op advertised and machine-allowed but absent from serverPolicy, should deny server_denied', () => {
    expect(decide({ serverPolicy: { ops: ['fs_read'], checkpoint: false } })).toEqual({ kind: 'deny', reason: 'server_denied' });
  });

  it('given op server-allowed but absent from machinePolicy.ops in allowlist mode, should deny machine_denied (server is never sufficient)', () => {
    expect(decide({ machinePolicy: { ...machine, ops: ['fs_read'] } })).toEqual({ kind: 'deny', reason: 'machine_denied' });
  });

  it('given all three allow, should return allow with a NORMALIZED request: confined cwd, scrubbed env, clamped timeout and bytes', () => {
    expect(decide()).toEqual({ kind: 'allow', request: NORMALIZED, basis: { kind: 'preapproved_op' } });
  });

  describe('the ask → allow seam (major: approval must be pure and bound to the grant)', () => {
    const askPolicy: MachinePolicy = { ...machine, mode: 'ask', ops: ['fs_read'] };

    it('given mode ask and an op NOT pre-approved, should return ask carrying the exact NormalizedRequest the owner is approving (confined + scrubbed BEFORE asking)', () => {
      expect(decide({ machinePolicy: askPolicy })).toEqual({ kind: 'ask', reason: 'op_not_preapproved', request: NORMALIZED, subjects: null });
    });

    it('given mode ask and an op that IS pre-approved, should allow without asking', () => {
      expect(decide({ machinePolicy: { ...machine, mode: 'ask' } })).toEqual({ kind: 'allow', request: NORMALIZED, basis: { kind: 'preapproved_op' } });
    });

    // The owner approves exactly the NormalizedRequest the ask verdict showed them.
    const approval = { grantId: grant.grantId, approvedAt: 30_000, request: NORMALIZED }; // grant.exp is 60_000

    it('given an approval whose request is the ask verdict\'s own NormalizedRequest, should allow it unchanged', () => {
      const asked = decide({ machinePolicy: askPolicy });
      if (asked.kind !== 'ask') throw new Error('expected ask');
      expect(decide({ machinePolicy: askPolicy, localApproval: { grantId: grant.grantId, approvedAt: 30_000, request: asked.request } })).toEqual({ kind: 'allow', request: asked.request, basis: { kind: 'fresh_approval' } });
    });

    it('given the filesystem DRIFTED between ask and approval (an in-root symlink now resolves elsewhere), should deny approval_mismatch — never execute what the owner did not see', () => {
      const before: PathProbe = { realpath: (p) => (p === `${ROOT}/link` ? `${ROOT}/a` : p), isSymlink: () => false };
      const after: PathProbe = { realpath: (p) => (p === `${ROOT}/link` ? `${ROOT}/b` : p), isSymlink: () => false };
      const fsGrant = { ...grant, op: 'fs_write' as const };
      const fsRequest = { op: 'fs_write' as const, paths: [`${ROOT}/link`] };
      const askFs: MachinePolicy = { ...askPolicy, ops: [] };
      const asked = decide({ grant: fsGrant, request: fsRequest, machinePolicy: askFs, probe: before });
      if (asked.kind !== 'ask') throw new Error('expected ask');
      expect(asked.request.paths).toEqual([`${ROOT}/a`]);
      expect(decide({ grant: fsGrant, request: fsRequest, machinePolicy: askFs, probe: after, localApproval: { grantId: grant.grantId, approvedAt: 30_000, request: asked.request } })).toEqual({ kind: 'deny', reason: 'approval_mismatch' });
    });

    it('given an approval whose request was tampered after the prompt (extra env var), should deny approval_mismatch', () => {
      const tampered = { ...NORMALIZED, env: { ...NORMALIZED.env, EVIL: '1' } };
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, request: tampered } })).toEqual({ kind: 'deny', reason: 'approval_mismatch' });
    });

    it('given an approval whose request differs only in cmd, should deny approval_mismatch', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, request: { ...NORMALIZED, cmd: 'rm' } } })).toEqual({ kind: 'deny', reason: 'approval_mismatch' });
    });

    it('should order the approval tail: approval_expired beats approval_mismatch', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { grantId: grant.grantId, approvedAt: grant.exp + 1, request: { ...NORMALIZED, cmd: 'rm' } } })).toEqual({ kind: 'deny', reason: 'approval_expired' });
    });

    it('given mode ask, a non-pre-approved op, and localApproval for THIS grantId within the grant TTL, should allow with the same NormalizedRequest', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: approval })).toEqual({ kind: 'allow', request: NORMALIZED, basis: { kind: 'fresh_approval' } });
    });

    it('given localApproval for a DIFFERENT grantId, should still ask (an approval is bound to one grant)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, grantId: 'someone_elses_grant' } }).kind).toBe('ask');
    });

    it('given localApproval AFTER grant.exp (a human prompt outlived the 60s TTL), should deny approval_expired — the grant bounds the whole authorization, prompt included', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, approvedAt: grant.exp + 1 } })).toEqual({ kind: 'deny', reason: 'approval_expired' });
    });

    it('given localApproval exactly at grant.exp, should allow (boundary inclusive, matching verifyGrant\'s exp < now)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, approvedAt: grant.exp } }).kind).toBe('allow');
    });

    it('given localApproval with a non-finite approvedAt, should deny approval_expired (fail closed)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { ...approval, approvedAt: Number.NaN } })).toEqual({ kind: 'deny', reason: 'approval_expired' });
    });

    it('given localApproval but the server denies the op, should deny server_denied (approval cannot override the server)', () => {
      expect(decide({ machinePolicy: askPolicy, serverPolicy: { ops: ['fs_read'], checkpoint: false }, localApproval: approval })).toEqual({ kind: 'deny', reason: 'server_denied' });
    });

    it('given localApproval in allowlist mode for a non-listed op, should deny machine_denied (approval is only an ask-mode concept)', () => {
      expect(decide({ machinePolicy: { ...machine, ops: ['fs_read'] }, localApproval: approval })).toEqual({ kind: 'deny', reason: 'machine_denied' });
    });

    it('given localApproval but a cwd outside every root, should deny cwd_denied (approval never bypasses confinement)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: approval, request: { ...request, cwd: '/etc' } })).toEqual({ kind: 'deny', reason: 'cwd_denied' });
    });

    it('given mode ask and a request that would be denied on confinement, should deny rather than ask (deny beats ask)', () => {
      expect(decide({ machinePolicy: askPolicy, request: { ...request, cwd: '/etc' } })).toEqual({ kind: 'deny', reason: 'cwd_denied' });
    });
  });

  describe('owner caps (blocker: a bogus limit must never disable the cap)', () => {
    it('given a request timeoutMs above the machine cap, should clamp (not deny) and record clamped: true', () => {
      const verdict = decide({ request: { ...request, timeoutMs: 999_999 } });
      if (verdict.kind !== 'allow') throw new Error('expected allow');
      expect(verdict.request.timeoutMs).toBe(machine.maxTimeoutMs);
      expect(verdict.request.clamped).toBe(true);
    });

    it('given a request maxBytes above the machine cap, should clamp and record clamped: true', () => {
      const verdict = decide({ request: { ...request, maxBytes: 1_000_000 } });
      if (verdict.kind !== 'allow') throw new Error('expected allow');
      expect(verdict.request.maxBytes).toBe(machine.maxBytes);
      expect(verdict.request.clamped).toBe(true);
    });

    it('given no timeoutMs / maxBytes in the request, should apply the machine caps as the values (not clamped)', () => {
      const { timeoutMs: _t, maxBytes: _b, ...rest } = request;
      const verdict = decide({ request: rest });
      if (verdict.kind !== 'allow') throw new Error('expected allow');
      expect(verdict.request.timeoutMs).toBe(machine.maxTimeoutMs);
      expect(verdict.request.maxBytes).toBe(machine.maxBytes);
      expect(verdict.request.clamped).toBe(false);
    });

    it.each<[string, number]>([
      ['0', 0],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a non-integer', 1.5],
    ])('given timeoutMs of %s (child_process treats 0/NaN as DISABLED), should use the owner cap and record clamped: true', (_label, value) => {
      const verdict = decide({ request: { ...request, timeoutMs: value } });
      if (verdict.kind !== 'allow') throw new Error('expected allow');
      expect(verdict.request.timeoutMs).toBe(machine.maxTimeoutMs);
      expect(verdict.request.clamped).toBe(true);
    });

    it.each<[string, number]>([
      ['0', 0],
      ['-1', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('given maxBytes of %s, should use the owner cap and record clamped: true', (_label, value) => {
      const verdict = decide({ request: { ...request, maxBytes: value } });
      if (verdict.kind !== 'allow') throw new Error('expected allow');
      expect(verdict.request.maxBytes).toBe(machine.maxBytes);
      expect(verdict.request.clamped).toBe(true);
    });

    it('should never emit a non-positive or non-finite limit in an allow verdict, whatever the input', () => {
      for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.1]) {
        const verdict = decide({ request: { ...request, timeoutMs: value, maxBytes: value } });
        if (verdict.kind !== 'allow') throw new Error('expected allow');
        expect(Number.isInteger(verdict.request.timeoutMs) && verdict.request.timeoutMs > 0).toBe(true);
        expect(Number.isInteger(verdict.request.maxBytes) && verdict.request.maxBytes > 0).toBe(true);
      }
    });
  });

  it('given a cwd outside every root, should deny cwd_denied', () => {
    expect(decide({ request: { ...request, cwd: '/etc' } })).toEqual({ kind: 'deny', reason: 'cwd_denied' });
  });

  it('given no cwd, should default to the first root', () => {
    const { cwd: _c, ...rest } = request;
    const verdict = decide({ request: rest });
    if (verdict.kind !== 'allow') throw new Error('expected allow');
    expect(verdict.request.cwd).toBe(ROOT);
  });

  it('given an fs op with a path outside every root, should deny path_denied', () => {
    const fsGrant = { ...grant, op: 'fs_read' as const };
    expect(decide({ grant: fsGrant, request: { op: 'fs_read', paths: [`${ROOT}/ok.txt`, '/etc/passwd'] } })).toEqual({ kind: 'deny', reason: 'path_denied' });
  });

  it('given an fs op with all paths inside a root, should allow with every path confined (resolved)', () => {
    const fsGrant = { ...grant, op: 'fs_read' as const };
    const probe: PathProbe = { realpath: (p) => (p === ROOT ? '/private/home/u/proj' : p.replace(ROOT, '/private/home/u/proj')), isSymlink: () => false };
    const verdict = decide({ grant: fsGrant, request: { op: 'fs_read', paths: [`${ROOT}/a.txt`] }, probe });
    if (verdict.kind !== 'allow') throw new Error('expected allow');
    expect(verdict.request.paths).toEqual(['/private/home/u/proj/a.txt']);
  });

  it('given an fs_write to a file that does not exist yet under a root, should allow with the parent resolved (Codex P1)', () => {
    const fsGrant = { ...grant, op: 'fs_write' as const };
    const probe: PathProbe = { realpath: (p) => (p === ROOT || p === `${ROOT}/src` ? p : null), isSymlink: () => false };
    const verdict = decide({ grant: fsGrant, request: { op: 'fs_write', paths: [`${ROOT}/src/new.ts`] }, probe });
    // Exact shape, deliberately: a request that carried no modes normalises
    // without a `writeModes` key at all (hardening A1 adds the key only when
    // the request has one, so "absent" and "all null" stay distinct bytes).
    expect(verdict).toEqual({ kind: 'allow', request: { op: 'fs_write', cwd: ROOT, paths: [`${ROOT}/src/new.ts`], env: {}, timeoutMs: machine.maxTimeoutMs, maxBytes: machine.maxBytes, clamped: false }, basis: { kind: 'preapproved_op' } });
  });

  describe('A1: the file mode reaches the decision layer, index-aligned with the paths', () => {
    const fsGrant = { ...grant, op: 'fs_write' as const };
    const probe: PathProbe = { realpath: (p) => (p === ROOT || p === `${ROOT}/src` ? p : null), isSymlink: () => false };
    const write = (writeModes?: readonly (number | null)[]) => decide({ grant: fsGrant, request: { op: 'fs_write', paths: [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], ...(writeModes !== undefined && { writeModes }) }, probe });

    it('given an fs_write whose files carry modes, should normalise them in the same order as the paths', () => {
      const verdict = write([0o644, null]);
      if (verdict.kind !== 'allow') throw new Error(`expected allow, got ${verdict.kind}`);
      expect(verdict.request).toEqual({ op: 'fs_write', cwd: ROOT, paths: [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], writeModes: [0o644, null], env: {}, timeoutMs: machine.maxTimeoutMs, maxBytes: machine.maxBytes, clamped: false });
    });

    it('given a mode that changes and NOTHING else, should produce different canonical bytes (an approval cannot be replayed at another mode)', () => {
      // Two NON-executable modes: an executable bit would escalate to an ask
      // (A3), and this row is about the canonical bytes, not the verdict.
      const a = write([0o644, null]);
      const b = write([0o600, null]);
      if (a.kind !== 'allow' || b.kind !== 'allow') throw new Error('expected allow');
      expect(Buffer.from(canonicalizeArgs(a.request)).toString('utf8')).not.toBe(Buffer.from(canonicalizeArgs(b.request)).toString('utf8'));
      expect(Buffer.from(canonicalizeArgs(a.request)).toString('utf8')).toContain('"writeModes":[420,null]');
    });

    it('given a fresh approval over a request whose mode differs from the one now asked for, should deny approval_mismatch', () => {
      const asked = write([0o644, null]);
      if (asked.kind !== 'allow') throw new Error('expected allow');
      const askMode = decideExecution({
        grant: { ...fsGrant, op: 'fs_write' },
        request: { op: 'fs_write', paths: [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], writeModes: [0o755, null] },
        machinePolicy: { ...machine, mode: 'ask', ops: [] },
        serverPolicy: server,
        capabilities: advertised,
        probe,
        localApproval: { grantId: fsGrant.grantId, approvedAt: 1, request: asked.request },
      });
      expect(askMode).toEqual({ kind: 'deny', reason: 'approval_mismatch' });
    });

    it.each<[string, unknown]>([
      ['a non-array writeModes', '0644'],
      ['a string entry (aligned, so only the type check can refuse it)', ['0644', '0600']],
      ['a boolean entry (aligned)', [true, null]],
      ['a non-integer mode (aligned)', [0.5, null]],
      ['a negative mode (aligned)', [-1, null]],
      ['an undefined entry (aligned) — absent is spelled null', [undefined, null]],
      ['fewer modes than paths', [0o644]],
      ['more modes than paths', [0o644, null, 0o600]],
    ])('given %s (a hostile frame), should deny malformed and never throw', (_label, writeModes) => {
      const hostile = { op: 'fs_write', paths: [`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], writeModes } as unknown as Parameters<typeof decideExecution>[0]['request'];
      expect(() => decide({ grant: fsGrant, request: hostile, probe })).not.toThrow();
      expect(decide({ grant: fsGrant, request: hostile, probe })).toEqual({ kind: 'deny', reason: 'malformed' });
    });

    it('given writeModes on an fs_read (an op that has no such thing), should deny malformed', () => {
      const hostile = { op: 'fs_read', paths: [`${ROOT}/src/a.ts`], writeModes: [0o644] } as unknown as Parameters<typeof decideExecution>[0]['request'];
      expect(decide({ grant: { ...grant, op: 'fs_read' }, request: hostile, probe })).toEqual({ kind: 'deny', reason: 'malformed' });
    });
  });

  describe('A3: a sensitive write escalates to the owner\'s click instead of running headless', () => {
    const fsGrant = { ...grant, op: 'fs_write' as const };
    const probe: PathProbe = { realpath: (p) => p, isSymlink: () => false };
    const approvals = { entries: [] as DurableApproval[], now: 1, resolveArgv0: () => null };
    const write = (paths: string[], writeModes?: (number | null)[], overrides: Partial<Parameters<typeof decideExecution>[0]> = {}) =>
      decide({ grant: fsGrant, request: { op: 'fs_write', paths, ...(writeModes !== undefined && { writeModes }) }, probe, approvals, ...overrides });

    it('given fs_write pre-approved in ops and every file ordinary, should still allow headless with basis preapproved_op (no Tier A regression)', () => {
      const verdict = write([`${ROOT}/src/index.ts`], [0o644]);
      expect(verdict).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
    });

    it('given fs_write pre-approved and ANY file sensitive, should ask instead — the pre-approved short-circuit must not win', () => {
      const verdict = write([`${ROOT}/src/index.ts`, `${ROOT}/.git/hooks/pre-commit`], [0o644, 0o755]);
      expect(verdict.kind).toBe('ask');
      if (verdict.kind !== 'ask') throw new Error('expected ask');
      expect(verdict.reason).toBe('sensitive_write');
    });

    it('given the ask verdict, should say WHICH file and WHY, for every sensitive file, in path order', () => {
      const verdict = write([`${ROOT}/src/index.ts`, `${ROOT}/.git/hooks/pre-commit`, `${ROOT}/Makefile`], [0o644, 0o755, null]);
      if (verdict.kind !== 'ask' || verdict.reason !== 'sensitive_write') throw new Error('expected a sensitive_write ask');
      expect(verdict.sensitive).toEqual([
        { path: `${ROOT}/.git/hooks/pre-commit`, reason: 'vcs_metadata' },
        { path: `${ROOT}/Makefile`, reason: 'build_or_task' },
      ]);
    });

    it('given an executable bit on an otherwise ordinary file, should ask (the mode alone escalates)', () => {
      const verdict = write([`${ROOT}/src/tool.sh`], [0o755]);
      if (verdict.kind !== 'ask' || verdict.reason !== 'sensitive_write') throw new Error('expected a sensitive_write ask');
      expect(verdict.sensitive).toEqual([{ path: `${ROOT}/src/tool.sh`, reason: 'executable_bit' }]);
    });

    it('given a sensitive write, the durable-approval subject should be the SPECIFIC PATH, never the policy root', () => {
      const verdict = write([`${ROOT}/a/.git/hooks/pre-commit`]);
      if (verdict.kind !== 'ask') throw new Error('expected ask');
      expect(verdict.subjects).toEqual([`file:${ROOT}/a/.git/hooks/pre-commit`]);
      // The ordinary write keeps the root subject it has always had.
      const ordinary = write([`${ROOT}/src/index.ts`], undefined, { machinePolicy: { ...machine, mode: 'ask', ops: [] } });
      if (ordinary.kind !== 'ask') throw new Error('expected ask');
      expect(ordinary.subjects).toEqual([`root:${ROOT}`]);
    });

    it('given a durable approval for one hook, should NOT cover a later write to another hook under the same root', () => {
      const covered: DurableApproval = { approvalId: 'a1', envId: grant.envId, userId: grant.principal.userId, op: 'fs_write', subject: `file:${ROOT}/a/.git/hooks/pre-commit`, scope: 'until_revoked', createdAt: 0, expiresAt: null };
      const same = write([`${ROOT}/a/.git/hooks/pre-commit`], undefined, { approvals: { ...approvals, entries: [covered] } });
      expect(same).toMatchObject({ kind: 'allow', basis: { kind: 'durable_approval', approvalIds: ['a1'] } });
      const other = write([`${ROOT}/b/.git/hooks/pre-commit`], undefined, { approvals: { ...approvals, entries: [covered] } });
      expect(other.kind).toBe('ask');
    });

    it('given a root-wide approval for the policy root, should NOT cover a sensitive write inside it (approving files is not approving hooks)', () => {
      const rootWide: DurableApproval = { approvalId: 'a2', envId: grant.envId, userId: grant.principal.userId, op: 'fs_write', subject: `root:${ROOT}`, scope: 'until_revoked', createdAt: 0, expiresAt: null };
      expect(write([`${ROOT}/.git/hooks/pre-commit`], undefined, { approvals: { ...approvals, entries: [rootWide] } }).kind).toBe('ask');
    });

    it('given the owner\'s click (a fresh approval over the frozen request), should allow — escalation is a question, not a refusal', () => {
      const asked = write([`${ROOT}/.git/hooks/pre-commit`], [0o755]);
      if (asked.kind !== 'ask') throw new Error('expected ask');
      const clicked = write([`${ROOT}/.git/hooks/pre-commit`], [0o755], { localApproval: { grantId: grant.grantId, approvedAt: 1, request: asked.request } });
      expect(clicked).toMatchObject({ kind: 'allow', basis: { kind: 'fresh_approval' } });
    });

    it('given an innocuous path that RESOLVES to a hook (a symlink inside the root), should escalate on the RESOLVED path — this is why the classifier runs after confinement', () => {
      const hook = `${ROOT}/.git/hooks/pre-commit`;
      const sneaky: PathProbe = { realpath: (p) => (p === `${ROOT}/notes.txt` ? hook : p), isSymlink: () => false };
      const verdict = decide({ grant: fsGrant, request: { op: 'fs_write', paths: [`${ROOT}/notes.txt`] }, probe: sneaky, approvals });
      if (verdict.kind !== 'ask' || verdict.reason !== 'sensitive_write') throw new Error('expected a sensitive_write ask');
      expect(verdict.sensitive).toEqual([{ path: hook, reason: 'vcs_metadata' }]);
      // And the approval it would write is keyed on the file that would really be written.
      expect(verdict.subjects).toEqual([`file:${hook}`]);
    });

    describe('the EXISTING mode counts, because a mode-less write does not chmod (Codex P1)', () => {
      const executables = new Set([`${ROOT}/bin/tool`]);
      const statMode = (path: string) => (executables.has(path) ? 0o755 : path === `${ROOT}/src/a.ts` ? 0o644 : null);

      it('given a mode-less write over an EXISTING executable file, should escalate — the replacement runs as the owner at its next invocation', () => {
        const verdict = write([`${ROOT}/bin/tool`], undefined, { statMode });
        if (verdict.kind !== 'ask' || verdict.reason !== 'sensitive_write') throw new Error('expected a sensitive_write ask');
        expect(verdict.sensitive).toEqual([{ path: `${ROOT}/bin/tool`, reason: 'executable_bit' }]);
        // And it is keyed on that FILE, so approving it never covers the next executable.
        expect(verdict.subjects).toEqual([`file:${ROOT}/bin/tool`]);
      });

      it('given a mode-less write over an existing NON-executable file, or a brand-new one, should still run headless', () => {
        expect(write([`${ROOT}/src/a.ts`], undefined, { statMode })).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
        expect(write([`${ROOT}/src/brand-new.ts`], undefined, { statMode })).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
      });

      it('given an explicit non-executable mode over an existing executable file, should run headless — the chmod strips the bit', () => {
        expect(write([`${ROOT}/bin/tool`], [0o644], { statMode })).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
      });

      it('should ask the probe ONLY for fs_write, only after confinement, and only about paths whose write names no mode', () => {
        const asked: string[] = [];
        const recording = (path: string) => {
          asked.push(path);
          return null;
        };
        write([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`], [0o644, null], { statMode: recording });
        // Only the mode-less path, and by its CONFINED name.
        expect(asked).toEqual([`${ROOT}/src/b.ts`]);
        asked.length = 0;
        decide({ grant: { ...grant, op: 'fs_read' }, request: { op: 'fs_read', paths: [`${ROOT}/src/a.ts`] }, probe, approvals, statMode: recording });
        expect(asked).toEqual([]);
        asked.length = 0;
        decide({ request, probe, approvals, statMode: recording });
        expect(asked).toEqual([]);
      });

      it('should ask the probe at most ONCE per path, even though the classifier and the approval subject both need the answer', () => {
        const asked: string[] = [];
        const counting = (path: string) => {
          asked.push(path);
          return 0o755;
        };
        write([`${ROOT}/bin/tool`], undefined, { statMode: counting });
        expect(asked).toEqual([`${ROOT}/bin/tool`]);
      });

      it('given a probe that THROWS, should not throw, and should still escalate a REQUESTED executable bit', () => {
        const throwing = () => {
          throw new Error('EACCES');
        };
        expect(() => write([`${ROOT}/bin/tool`], undefined, { statMode: throwing })).not.toThrow();
        expect(write([`${ROOT}/bin/tool`], undefined, { statMode: throwing })).toMatchObject({ kind: 'allow' });
        expect(write([`${ROOT}/bin/tool`], [0o755], { statMode: throwing })).toMatchObject({ kind: 'ask', reason: 'sensitive_write' });
      });

      it('given no probe at all, should behave exactly as it did before it existed', () => {
        expect(write([`${ROOT}/bin/tool`])).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
      });
    });

    it('given a DENY-worthy sensitive write (a path outside every root), should still deny — deny beats ask', () => {
      expect(write(['/etc/.git/hooks/pre-commit'])).toEqual({ kind: 'deny', reason: 'path_denied' });
    });

    it('given a sensitive write in a policy that denies the op, should deny, never ask', () => {
      expect(write([`${ROOT}/.git/hooks/pre-commit`], undefined, { machinePolicy: { ...machine, ops: [] } })).toEqual({ kind: 'deny', reason: 'machine_denied' });
    });

    it('given a sensitive READ (fs_read of a hook), should not escalate — only writes can plant a command', () => {
      expect(decide({ grant: { ...grant, op: 'fs_read' }, request: { op: 'fs_read', paths: [`${ROOT}/.git/hooks/pre-commit`] }, probe, approvals })).toMatchObject({ kind: 'allow', basis: { kind: 'preapproved_op' } });
    });
  });

  describe('malformed request shapes are refused BEFORE the policy gates ("allow" must mean executable)', () => {
    it.each<[string, Partial<typeof request>]>([
      ['exec with no cmd', { cmd: undefined }],
      ['exec with an empty cmd', { cmd: '' }],
      ['exec with a whitespace-only cmd', { cmd: '   ' }],
    ])('given %s, should deny malformed', (_label, patch) => {
      expect(decide({ request: { ...request, ...patch } })).toEqual({ kind: 'deny', reason: 'malformed' });
    });

    it.each<['fs_read' | 'fs_write', string[] | undefined]>([
      ['fs_read', undefined],
      ['fs_read', []],
      ['fs_write', undefined],
      ['fs_write', []],
    ])('given %s with paths %j, should deny malformed', (op, paths) => {
      expect(decide({ grant: { ...grant, op }, request: { op, paths } })).toEqual({ kind: 'deny', reason: 'malformed' });
    });

    it.each<[string, Record<string, unknown>]>([
      ['a null entry in paths', { op: 'fs_read', paths: [null] }],
      ['a numeric entry in paths', { op: 'fs_read', paths: [42] }],
      ['an empty-string entry in paths', { op: 'fs_read', paths: [''] }],
      ['a non-array paths', { op: 'fs_read', paths: '/x' }],
      ['a non-string cwd', { op: 'exec', cmd: 'ls', cwd: null }],
      ['a numeric cmd', { op: 'exec', cmd: 42 }],
      ['a non-string entry in args', { op: 'exec', cmd: 'ls', args: ['-la', 1] }],
      ['a non-array args', { op: 'exec', cmd: 'ls', args: '-la' }],
      ['a non-object env', { op: 'exec', cmd: 'ls', env: 'LANG=C' }],
      ['a null env', { op: 'exec', cmd: 'ls', env: null }],
      ['an array env', { op: 'exec', cmd: 'ls', env: ['LANG=C'] }],
    ])('given %s (a hostile frame), should deny malformed and NEVER throw (CodeRabbit)', (_label, raw) => {
      const op = raw.op as 'exec' | 'fs_read';
      const hostile = raw as unknown as Parameters<typeof decideExecution>[0]['request'];
      const g = { ...grant, op };
      expect(() => decide({ grant: g, request: hostile })).not.toThrow();
      expect(decide({ grant: g, request: hostile })).toEqual({ kind: 'deny', reason: 'malformed' });
    });

    it('given a malformed shape AND a null policy, should deny malformed (shape is checked first)', () => {
      expect(decide({ machinePolicy: null, request: { ...request, cmd: '' } })).toEqual({ kind: 'deny', reason: 'malformed' });
    });

    it('given pty_open with no cmd, should NOT be malformed (the shell is the default)', () => {
      const ptyGrant = { ...grant, op: 'pty_open' as const };
      expect(decide({ grant: ptyGrant, machinePolicy: { ...machine, ops: ['pty_open'] }, request: { op: 'pty_open' } }).kind).toBe('allow');
    });
  });

  it('should enforce the deny order for EVERY adjacent pair of gates (each row breaks two adjacent gates and expects the earlier)', () => {
    type Input = Parameters<typeof decideExecution>[0];
    // Breakers in gate order. Each makes exactly its own gate fail when applied alone.
    const breakers: ReadonlyArray<[string, (i: Input) => Input]> = [
      ['malformed', (i) => ({ ...i, request: { ...i.request, cmd: '' } })],
      ['no_policy', (i) => ({ ...i, machinePolicy: null })],
      ['policy_deny', (i) => ({ ...i, machinePolicy: i.machinePolicy && { ...i.machinePolicy, mode: 'deny' } })],
      ['principal_not_allowed', (i) => ({ ...i, grant: { ...i.grant, principal: { ...i.grant.principal, userId: 'rogue' } } })],
      ['op_mismatch', (i) => ({ ...i, request: { ...i.request, op: 'fs_read', paths: [`${ROOT}/f`] } })],
      ['op_not_advertised', (i) => ({ ...i, capabilities: { ...i.capabilities, shell: false, fs: false } })],
      ['server_denied', (i) => ({ ...i, serverPolicy: { ops: [], checkpoint: false } })],
      ['machine_denied', (i) => ({ ...i, machinePolicy: i.machinePolicy && { ...i.machinePolicy, ops: [] } })],
      ['cwd_denied', (i) => ({ ...i, request: { ...i.request, cwd: '/etc' } })],
      ['path_denied', (i) => ({ ...i, request: { ...i.request, paths: ['/etc/passwd'] } })],
    ];
    const base: Input = { grant, request, machinePolicy: machine, serverPolicy: server, capabilities: advertised, probe: identityProbe };
    for (let n = 0; n + 1 < breakers.length; n += 1) {
      const [earlier, breakEarlier] = breakers[n] as [string, (i: Input) => Input];
      const [later, breakLater] = breakers[n + 1] as [string, (i: Input) => Input];
      // Apply the LATER breaker first so the earlier one's effect is never overwritten.
      const verdict = decideExecution(breakEarlier(breakLater(base)));
      expect(verdict, `${earlier} must beat ${later}`).toEqual({ kind: 'deny', reason: earlier });
    }
  });

  it('should enforce a fixed deny order: no_policy → policy_deny → principal → op_mismatch → advertised → server → machine → paths', () => {
    const verdict = decide({
      grant: { ...grant, principal: { ...grant.principal, userId: 'rogue' } },
      capabilities: { ...advertised, shell: false },
      serverPolicy: { ops: [], checkpoint: false },
      machinePolicy: { ...machine, ops: [] },
      request: { ...request, cwd: '/etc' },
    });
    expect(verdict).toEqual({ kind: 'deny', reason: 'principal_not_allowed' });
  });

  it('should never probe a REQUEST path for a request denied by a policy gate (realpath may be called on owner-declared roots only)', () => {
    const requestCalls: string[] = [];
    const spy: PathProbe = { realpath: (p) => { if (p !== ROOT) requestCalls.push(p); return p; }, isSymlink: () => false };
    decide({ machinePolicy: null, probe: spy });
    decide({ serverPolicy: { ops: [], checkpoint: false }, probe: spy });
    decide({ machinePolicy: { ...machine, ops: [] }, probe: spy });
    expect(requestCalls).toEqual([]);
  });

  it('should be pure: identical inputs yield identical verdicts and never mutate the request', () => {
    const before = JSON.stringify(request);
    const a = decide();
    const b = decide();
    expect(a).toEqual(b);
    expect(JSON.stringify(request)).toBe(before);
  });
});

describe('GA wave 2 — durable approvals are consulted AFTER confinePath and scrubEnv, against the normalised request', () => {
  const askPolicy: MachinePolicy = { ...machine, mode: 'ask', ops: [] };
  const BIN: Record<string, string> = { ls: '/bin/ls', rm: '/bin/rm' };
  const resolveArgv0 = (name: string) => BIN[name] ?? null;
  const lsApproval: DurableApproval = { approvalId: 'ap1', envId: grant.envId, userId: grant.principal.userId, op: 'exec', subject: 'exec:/bin/ls', scope: '30d', createdAt: 0, expiresAt: 100_000 };
  const consult = (entries: DurableApproval[] = [lsApproval], now = 50_000) => ({ entries, now, resolveArgv0 });

  it('given a live durable approval for the subject, should allow with basis durable_approval naming the approval id', () => {
    expect(decide({ machinePolicy: askPolicy, approvals: consult() })).toEqual({ kind: 'allow', request: NORMALIZED, basis: { kind: 'durable_approval', approvalIds: ['ap1'] } });
  });

  it('given no covering approval, should ask and carry the SUBJECTS a click would approve', () => {
    expect(decide({ machinePolicy: askPolicy, approvals: consult([]) })).toEqual({ kind: 'ask', reason: 'op_not_preapproved', request: NORMALIZED, subjects: ['exec:/bin/ls'] });
    expect(decide({ machinePolicy: askPolicy, request: { ...request, cmd: 'rm' }, approvals: consult() })).toMatchObject({ kind: 'ask', subjects: ['exec:/bin/rm'] });
  });

  it('given only an expired approval, should ask (the daemon prunes it)', () => {
    expect(decide({ machinePolicy: askPolicy, approvals: consult([lsApproval], 100_000) })).toMatchObject({ kind: 'ask' });
  });

  it('given an unresolvable subject, should ask with subjects null — nothing durable can ever be written for it', () => {
    expect(decide({ machinePolicy: askPolicy, request: { ...request, cmd: 'sh', args: ['-c', 'ls $(rm x)'] }, approvals: consult() })).toMatchObject({ kind: 'ask', subjects: null });
  });

  it('given every policy gate fails, the approval is never consulted: a denied request stays denied whatever the file says', () => {
    expect(decide({ machinePolicy: { ...askPolicy, principals: ['someone_else'] }, approvals: consult() })).toEqual({ kind: 'deny', reason: 'principal_not_allowed' });
    expect(decide({ machinePolicy: askPolicy, request: { ...request, cwd: '/etc' }, approvals: consult() })).toEqual({ kind: 'deny', reason: 'cwd_denied' });
  });

  it('given a file op, the subject is the ROOT the confined path resolves inside — a retargeted symlink to another root cannot ride the first root\'s approval', () => {
    const roots = [ROOT, '/srv/other'];
    const policy: MachinePolicy = { ...askPolicy, roots };
    const rootApproval: DurableApproval = { ...lsApproval, op: 'fs_read', subject: `root:${ROOT}` };
    const readGrant = { ...grant, op: 'fs_read' as const };
    const readRequest = { op: 'fs_read' as const, paths: [`${ROOT}/link`] };
    const inRoot: PathProbe = { realpath: (p) => (p === `${ROOT}/link` ? `${ROOT}/real.txt` : p), isSymlink: () => false };
    expect(decide({ machinePolicy: policy, grant: readGrant, request: readRequest, probe: inRoot, approvals: consult([rootApproval]) })).toMatchObject({ kind: 'allow', basis: { kind: 'durable_approval' } });
    const retargeted: PathProbe = { realpath: (p) => (p === `${ROOT}/link` ? '/srv/other/secret' : p), isSymlink: () => false };
    expect(decide({ machinePolicy: policy, grant: readGrant, request: readRequest, probe: retargeted, approvals: consult([rootApproval]) })).toMatchObject({ kind: 'ask', subjects: ['root:/srv/other'] });
  });

  it('given a fresh localApproval for this grant, that path answers first and stays byte-compared (untouched)', () => {
    const asked = decide({ machinePolicy: askPolicy, approvals: consult([]) });
    if (asked.kind !== 'ask') throw new Error('expected ask');
    expect(decide({ machinePolicy: askPolicy, approvals: consult([]), localApproval: { grantId: grant.grantId, approvedAt: 30_000, request: asked.request } })).toEqual({ kind: 'allow', request: asked.request, basis: { kind: 'fresh_approval' } });
    expect(decide({ machinePolicy: askPolicy, approvals: consult([]), localApproval: { grantId: grant.grantId, approvedAt: 30_000, request: { ...asked.request, cmd: 'rm' } } })).toEqual({ kind: 'deny', reason: 'approval_mismatch' });
  });
});
