/**
 * The LOCAL environment `SandboxHost` (M1 · t09).
 *
 * Driven entirely through an in-memory `BridgeTransport`, which is the whole
 * point of the seam: the host has no socket, no crypto and no database of its
 * own, so everything it decides is observable from the frames it hands the
 * transport and the answers it accepts back.
 *
 * Two properties here are mutation-checked in the PR (they are the task's exit
 * criterion): a DISCONNECTED env never yields a handle, and a result the
 * transport refused is never returned.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLocalEnvSandboxHost,
  LocalEnvGrantDeniedError,
  LocalEnvUnexpectedResultError,
  type BridgeTransport,
} from '../local-env-sandbox-host';
import {
  LOCAL_ENV_SANDBOX_CAPABILITIES,
  LocalEnvNotConnectedError,
  LocalEnvUnsupportedError,
  localEnvSandboxId,
  parseLocalEnvSandboxId,
  SPRITE_SANDBOX_CAPABILITIES,
} from '../../sandbox-host';
import type { MachineResultFrame } from '../../../../env-bridge/machine-signatures';
import type { UnsignedGrantFrame } from '../../../../env-bridge/grant-args';

const ENV_ID = 'env-local-1';
const EPOCH = 'sess-1:1700000000000';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

interface Fake {
  transport: BridgeTransport;
  sent: UnsignedGrantFrame[];
  sendGrant: ReturnType<typeof vi.fn>;
}

function fakeTransport({
  connected = true,
  reply,
}: {
  connected?: boolean;
  reply?: (frame: UnsignedGrantFrame) => Promise<MachineResultFrame>;
} = {}): Fake {
  const sent: UnsignedGrantFrame[] = [];
  const sendGrant = vi.fn(async ({ frame }: { envId: string; frame: UnsignedGrantFrame }) => {
    sent.push(frame);
    if (!reply) throw new Error('no reply configured');
    return reply(frame);
  });
  return {
    sent,
    sendGrant,
    transport: {
      sendGrant: (input) => sendGrant(input),
      isConnected: () => connected,
      connectionEpoch: () => (connected ? EPOCH : null),
    },
  };
}

const execReply = (over: Partial<Extract<MachineResultFrame, { type: 'exec_result' }>> = {}): MachineResultFrame => ({
  type: 'exec_result',
  grantId: 'g1',
  exitCode: 0,
  stdoutB64: b64('hello\n'),
  stderrB64: b64(''),
  truncated: false,
  sig: b64('sig'),
  ...over,
});

async function connectedHandle(fake: Fake) {
  const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });
  return host.provision({ name: ENV_ID, substrate: { kind: 'local', envId: ENV_ID }, options: {} });
}

describe('createLocalEnvSandboxHost — binding to a live machine', () => {
  it('given a connected machine, provision should bind to it and address it by its DERIVED (never persisted) sandbox id', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);

    expect(handle.sandboxId).toBe(localEnvSandboxId(ENV_ID));
    expect(parseLocalEnvSandboxId(handle.sandboxId)).toBe(ENV_ID);
  });

  it("should carry the connection EPOCH as spriteInstanceId — an identity for this socket's generation, not a Fly id", async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    expect((await connectedHandle(fake)).spriteInstanceId).toBe(EPOCH);
  });

  it('should leave egressPolicyToken undefined — there is no lockdown to prove on a machine we do not own', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    expect((await connectedHandle(fake)).egressPolicyToken).toBeUndefined();
  });

  it('given a host built for one env, provision addressed at ANOTHER env should refuse rather than serve it', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });
    await expect(host.provision({ name: 'other', substrate: { kind: 'local', envId: 'env-other' }, options: {} })).rejects.toBeInstanceOf(
      LocalEnvNotConnectedError,
    );
  });
});

describe('createLocalEnvSandboxHost — a DISCONNECTED machine never falls through', () => {
  it('given no connection, provision should throw the typed LocalEnvNotConnectedError naming the env', async () => {
    const fake = fakeTransport({ connected: false });
    const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });

    await expect(host.provision({ name: ENV_ID, substrate: { kind: 'local', envId: ENV_ID }, options: {} })).rejects.toMatchObject({
      name: 'LocalEnvNotConnectedError',
      envId: ENV_ID,
    });
  });

  it('given no connection, attach should answer null — the seam\'s "it has vanished"', async () => {
    const fake = fakeTransport({ connected: false });
    const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });
    expect(await host.attach({ sandboxId: localEnvSandboxId(ENV_ID) })).toBeNull();
  });

  it('given no connection, NOTHING is sent — a bind never queues work on a machine that may never come back', async () => {
    const fake = fakeTransport({ connected: false });
    const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });
    await host.provision({ name: ENV_ID, substrate: { kind: 'local', envId: ENV_ID }, options: {} }).catch(() => null);
    await host.attach({ sandboxId: localEnvSandboxId(ENV_ID) });
    expect(fake.sendGrant).not.toHaveBeenCalled();
  });
});

describe('createLocalEnvSandboxHost — exec', () => {
  it('should send a grant_exec carrying exactly the command it was asked to run', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);

    await handle.exec({ cmd: 'sh', args: ['-c', 'echo hello'], cwd: '/w', env: { LANG: 'C' }, timeoutMs: 5000, maxBytes: 1024 });

    expect(fake.sent).toEqual([
      { type: 'grant_exec', cmd: 'sh', args: ['-c', 'echo hello'], cwd: '/w', env: { LANG: 'C' }, timeoutMs: 5000, maxBytes: 1024 },
    ]);
    expect(fake.sendGrant).toHaveBeenCalledWith(expect.objectContaining({ envId: ENV_ID }));
  });

  it('should omit fields the caller did not give, rather than sending nulls the signed projection would hash differently', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);
    await handle.exec({ cmd: 'ls' });
    expect(fake.sent[0]).toEqual({ type: 'grant_exec', cmd: 'ls' });
  });

  it('should decode the machine\'s base64 streams into the seam\'s own result shape', async () => {
    const fake = fakeTransport({ reply: async () => execReply({ exitCode: 3, stdoutB64: b64('out'), stderrB64: b64('err') }) });
    const handle = await connectedHandle(fake);
    expect(await handle.exec({ cmd: 'ls' })).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });

  it('given the MACHINE denied the grant, should surface the daemon\'s own reason — the machine is the policy enforcement point', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'grant_denied', grantId: 'g1', reason: 'principal_not_allowed', sig: b64('s') }) });
    const handle = await connectedHandle(fake);
    await expect(handle.exec({ cmd: 'ls' })).rejects.toMatchObject({ name: 'LocalEnvGrantDeniedError', reason: 'principal_not_allowed' });
  });

  it('given a verified frame of the WRONG type, should throw rather than coerce an exit code out of nothing', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'fs_write_result', grantId: 'g1', ok: true, sig: b64('s') }) });
    const handle = await connectedHandle(fake);
    await expect(handle.exec({ cmd: 'ls' })).rejects.toBeInstanceOf(LocalEnvUnexpectedResultError);
  });

  /**
   * EXIT CRITERION (mutation-checked): a result the transport refused —
   * `sendGrant` rejects when the machine signature does not verify (invariant
   * 7, `result-verifier.ts`) — must never reach the caller as data.
   */
  it('given the transport REFUSES the result (signature did not verify), should reject and return no data at all', async () => {
    const unverified = Object.assign(new Error('failed machine-signature verification'), { kind: 'unverified_result' });
    const fake = fakeTransport({ reply: async () => { throw unverified; } });
    const handle = await connectedHandle(fake);

    await expect(handle.exec({ cmd: 'ls' })).rejects.toBe(unverified);
  });
});

