import { describe, it, expect } from 'vitest';
import { decideExecution } from '../decide-execution';
import type { Grant } from '../grant';
import type { MachinePolicy, ServerPolicy, AdvertisedCapabilities } from '../policy-types';

const ROOT = '/home/u/proj';
const identityRealpath = (p: string): string | null => p;

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

function decide(overrides: Partial<Parameters<typeof decideExecution>[0]> = {}) {
  return decideExecution({ grant, request, machinePolicy: machine, serverPolicy: server, capabilities: advertised, realpath: identityRealpath, ...overrides });
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

  it('given mode ask and an op NOT pre-approved, should return ask (never allow)', () => {
    expect(decide({ machinePolicy: { ...machine, mode: 'ask', ops: ['fs_read'] } })).toEqual({ kind: 'ask', reason: 'op_not_preapproved' });
  });

  it('given mode ask and an op that IS pre-approved, should allow without asking', () => {
    expect(decide({ machinePolicy: { ...machine, mode: 'ask' } }).kind).toBe('allow');
  });

  it('given mode ask but the server denies the op, should deny server_denied rather than ask (asking cannot override the server)', () => {
    expect(decide({ machinePolicy: { ...machine, mode: 'ask', ops: [] }, serverPolicy: { ops: ['fs_read'], checkpoint: false } })).toEqual({ kind: 'deny', reason: 'server_denied' });
  });

  it('given all three allow, should return allow with a NORMALIZED request: confined cwd, scrubbed env, clamped timeout and bytes', () => {
    const verdict = decide();
    expect(verdict.kind).toBe('allow');
    if (verdict.kind !== 'allow') return;
    expect(verdict.request).toEqual({
      op: 'exec',
      cmd: 'ls',
      args: ['-la'],
      cwd: `${ROOT}/src`,
      paths: [],
      env: { LANG: 'C' },
      timeoutMs: 10_000,
      maxBytes: 1024,
      clamped: false,
    });
  });

  it('given a request timeoutMs above the machine cap, should clamp (not deny) and record clamped: true', () => {
    const verdict = decide({ request: { ...request, timeoutMs: 999_999 } });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind !== 'allow') return;
    expect(verdict.request.timeoutMs).toBe(machine.maxTimeoutMs);
    expect(verdict.request.clamped).toBe(true);
  });

  it('given a request maxBytes above the machine cap, should clamp and record clamped: true', () => {
    const verdict = decide({ request: { ...request, maxBytes: 1_000_000 } });
    if (verdict.kind !== 'allow') throw new Error('expected allow');
    expect(verdict.request.maxBytes).toBe(machine.maxBytes);
    expect(verdict.request.clamped).toBe(true);
  });

  it('given no timeoutMs / maxBytes in the request, should apply the machine caps as the values', () => {
    const { timeoutMs: _t, maxBytes: _b, ...rest } = request;
    const verdict = decide({ request: rest });
    if (verdict.kind !== 'allow') throw new Error('expected allow');
    expect(verdict.request.timeoutMs).toBe(machine.maxTimeoutMs);
    expect(verdict.request.maxBytes).toBe(machine.maxBytes);
    expect(verdict.request.clamped).toBe(false);
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
    const realpath = (p: string) => (p === ROOT ? '/private/home/u/proj' : p.replace(ROOT, '/private/home/u/proj'));
    const verdict = decide({ grant: fsGrant, request: { op: 'fs_read', paths: [`${ROOT}/a.txt`] }, realpath });
    if (verdict.kind !== 'allow') throw new Error('expected allow');
    expect(verdict.request.paths).toEqual(['/private/home/u/proj/a.txt']);
  });

  it('should enforce a fixed deny order: no_policy → policy_deny → principal → op_mismatch → advertised → server → machine → paths', () => {
    // Everything wrong at once: a rogue principal, op not advertised, server denies,
    // machine denies, cwd outside root — principal_not_allowed must win.
    const verdict = decide({
      grant: { ...grant, principal: { ...grant.principal, userId: 'rogue' } },
      capabilities: { ...advertised, shell: false },
      serverPolicy: { ops: [], checkpoint: false },
      machinePolicy: { ...machine, ops: [] },
      request: { ...request, cwd: '/etc' },
    });
    expect(verdict).toEqual({ kind: 'deny', reason: 'principal_not_allowed' });
  });

  it('should never touch the filesystem for a denied request (realpath is not called before the policy gates pass)', () => {
    let calls = 0;
    const spy = (p: string) => { calls += 1; return p; };
    decide({ machinePolicy: null, realpath: spy });
    decide({ serverPolicy: { ops: [], checkpoint: false }, realpath: spy });
    decide({ machinePolicy: { ...machine, ops: [] }, realpath: spy });
    expect(calls).toBe(0);
  });

  it('should be pure: identical inputs yield identical verdicts and never mutate the request', () => {
    const before = JSON.stringify(request);
    const a = decide();
    const b = decide();
    expect(a).toEqual(b);
    expect(JSON.stringify(request)).toBe(before);
  });
});
