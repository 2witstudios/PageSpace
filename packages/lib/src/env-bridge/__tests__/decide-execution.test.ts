import { describe, it, expect } from 'vitest';
import { decideExecution } from '../decide-execution';
import type { Grant } from '../grant';
import type { MachinePolicy, ServerPolicy, AdvertisedCapabilities } from '../policy-types';
import type { PathProbe } from '../confine-path';

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

const NORMALIZED = {
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
      expect(decide({ machinePolicy: { ...machine, mode: 'deny', ops: [op] }, grant: { ...grant, op }, request: { ...request, op } })).toEqual({ kind: 'deny', reason: 'policy_deny' });
    }
  });

  it('given the grant principal not in machinePolicy.principals, should deny principal_not_allowed (the machine owner decides who may drive it)', () => {
    expect(decide({ grant: { ...grant, principal: { ...grant.principal, userId: 'user_admin' } } })).toEqual({ kind: 'deny', reason: 'principal_not_allowed' });
  });

  it('given the request op differs from the grant op, should deny op_mismatch (defense in depth behind verifyGrant)', () => {
    expect(decide({ request: { ...request, op: 'fs_read' } })).toEqual({ kind: 'deny', reason: 'op_mismatch' });
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
    expect(decide()).toEqual({ kind: 'allow', request: NORMALIZED });
  });

  describe('the ask → allow seam (major: approval must be pure and bound to the grant)', () => {
    const askPolicy: MachinePolicy = { ...machine, mode: 'ask', ops: ['fs_read'] };

    it('given mode ask and an op NOT pre-approved, should return ask carrying the exact NormalizedRequest the owner is approving (confined + scrubbed BEFORE asking)', () => {
      expect(decide({ machinePolicy: askPolicy })).toEqual({ kind: 'ask', reason: 'op_not_preapproved', request: NORMALIZED });
    });

    it('given mode ask and an op that IS pre-approved, should allow without asking', () => {
      expect(decide({ machinePolicy: { ...machine, mode: 'ask' } })).toEqual({ kind: 'allow', request: NORMALIZED });
    });

    it('given mode ask, a non-pre-approved op, and localApproval for THIS grantId, should allow with the same NormalizedRequest', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { grantId: grant.grantId } })).toEqual({ kind: 'allow', request: NORMALIZED });
    });

    it('given localApproval for a DIFFERENT grantId, should still ask (an approval is bound to one grant)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { grantId: 'someone_elses_grant' } }).kind).toBe('ask');
    });

    it('given localApproval but the server denies the op, should deny server_denied (approval cannot override the server)', () => {
      expect(decide({ machinePolicy: askPolicy, serverPolicy: { ops: ['fs_read'], checkpoint: false }, localApproval: { grantId: grant.grantId } })).toEqual({ kind: 'deny', reason: 'server_denied' });
    });

    it('given localApproval in allowlist mode for a non-listed op, should deny machine_denied (approval is only an ask-mode concept)', () => {
      expect(decide({ machinePolicy: { ...machine, ops: ['fs_read'] }, localApproval: { grantId: grant.grantId } })).toEqual({ kind: 'deny', reason: 'machine_denied' });
    });

    it('given localApproval but a cwd outside every root, should deny cwd_denied (approval never bypasses confinement)', () => {
      expect(decide({ machinePolicy: askPolicy, localApproval: { grantId: grant.grantId }, request: { ...request, cwd: '/etc' } })).toEqual({ kind: 'deny', reason: 'cwd_denied' });
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
    expect(verdict).toEqual({ kind: 'allow', request: { op: 'fs_write', cwd: ROOT, paths: [`${ROOT}/src/new.ts`], env: {}, timeoutMs: machine.maxTimeoutMs, maxBytes: machine.maxBytes, clamped: false } });
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
