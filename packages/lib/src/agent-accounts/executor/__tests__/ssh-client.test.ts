/**
 * Slice 5 — the plane's SSH transport against a REAL ssh2 server on loopback.
 * Pinned: a confirmed host key runs the command and returns its output and
 * exit code; any other host key ends the handshake before the client ever
 * authenticates; a key the server does not accept is auth_failed; a private
 * address is refused before any connection; output is capped; a command still
 * running at the deadline is a timeout that may have run (`sent`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server, utils, type AuthContext, type Connection } from 'ssh2';
import { createSshClient, generateSshKeyPair } from '../ssh-client';
import { sshFingerprintOf } from '../../ssh/ssh-command';

const hostPair = generateSshKeyPair('host');
const otherHost = generateSshKeyPair('other');
const agentPair = generateSshKeyPair('agent');
const strangerPair = generateSshKeyPair('stranger');
const fingerprint = (publicKey: string) => {
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('bad key');
  return sshFingerprintOf({ publicKeyBlob: new Uint8Array(parsed.getPublicSSH()), sha256Base64: (bytes) => createHash('sha256').update(bytes).digest('base64') });
};
const authorized = utils.parseKey(agentPair.publicKey);

let server: Server;
let port = 0;
const authAttempts: string[] = [];

beforeAll(async () => {
  server = new Server({ hostKeys: [hostPair.privateKey] }, (connection: Connection) => {
    connection
      .on('authentication', (ctx: AuthContext) => {
        authAttempts.push(ctx.method);
        if (ctx.method !== 'publickey' || authorized instanceof Error || Array.isArray(authorized)) return ctx.reject(['publickey']);
        const same = ctx.key.algo === authorized.type && ctx.key.data.length === authorized.getPublicSSH().length && timingSafeEqual(ctx.key.data, authorized.getPublicSSH());
        if (!same) return ctx.reject(['publickey']);
        if (ctx.signature && ctx.blob && !authorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(['publickey']);
        return ctx.accept();
      })
      .on('ready', () =>
        connection.on('session', (accept) =>
          accept().once('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            let input = '';
            stream.on('data', (chunk: Buffer) => (input += chunk.toString()));
            if (info.command === 'sleep') return; // never exits
            stream.on('end', () => {
              if (info.command === 'flood') stream.write('x'.repeat(100_000));
              else stream.write(`ran ${info.command} with ${input}`);
              stream.stderr.write('note');
              stream.exit(3);
              stream.end();
            });
          }),
        ),
      )
      .on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

const client = (overrides: Partial<Parameters<typeof createSshClient>[0]> = {}) =>
  createSshClient({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], isPublic: () => true, limits: { connectTimeoutMs: 5_000, totalTimeoutMs: 3_000, maxOutputBytes: 1_000 }, ...overrides });
const run = (overrides: Partial<Parameters<ReturnType<typeof createSshClient>['exec']>[0]> = {}, clientOverrides = {}) =>
  client(clientOverrides).exec({ host: 'build.example.com', port, username: 'agent', privateKey: agentPair.privateKey, hostKeySha256: fingerprint(hostPair.publicKey), command: 'uptime', stdin: 'in', ...overrides });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('createSshClient', () => {
  it('given the confirmed host key and an authorized key, should run the command and return its output and exit code', async () => {
    const outcome = await run();
    expect(outcome.kind === 'exited' ? { out: text(outcome.stdout), err: text(outcome.stderr), code: outcome.exitCode, truncated: outcome.truncated } : outcome).toEqual({ out: 'ran uptime with in', err: 'note', code: 3, truncated: false });
  }, 20_000);

  it('given a server presenting any other host key, should stop before authenticating', async () => {
    const before = authAttempts.length;
    const outcome = await run({ hostKeySha256: fingerprint(otherHost.publicKey) });
    expect({ outcome, authAttempts: authAttempts.length - before }).toEqual({ outcome: { kind: 'failed', reason: 'host_key_mismatch', sent: false }, authAttempts: 0 });
  }, 20_000);

  it('given a key the server does not accept, should report auth_failed', async () => {
    expect(await run({ privateKey: strangerPair.privateKey })).toEqual({ kind: 'failed', reason: 'auth_failed', sent: false });
  }, 20_000);

  it('given a host that resolves to a private address, should refuse without connecting', async () => {
    const before = authAttempts.length;
    const outcome = await run({}, { isPublic: () => false });
    expect({ outcome, authAttempts: authAttempts.length - before }).toEqual({ outcome: { kind: 'failed', reason: 'address_refused', sent: false }, authAttempts: 0 });
  }, 20_000);

  it('given more output than the cap, should keep exactly the cap and say it was truncated', async () => {
    const outcome = await run({ command: 'flood' });
    expect(outcome.kind === 'exited' ? [outcome.stdout.byteLength + outcome.stderr.byteLength, outcome.truncated] : outcome).toEqual([1_000, true]);
  }, 20_000);

  it('given a command still running at the deadline, should report a timeout that may have run', async () => {
    expect(await run({ command: 'sleep' })).toEqual({ kind: 'failed', reason: 'timeout', sent: true });
  }, 20_000);

  it('given a host, should report the fingerprint it presents without authenticating', async () => {
    const before = authAttempts.length;
    const probe = await client().hostKey({ host: 'build.example.com', port });
    expect({ probe, authAttempts: authAttempts.length - before }).toEqual({ probe: { ok: true, fingerprint: fingerprint(hostPair.publicKey), algorithm: 'ssh-ed25519' }, authAttempts: 0 });
  }, 20_000);
});
