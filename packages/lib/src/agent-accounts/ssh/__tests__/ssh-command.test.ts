import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeSshCommand, normalizeSshTarget, sshCommandBody, sshFingerprintOf, sshTargetOf } from '../ssh-command';
import { digestRequest } from '../../digest-request';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha3 = (bytes: Uint8Array) => createHash('sha3-256').update(bytes).digest('hex');

describe('normalizeSshTarget / sshTargetOf', () => {
  it('given a host in any case, an IP or an IPv6 literal, should pin one canonical ssh:// target (port 22 by default) and read it back', () => {
    const actual = [normalizeSshTarget({ host: ' Build.Example.COM ', port: null }), normalizeSshTarget({ host: '203.0.113.7', port: 2222 }), normalizeSshTarget({ host: '[2001:db8::1]', port: 22 })].map((verdict) => (verdict.ok ? verdict.target : verdict.reason));
    expect({ targets: actual, back: actual.map((target) => sshTargetOf(target)?.port) }).toEqual({ targets: ['ssh://build.example.com:22', 'ssh://203.0.113.7:2222', 'ssh://[2001:db8::1]:22'], back: [22, 2222, 22] });
  });

  it('given a URL, a user@host, a path, a bad port or another scheme, should refuse', () => {
    const actual = [normalizeSshTarget({ host: 'ssh://x.com', port: 22 }), normalizeSshTarget({ host: 'root@x.com', port: 22 }), normalizeSshTarget({ host: 'x.com/etc', port: 22 }), normalizeSshTarget({ host: 'x.com', port: 70_000 }), normalizeSshTarget({ host: '', port: 22 })].map((verdict) => (verdict.ok ? 'ok' : verdict.reason));
    expect({ normalized: actual, read: [sshTargetOf('https://x.com:22'), sshTargetOf('ssh://X.com:22'), sshTargetOf('ssh://x.com:022')] }).toEqual({ normalized: ['host_invalid', 'host_invalid', 'host_invalid', 'port_invalid', 'host_invalid'], read: [null, null, null] });
  });
});

describe('canonicalizeSshCommand', () => {
  it('given a command, should digest exactly the command and its input, and class it unknown/ssh.exec', () => {
    const of = (command: string, stdin = '') => canonicalizeSshCommand({ target: 'ssh://build.example.com:22', command, stdin, sha256 });
    const a = of('uptime');
    const b = of('uptime ');
    const c = of('uptime', 'x');
    const digest = (verdict: ReturnType<typeof of>) => (verdict.ok ? digestRequest({ canonical: verdict.canonical, hash: sha3 }) : verdict.reason);
    expect({
      operation: a.ok && a.canonical.operation,
      body: a.ok && a.canonical.bodySha256 === sha256(sshCommandBody({ command: 'uptime', stdin: '' })),
      distinct: new Set([digest(a), digest(b), digest(c)]).size,
    }).toEqual({ operation: { class: 'unknown', name: 'ssh.exec' }, body: true, distinct: 3 });
  });

  it('given an empty command, a NUL, a command or input over its cap, or a target that is not ssh://, should refuse', () => {
    const actual = [
      canonicalizeSshCommand({ target: 'ssh://h.example:22', command: '  ', stdin: '', sha256 }),
      canonicalizeSshCommand({ target: 'ssh://h.example:22', command: 'a\u0000b', stdin: '', sha256 }),
      canonicalizeSshCommand({ target: 'ssh://h.example:22', command: 'x'.repeat(8 * 1024 + 1), stdin: '', sha256 }),
      canonicalizeSshCommand({ target: 'ssh://h.example:22', command: 'cat', stdin: 'y'.repeat(256 * 1024 + 1), sha256 }),
      canonicalizeSshCommand({ target: 'https://h.example:443', command: 'ls', stdin: '', sha256 }),
    ].map((verdict) => (verdict.ok ? 'ok' : verdict.reason));
    expect(actual).toEqual(['command_invalid', 'command_invalid', 'command_invalid', 'stdin_too_large', 'target_invalid']);
  });
});

describe('canonicalizeSshCommand — what the approval card could not show', () => {
  it('given bidi overrides, zero-width characters or control characters in the command or its input, should refuse; tabs and newlines are fine', () => {
    const of = (command: string, stdin = '') => canonicalizeSshCommand({ target: 'ssh://h.example:22', command, stdin, sha256 });
    const actual = [of('ls \u202E#txt.hs'), of('rm\u200B -rf ~'), of('echo \u0007'), of('cat', 'x\u2066y'), of('printf "a\tb\n"', 'line1\nline2\r\n')].map((verdict) => (verdict.ok ? 'ok' : verdict.reason));
    expect(actual).toEqual(['command_invalid', 'command_invalid', 'command_invalid', 'command_invalid', 'ok']);
  });
});

describe('sshFingerprintOf', () => {
  it('given a key blob, should print it as OpenSSH does (SHA256:, unpadded base64)', () => {
    const blob = new Uint8Array([1, 2, 3]);
    expect(sshFingerprintOf({ publicKeyBlob: blob, sha256Base64: (bytes) => createHash('sha256').update(bytes).digest('base64') })).toBe(`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`);
  });
});
