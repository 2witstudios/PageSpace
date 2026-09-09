/**
 * `grantArgsForFrame` — the ONE definition of what a grant's `argsHash`
 * covers, per op (Codex C7 on master @ f471f4b44: "argsHash projection
 * undefined per op").
 *
 * The server signer (t07) and the daemon gate (`verifyGrant` → `decideExecution`)
 * must hash byte-identical input or every grant fails `args_mismatch` — or,
 * worse, a field the signer left out of its hash is free for a MITM to change.
 * So each projection here is pinned three ways: the exact object, the exact
 * key ORDER, and the exact canonical bytes. Dropping, adding or reordering a
 * field goes red.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { grantArgsForFrame, grantRequestForFrame, executionRequestForFrame, GRANT_FRAME_TYPES, type GrantFrame } from '../grant-args';
import { canonicalizeArgs } from '../grant';
import { decodeFrame, encodeFrame } from '../frame-codec';
import { decideExecution } from '../decide-execution';
import type { MachinePolicy, ServerPolicy, AdvertisedCapabilities } from '../policy-types';
import type { PathProbe } from '../confine-path';

const GRANT = { grantId: 'g1' };
const SIG = 'AAAA';
const bytes = (v: unknown) => Buffer.from(canonicalizeArgs(v)).toString('utf8');
const sha = (v: unknown) => createHash('sha256').update(canonicalizeArgs(v)).digest('hex');

const execFull: GrantFrame = { type: 'grant_exec', grant: GRANT, sig: SIG, cmd: 'ls', args: ['-la'], cwd: '/home/u/proj', env: { LANG: 'C' }, timeoutMs: 10_000, maxBytes: 1024 };
const execMin: GrantFrame = { type: 'grant_exec', grant: GRANT, sig: SIG, cmd: 'ls' };
const fsRead: GrantFrame = { type: 'grant_fs_read', grant: GRANT, sig: SIG, paths: ['/home/u/proj/a', '/home/u/proj/b'] };
const fsWrite: GrantFrame = { type: 'grant_fs_write', grant: GRANT, sig: SIG, files: [{ path: '/home/u/proj/a', contentB64: 'aGk=', mode: 0o644 }, { path: '/home/u/proj/b', contentB64: '' }] };
const ptyFull: GrantFrame = { type: 'grant_pty_open', grant: GRANT, sig: SIG, cols: 80, rows: 24, cwd: '/home/u/proj', command: 'zsh', args: ['-l'] };
const ptyMin: GrantFrame = { type: 'grant_pty_open', grant: GRANT, sig: SIG, cols: 80, rows: 24 };

describe('grantArgsForFrame — one exact args object per op, pinned by object, key order and canonical bytes', () => {
  it('grant_exec: cmd, args, cwd, env, timeoutMs, maxBytes — in that order, always present', () => {
    const args = grantArgsForFrame(execFull);
    expect(args).toStrictEqual({ cmd: 'ls', args: ['-la'], cwd: '/home/u/proj', env: { LANG: 'C' }, timeoutMs: 10_000, maxBytes: 1024 });
    expect(Object.keys(args)).toEqual(['cmd', 'args', 'cwd', 'env', 'timeoutMs', 'maxBytes']);
    expect(bytes(args)).toBe('{"args":["-la"],"cmd":"ls","cwd":"/home/u/proj","env":{"LANG":"C"},"maxBytes":1024,"timeoutMs":10000}');
  });

  it('grant_exec with every optional absent: the SAME field set, absent ⇒ null / [] / {} — never undefined, never a missing key', () => {
    const args = grantArgsForFrame(execMin);
    expect(args).toStrictEqual({ cmd: 'ls', args: [], cwd: null, env: {}, timeoutMs: null, maxBytes: null });
    expect(Object.keys(args)).toEqual(['cmd', 'args', 'cwd', 'env', 'timeoutMs', 'maxBytes']);
    expect(Object.values(args)).not.toContain(undefined);
    expect(bytes(args)).toBe('{"args":[],"cmd":"ls","cwd":null,"env":{},"maxBytes":null,"timeoutMs":null}');
  });

  it('grant_fs_read: paths', () => {
    const args = grantArgsForFrame(fsRead);
    expect(args).toStrictEqual({ paths: ['/home/u/proj/a', '/home/u/proj/b'] });
    expect(Object.keys(args)).toEqual(['paths']);
    expect(bytes(args)).toBe('{"paths":["/home/u/proj/a","/home/u/proj/b"]}');
  });

  it('grant_fs_write: files, each exactly {path, contentB64, mode} in that order (mode absent ⇒ null) — the CONTENT is signed, not just the path', () => {
    const args = grantArgsForFrame(fsWrite);
    expect(args).toStrictEqual({ files: [{ path: '/home/u/proj/a', contentB64: 'aGk=', mode: 0o644 }, { path: '/home/u/proj/b', contentB64: '', mode: null }] });
    expect(Object.keys(args)).toEqual(['files']);
    expect(Object.keys((args as { files: object[] }).files[0]!)).toEqual(['path', 'contentB64', 'mode']);
    expect(bytes(args)).toBe('{"files":[{"contentB64":"aGk=","mode":420,"path":"/home/u/proj/a"},{"contentB64":"","mode":null,"path":"/home/u/proj/b"}]}');
  });

  it('grant_pty_open: cols, rows, cwd, command, args — in that order, always present', () => {
    expect(grantArgsForFrame(ptyFull)).toStrictEqual({ cols: 80, rows: 24, cwd: '/home/u/proj', command: 'zsh', args: ['-l'] });
    expect(Object.keys(grantArgsForFrame(ptyFull))).toEqual(['cols', 'rows', 'cwd', 'command', 'args']);
    expect(bytes(grantArgsForFrame(ptyFull))).toBe('{"args":["-l"],"cols":80,"command":"zsh","cwd":"/home/u/proj","rows":24}');
    expect(grantArgsForFrame(ptyMin)).toStrictEqual({ cols: 80, rows: 24, cwd: null, command: null, args: [] });
    expect(bytes(grantArgsForFrame(ptyMin))).toBe('{"args":[],"cols":80,"command":null,"cwd":null,"rows":24}');
  });

  it('should never leak the envelope (type, grant, sig) or any unknown field into the hashed args', () => {
    const smuggled = { ...execFull, isAdmin: true, sudo: 'yes' } as unknown as GrantFrame;
    const args = grantArgsForFrame(smuggled) as unknown as Record<string, unknown>;
    for (const key of ['type', 'grant', 'sig', 'isAdmin', 'sudo']) expect(args).not.toHaveProperty(key);
  });

  it('should keep "absent" and "empty" distinct in the bytes (cwd omitted ≠ cwd "")', () => {
    expect(bytes(grantArgsForFrame(execMin))).not.toBe(bytes(grantArgsForFrame({ ...execMin, cwd: '' })));
    expect(sha(grantArgsForFrame(execMin))).not.toBe(sha(grantArgsForFrame({ ...execMin, args: [''] })));
  });

  it('should be a fresh object, not the frame itself — the frame is untrusted and mutable', () => {
    const args = grantArgsForFrame(execFull);
    expect(args).not.toBe(execFull);
    expect((args as { env: Record<string, string> }).env).not.toBe(execFull.type === 'grant_exec' ? execFull.env : undefined);
  });

  it('should survive a codec round trip byte-for-byte — what the signer hashes before encoding is what the daemon hashes after decoding', () => {
    for (const frame of [execFull, execMin, fsRead, fsWrite, ptyFull, ptyMin]) {
      const decoded = decodeFrame(encodeFrame(frame), { maxFrameBytes: 65536 });
      if (!decoded.ok) throw new Error(`decode failed: ${decoded.reason}`);
      expect(bytes(grantArgsForFrame(decoded.frame as GrantFrame))).toBe(bytes(grantArgsForFrame(frame)));
    }
  });
});

describe('grantRequestForFrame — the {op, args} pair verifyGrant binds the grant to', () => {
  it.each([
    ['grant_exec', 'exec', execFull],
    ['grant_fs_read', 'fs_read', fsRead],
    ['grant_fs_write', 'fs_write', fsWrite],
    ['grant_pty_open', 'pty_open', ptyFull],
  ] as const)('%s ⇒ op %s with the projection as args', (_type, op, frame) => {
    expect(grantRequestForFrame(frame)).toStrictEqual({ op, args: grantArgsForFrame(frame) });
  });

  it('should cover exactly the four grant-carrying frame types', () => {
    expect([...GRANT_FRAME_TYPES]).toEqual(['grant_exec', 'grant_fs_read', 'grant_fs_write', 'grant_pty_open']);
  });
});

describe('executionRequestForFrame — decideExecution consumes the SAME projection', () => {
  const ROOT = '/home/u/proj';
  const probe: PathProbe = { realpath: (p) => p, isSymlink: () => false };
  const machine: MachinePolicy = { mode: 'allowlist', principals: ['user_1'], ops: ['exec', 'fs_read', 'fs_write', 'pty_open'], roots: [ROOT], envAllowlist: ['LANG'], maxBytes: 4096, maxTimeoutMs: 30_000 };
  const server: ServerPolicy = { ops: ['exec', 'fs_read', 'fs_write', 'pty_open'], checkpoint: false };
  const advertised: AdvertisedCapabilities = { shell: true, pty: true, fs: true, checkpoint: false };
  const principal = { userId: 'user_1', sessionId: 's1', conversationId: 'c1' };

  it('grant_exec ⇒ an exec request built from the projection (null ⇒ absent, so the shape gate sees a well-formed request)', () => {
    expect(executionRequestForFrame(execFull)).toStrictEqual({ op: 'exec', cmd: 'ls', args: ['-la'], cwd: ROOT, env: { LANG: 'C' }, timeoutMs: 10_000, maxBytes: 1024 });
    expect(executionRequestForFrame(execMin)).toStrictEqual({ op: 'exec', cmd: 'ls', args: [], env: {} });
  });

  it('grant_fs_read ⇒ paths; grant_fs_write ⇒ the files\' paths AND their modes, index-aligned (hardening A1)', () => {
    expect(executionRequestForFrame(fsRead)).toStrictEqual({ op: 'fs_read', paths: ['/home/u/proj/a', '/home/u/proj/b'] });
    // The mode is what makes a write executable, so the decision layer must see
    // it: `writeModes` is index-aligned with `paths`, and a file with no mode
    // holds its place as `null` rather than being omitted.
    expect(executionRequestForFrame(fsWrite)).toStrictEqual({ op: 'fs_write', paths: ['/home/u/proj/a', '/home/u/proj/b'], writeModes: [0o644, null] });
  });

  it('A1: writeModes is set for fs_write ONLY — an fs_read or an exec never carries one', () => {
    for (const frame of [execFull, execMin, fsRead, ptyFull, ptyMin]) {
      expect(executionRequestForFrame(frame)).not.toHaveProperty('writeModes');
    }
  });

  it('A1: writeModes stays aligned when EVERY file omits its mode (all null, never an empty array)', () => {
    const noModes: GrantFrame = { type: 'grant_fs_write', grant: GRANT, sig: SIG, files: [{ path: '/home/u/proj/a', contentB64: '' }, { path: '/home/u/proj/b', contentB64: '' }] };
    expect(executionRequestForFrame(noModes)).toStrictEqual({ op: 'fs_write', paths: ['/home/u/proj/a', '/home/u/proj/b'], writeModes: [null, null] });
  });

  it('grant_pty_open ⇒ cmd from command, args, cwd', () => {
    expect(executionRequestForFrame(ptyFull)).toStrictEqual({ op: 'pty_open', cmd: 'zsh', args: ['-l'], cwd: ROOT });
    expect(executionRequestForFrame(ptyMin)).toStrictEqual({ op: 'pty_open', args: [] });
  });

  it.each([
    ['grant_exec', execFull, { cmd: 'ls', args: ['-la'], cwd: `${ROOT}`, paths: [] }],
    ['grant_fs_read', fsRead, { cwd: ROOT, paths: ['/home/u/proj/a', '/home/u/proj/b'] }],
    ['grant_fs_write', fsWrite, { cwd: ROOT, paths: ['/home/u/proj/a', '/home/u/proj/b'] }],
    ['grant_pty_open', ptyFull, { cmd: 'zsh', args: ['-l'], cwd: ROOT, paths: [] }],
  ] as const)('%s: a grant whose argsHash is the projection hash is ALLOWED end to end with the frame\'s own fields', (_t, frame, expected) => {
    const request = grantRequestForFrame(frame);
    const grant = { grantId: 'g1', envId: 'env1', principal, op: request.op, argsHash: sha(request.args), iat: 0, exp: 60_000, nonce: 'n1' };
    const verdict = decideExecution({ grant, request: executionRequestForFrame(frame), machinePolicy: machine, serverPolicy: server, capabilities: advertised, probe });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind !== 'allow') return;
    expect(verdict.request).toMatchObject(expected);
  });
});