describe('createLocalEnvSandboxHost — files', () => {
  it('should sign the CONTENT of a write, not merely its path', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'fs_write_result', grantId: 'g1', ok: true, sig: b64('s') }) });
    const handle = await connectedHandle(fake);

    await handle.writeFiles([{ path: '/w/a.txt', content: 'hi', mode: 0o644 }, { path: '/w/b.bin', content: new Uint8Array([1, 2, 3]) }]);

    expect(fake.sent[0]).toEqual({
      type: 'grant_fs_write',
      files: [
        { path: '/w/a.txt', contentB64: b64('hi'), mode: 0o644 },
        { path: '/w/b.bin', contentB64: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    });
  });

  it('given the machine reports the write FAILED, should throw — writeFiles resolving is what every caller treats as proof the bytes landed', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'fs_write_result', grantId: 'g1', ok: false, error: 'permission_denied', sig: b64('s') }) });
    const handle = await connectedHandle(fake);
    await expect(handle.writeFiles([{ path: '/w/a', content: 'x' }])).rejects.toMatchObject({ reason: 'permission_denied' });
  });

  it('should read a file back through a grant_fs_read naming exactly that path', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'fs_read_result', grantId: 'g1', found: true, contentB64: b64('body'), sig: b64('s') }) });
    const handle = await connectedHandle(fake);

    expect(await handle.readFile({ path: '/w/a.txt' })).toEqual(Buffer.from('body'));
    expect(fake.sent[0]).toEqual({ type: 'grant_fs_read', paths: ['/w/a.txt'] });
  });

  it('given the machine says the file is not there, should answer null — the seam\'s documented miss, not a failure', async () => {
    const fake = fakeTransport({ reply: async () => ({ type: 'fs_read_result', grantId: 'g1', found: false, sig: b64('s') }) });
    const handle = await connectedHandle(fake);
    expect(await handle.readFile({ path: '/w/missing' })).toBeNull();
  });
});

describe('createLocalEnvSandboxHost — kill is a NON-destructive disconnect (invariants 8 and 9)', () => {
  it('should resolve successfully while sending nothing at all — no destroy, ever', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const host = createLocalEnvSandboxHost({ transport: fake.transport, envId: ENV_ID });

    await expect(host.kill({ sandboxId: localEnvSandboxId(ENV_ID), expectedInstanceId: EPOCH })).resolves.toBeUndefined();
    expect(fake.sendGrant).not.toHaveBeenCalled();
    expect(fake.sent).toEqual([]);
  });
});

describe('createLocalEnvSandboxHost — the seven undefined surfaces refuse LOUDLY (invariant 12)', () => {
  const surfaces: Array<[string, (h: Awaited<ReturnType<typeof connectedHandle>>) => Promise<unknown>]> = [
    ['stream', (h) => h.stream({})],
    ['listStreams', (h) => h.listStreams()],
    ['killSession', (h) => h.killSession('s1')],
    ['createCheckpoint', (h) => h.createCheckpoint('c')],
    ['urlInfo', (h) => h.urlInfo()],
    ['powerState', (h) => h.powerState()],
    ['setUrlAuth', (h) => h.setUrlAuth('sprite')],
    ['services', (h) => h.services.list()],
  ];

  it.each(surfaces)('%s should reject with a typed LocalEnvUnsupportedError naming the op', async (op, call) => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);

    await expect(call(handle)).rejects.toBeInstanceOf(LocalEnvUnsupportedError);
    await expect(call(handle)).rejects.toMatchObject({ op, envId: ENV_ID });
  });

  it.each(surfaces)('%s should REJECT rather than throw synchronously, so a caller\'s .catch() still catches it', (_op, call) => {
    const fake = fakeTransport({ reply: async () => execReply() });
    return connectedHandle(fake).then((handle) => {
      // No try/catch here on purpose: a synchronous throw fails this test.
      const promise = call(handle);
      expect(promise).toBeInstanceOf(Promise);
      return expect(promise).rejects.toBeInstanceOf(LocalEnvUnsupportedError);
    });
  });

  /**
   * The one that is NOT a matter of taste: `[]` is a claim about the machine
   * ("no shells are running"), and a caller that believes it tears down
   * bookkeeping for PTYs it cannot see.
   */
  it('listStreams must NOT answer an empty list — that is a statement about the machine, not about this seam', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);
    await expect(handle.listStreams()).rejects.toBeInstanceOf(LocalEnvUnsupportedError);
  });

  it('should ADVERTISE the same set it refuses — stream/checkpoint/preview/services false, exec/fs true', async () => {
    const fake = fakeTransport({ reply: async () => execReply() });
    const handle = await connectedHandle(fake);

    expect(handle.capabilities).toEqual(LOCAL_ENV_SANDBOX_CAPABILITIES);
    expect(handle.capabilities).toEqual({ exec: true, fs: true, stream: false, checkpoint: false, preview: false, services: false });
    expect(SPRITE_SANDBOX_CAPABILITIES).toEqual({ exec: true, fs: true, stream: true, checkpoint: true, preview: true, services: true });
  });
});

/**
 * The address is DERIVED and never persisted (invariant 9 keeps every Sprite
 * column NULL on a local row), so the parse is the only thing standing between
 * a Sprite name and a local route. It must claim exactly the addresses this
 * module mints and nothing that merely resembles one.
 */
describe('the local sandbox ADDRESS', () => {
  it('should round-trip the env id it was minted from', () => {
    expect(parseLocalEnvSandboxId(localEnvSandboxId('env-9'))).toBe('env-9');
    expect(localEnvSandboxId('env-9')).toBe('local-env:env-9');
  });

  it.each([
    ['a bare prefix with no env id', 'local-env:'],
    ['a hyphen where the colon belongs', 'local-env-abc123'],
    ['the prefix in the middle rather than at the start', 'pgs-env-local-env:abc'],
    ['a Sprite name that merely starts with the same letters', 'local-environment-sprite'],
    ['the derived name of a real drive env', 'pgs-env-9f2c1ab4'],
    ['a session Sprite name', 'pgs-ses-9f2c1ab4'],
    ['an empty id', ''],
  ])('should NOT claim %s', (_case, sandboxId) => {
    expect(parseLocalEnvSandboxId(sandboxId)).toBeNull();
  });
});

describe('createLocalEnvSandboxHost — the module stays I/O-free', () => {
  const source = readFileSync(join(__dirname, '..', 'local-env-sandbox-host.ts'), 'utf8');

  it.each(["'ws'", '@fly/sprites', '@pagespace/db'])('should never import %s — the transport is injected', (forbidden) => {
    expect(source).not.toContain(`from ${forbidden}`);
    expect(source).not.toContain(`from '${forbidden}'`);
  });

  it('should not sign or verify anything itself — both live once, in the apps/web bridge client', () => {
    for (const banned of ['signGrant', 'verifyMachineResult', 'ed25519', 'createHash']) {
      expect(source).not.toContain(banned);
    }
  });
});
