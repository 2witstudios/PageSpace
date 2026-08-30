import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSpriteSandboxHost } from '../sprite-sandbox-host';
import { SandboxSpriteReplacedError, SandboxStreamOpenTimeoutError } from '../../sandbox-host';
import {
  createSpritesSandboxClient,
  spawnWithSelfHealingCwd,
  type SpriteCommandLike,
  type SpriteInstanceLike,
  type SpritesSdk,
} from '../sprites';
import { SANDBOX_EGRESS_ALLOWLIST } from '../../execution-policy';
import { SANDBOX_ROOT } from '../../sandbox-paths';

const options = { egressAllowlist: SANDBOX_EGRESS_ALLOWLIST };

/**
 * A fake `SpriteCommand` with explicit emit hooks for stdout/stderr, plus an
 * auto-exit(0) on the next macrotask by default (mirroring sprites.test.ts's
 * fakeCommand) — every `provision()` call in this suite drives the REAL
 * `applyEgressLockdown`, which spawns its own `mkdir` command via the fake
 * Sprite, so the default must resolve on its own or provisioning hangs.
 *
 * `autoSpawn` mirrors the real SDK's WSCommand, which emits `spawn` once the
 * WebSocket actually opens (`cmd.start().then(() => cmd.emit('spawn'))`). That
 * is the signal `stream()` waits on before handing a stream back, so a fake that
 * never emitted it would model a socket that never opens.
 */
function fakeCommand(
  over: Partial<SpriteCommandLike> & { autoExit?: boolean; autoSpawn?: boolean; error?: Error } = {},
) {
  const { autoExit = true, autoSpawn = true, error, ...commandOver } = over;
  const events = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const killed: string[] = [];
  if (error) {
    // A failed/flapping connection emits 'error' and never 'spawn'.
    setTimeout(() => events.emit('error', error), 0);
  }
  if (autoSpawn) {
    // One-shot, exactly like the real SDK's `cmd.start().then(() => cmd.emit('spawn'))`.
    // Deliberately NOT replayed to a late subscriber: the consumer under test must
    // register its listener synchronously, before this macrotask runs, and a fake
    // that replayed the event would hide a regression that stopped doing so.
    setTimeout(() => events.emit('spawn'), 0);
  }
  if (autoExit) {
    setTimeout(() => events.emit('exit', 0), 0);
  }
  const command: SpriteCommandLike & { killed: string[] } = {
    stdout: { on: (event, listener) => stdout.on(event, listener) },
    stderr: { on: (event, listener) => stderr.on(event, listener) },
    stdin: { write: () => {} },
    on: (event, listener) => events.on(event, listener as (...args: unknown[]) => void),
    kill: (signal) => {
      killed.push(signal ?? 'SIGTERM');
    },
    resize: () => {},
    killed,
    ...commandOver,
  };
  return {
    command,
    emitStdout: (chunk: string) => stdout.emit('data', chunk),
    emitStderr: (chunk: string) => stderr.emit('data', chunk),
    emitExit: (code: number) => events.emit('exit', code),
    emitMessage: (message: unknown) => events.emit('message', message),
    emitSpawn: () => events.emit('spawn'),
  };
}

function fakeSprite(over: Partial<SpriteInstanceLike> = {}): SpriteInstanceLike {
  return {
    name: 'session-key',
    spawn: () => fakeCommand().command,
    createSession: () => fakeCommand({ autoExit: false }).command,
    attachSession: () => fakeCommand({ autoExit: false }).command,
    listSessions: async () => [],
    filesystem: () => ({ readFile: async () => Buffer.from(''), writeFile: async () => {}, mkdir: async () => {} }),
    updateNetworkPolicy: async () => {},
    createCheckpoint: async () => ({ processAll: async () => {}, close: () => {} }),
    destroy: async () => {},
    killSession: async () => {},
    updateURLSettings: async () => {},
    listServices: async () => [],
    createService: async () => fakeServiceLogStream(),
    startService: async () => fakeServiceLogStream(),
    stopService: async () => fakeServiceLogStream(),
    deleteService: async () => {},
    ...over,
  };
}

function fakeServiceLogStream(events: Array<{ type: string; data?: string }> = []) {
  return {
    processAll: async (handler: (event: { type: string; data?: string }) => void | Promise<void>) => {
      for (const event of events) await handler(event);
    },
    close: () => {},
  };
}

function makeSdk(over: Partial<SpritesSdk> = {}) {
  const calls = { getSprite: 0, created: [] as string[], deleted: [] as string[] };
  const sprite = fakeSprite();
  const sdk: SpritesSdk = {
    getSprite: async () => {
      calls.getSprite += 1;
      return sprite;
    },
    createSprite: async (name) => {
      calls.created.push(name);
      return sprite;
    },
    deleteSprite: async (name) => {
      calls.deleted.push(name);
    },
    ...over,
  };
  return { sdk, calls, sprite };
}

describe('createSpriteSandboxHost', () => {
  it('given provision, should re-express the underlying ExecSandboxClient.getOrCreate — same sandboxId, provisioning untouched', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    expect(handle.sandboxId).toBe('session-key');
  });

  it('given a machine with a declared size, should provision identically — Sprite has no differentiated tier', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const small = await host.provision({ name: 'k', substrate: { kind: 'sprite', size: 'small' }, options });
    const beefy = await host.provision({ name: 'k', substrate: { kind: 'sprite', size: 'beefy' }, options });
    expect(beefy.sandboxId).toBe(small.sandboxId);
  });

  it('given exec, should delegate to the wrapped ExecutableSandbox.runCommand', async () => {
    // `spawn` is also used internally by provisioning's egress-lockdown `mkdir` —
    // a fresh auto-exiting fake per call so neither spawn starves the other.
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ spawn: () => fakeCommand().command }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    const result = await handle.exec({ cmd: 'echo', args: ['hi'] });
    expect(result.exitCode).toBe(0);
  });

  it('given writeFiles/readFile, should delegate to the wrapped ExecutableSandbox', async () => {
    const fs = {
      readFile: async () => Buffer.from('contents'),
      writeFile: async () => {},
      mkdir: async () => {},
    };
    const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ filesystem: () => fs }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
    await handle.writeFiles([{ path: '/a', content: 'x' }]);
    const buf = await handle.readFile({ path: '/a' });
    expect(buf?.toString('utf8')).toBe('contents');
  });

  it('given attach to a live machine, should return a handle addressing the same sandboxId', async () => {
    const { sdk } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const handle = await host.attach({ sandboxId: 'session-key' });
    expect(handle?.sandboxId).toBe('session-key');
  });

  it('given attach to a vanished machine, should return null', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    const handle = await host.attach({ sandboxId: 'gone' });
    expect(handle).toBeNull();
  });

  it('given kill, should delegate to the wrapped ExecSandboxClient.stop (destroy, not checkpoint)', async () => {
    const { sdk, calls } = makeSdk();
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    await host.kill({ sandboxId: 'session-key' });
    expect(calls.deleted).toEqual(['session-key']);
  });

  it('given expectedInstanceId that MATCHES the sprite at the name, should kill it', async () => {
    const { sdk, calls } = makeSdk({ getSprite: async () => fakeSprite({ id: 'inst-A' }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    await host.kill({ sandboxId: 'session-key', expectedInstanceId: 'inst-A' });
    expect(calls.deleted).toEqual(['session-key']);
  });

  it('given a DIFFERENT VM holds the name now, should THROW SandboxSpriteReplacedError and NOT destroy it', async () => {
    // The kill is name-keyed and names are reused across re-creates, so a
    // replacement Sprite must not be destroyed in place of the one we meant. And it
    // must THROW, not return success: callers treat success as "confirmed dead" and
    // release the last pointer — if the id were stale, that would strand the live VM.
    const { sdk, calls } = makeSdk({ getSprite: async () => fakeSprite({ id: 'inst-B' }) });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    await expect(
      host.kill({ sandboxId: 'session-key', expectedInstanceId: 'inst-A' }),
    ).rejects.toThrow(SandboxSpriteReplacedError);
    expect(calls.deleted).toEqual([]); // the newcomer was NOT destroyed
  });

  it('given kill of an ALREADY-GONE sprite, should resolve as a successful (idempotent) kill', async () => {
    // Every caller derives "the sprite is dead" from this NOT throwing:
    // teardownOneMachine's spriteTornDown flag, killBranch's row removal, and the
    // orphan reconciler's row removal. A not-found error must therefore read as
    // success, or an already-destroyed sprite's tracking row can never be cleared.
    const { sdk } = makeSdk({
      deleteSprite: async () => {
        throw Object.assign(new Error('sprite not found'), { status: 404 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    await expect(host.kill({ sandboxId: 'already-gone' })).resolves.toBeUndefined();
  });

  it('given kill that fails for a reason OTHER than not-found, should still throw — the sprite may be alive', async () => {
    const { sdk } = makeSdk({
      deleteSprite: async () => {
        throw Object.assign(new Error('internal server error'), { status: 500 });
      },
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });

    await expect(host.kill({ sandboxId: 'unknown-fate' })).rejects.toThrow('internal server error');
  });

  // A kill is only idempotent against a control plane that POSITIVELY says the
  // sprite is gone. Callers (teardownOneMachine, killBranch, the orphan
  // reconciler) treat "did not throw" as proof the sprite is dead and release
  // its ONLY pointer — so a transport error swallowed here would strand every
  // sprite in the batch, billing forever, unreachable. This is why `kill` uses
  // the strict `isSpriteGoneStatus` rather than the read path's looser
  // `isSpriteNotFoundError` (which accepts ENOTFOUND and message heuristics).
  const transportErrors: Array<[string, Error]> = [
    ['a DNS failure (ENOTFOUND — no HTTP status)', Object.assign(new Error('getaddrinfo ENOTFOUND api.sprites.dev'), { code: 'ENOTFOUND' })],
    ['a socket hang-up whose message merely says "gone"', new Error('socket hang up: connection gone')],
    ['an opaque failure that mentions "no such" host', new Error('fetch failed: no such host')],
  ];
  for (const [label, error] of transportErrors) {
    it(`given kill that fails with ${label}, should THROW — the sprite's fate is unknown, not confirmed dead`, async () => {
      const { sdk } = makeSdk({
        deleteSprite: async () => {
          throw error;
        },
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });

      await expect(host.kill({ sandboxId: 'maybe-alive' })).rejects.toThrow();
    });
  }

  it('given stream with no sessionId, should create a fresh interactive session and stream its combined stdout/stderr', async () => {
    // Built LAZILY, inside createSession — exactly when the real SDK builds it, so
    // its one-shot 'spawn' cannot fire before `stream()` has attached its listener.
    let emitStdout!: (chunk: string) => void;
    let emitStderr!: (chunk: string) => void;
    const created: { command: string; args: string[] }[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createSession: (cmd, args) => {
            created.push({ command: cmd, args: args ?? [] });
            const fake = fakeCommand({ autoExit: false });
            emitStdout = fake.emitStdout;
            emitStderr = fake.emitStderr;
            return fake.command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const chunks: string[] = [];
    const stream = await handle.stream({ cols: 80, rows: 24 });
    stream.onData((chunk) => chunks.push(chunk.toString('utf8')));

    emitStdout('out-chunk');
    emitStderr('err-chunk');

    // The session is spawned through the self-healing-cwd wrapper (the server
    // chdirs into cwd and fails the open if a sandbox command deleted it), which
    // recreates + enters SANDBOX_ROOT and then execs the real command.
    expect([created[0]?.command, created[0]?.args]).toEqual(
      spawnWithSelfHealingCwd({ command: 'bash', args: [], cwd: SANDBOX_ROOT }),
    );
    expect(chunks).toEqual(['out-chunk', 'err-chunk']);
  });

  it('given stream with a sessionId, should reattach instead of creating a fresh session', async () => {
    let attachedId: string | null = null;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: (id) => {
            attachedId = id;
            return fakeCommand().command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await handle.stream({ sessionId: 'existing-session' });
    expect(attachedId).toBe('existing-session');
  });

  // Regression (sprites 1-4): the PTY stream is the ONLY exec path that had no
  // cold-start retry. `killAgentTerminal` attaches a stream and immediately
  // SIGKILLs it, so once the explicit wake exec was removed, a hibernated Sprite
  // could drop that first (waking) connection pre-open and the kill would fail
  // outright — leaving a live PTY and its tracking row behind.
  it('given a cold Sprite that drops the first stream attach pre-open, should retry and still deliver a killable stream', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            if (attempts === 1) {
              // The cold VM drops the wake connection before it ever opens.
              return fakeCommand({
                autoExit: false,
                autoSpawn: false,
                error: new Error('WebSocket closed before open: code=1006'),
              }).command;
            }
            return fakeCommand({ autoExit: false }).command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({ sessionId: 'existing-session' });
    stream.kill('SIGKILL');

    expect(attempts).toBe(2); // first attach dropped pre-open, retried onto the woken VM
  });

  it('given every attach attempt drops pre-open, should give up on the bounded schedule rather than retry forever', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            return fakeCommand({
              autoExit: false,
              autoSpawn: false,
              error: new Error('WebSocket error: TypeError (url: wss://sprite/exec/dead)'),
            }).command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await expect(handle.stream({ sessionId: 'dead' })).rejects.toThrow();
    expect(attempts).toBe(3); // MAX_EXEC_ATTEMPTS — bounded, not infinite
  });

  it('given the socket OPENS, should hand back the stream — a later error belongs to the consumer, not the retry', async () => {
    let attempts = 0;
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          attachSession: () => {
            attempts += 1;
            return fakeCommand({ autoExit: false }).command; // emits spawn
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({ sessionId: 'live' });
    stream.kill('SIGKILL');
    expect(attempts).toBe(1);
  });

  // The PRODUCER of the timeout. Without this, a regression to the old
  // "resolve optimistically at the cap" behavior would pass every other test in
  // the suite — and silently hand killAtLocation a stream whose socket never
  // opened, whose SIGKILL goes nowhere, and whose row it would then delete.
  it('given a stream that never reports whether it opened, should reject with SandboxStreamOpenTimeoutError (never resolve optimistically)', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          // Reports NOTHING: no spawn, no exit, no error. A socket in limbo.
          attachSession: () => fakeCommand({ autoExit: false, autoSpawn: false }).command,
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    // Inject a short cap rather than faking timers: provisioning's own egress
    // `mkdir` needs real timers to settle, so a global fake-timer swap here would
    // deadlock the setup instead of testing the wait.
    const host = createSpriteSandboxHost({ sdk, client, streamOpenTimeoutMs: 20 });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await expect(handle.stream({ sessionId: 'sess-limbo' })).rejects.toBeInstanceOf(SandboxStreamOpenTimeoutError);
  });

  it('given listStreams, should exclude sessions the SDK reports as non-tty', async () => {
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          listSessions: async () => [
            { id: 's1', command: 'bash', isActive: true, tty: true },
            { id: 's2', command: 'node script.js', isActive: true, tty: false },
          ],
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const streams = await handle.listStreams();
    expect(streams).toEqual([{ id: 's1', command: 'bash', isActive: true }]);
  });

  it('given an SDK that does not report `tty` at all, should still surface the sessions (fail open, not empty)', async () => {
    // The published 0.0.1 @fly/sprites build drops `tty` from its listSessions
    // mapping even though the raw API returns it. A truthy filter would hide
    // EVERY stream — a machine full of live terminals would look empty. Keeping
    // sessions of unknown mode costs at most a stray row.
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          listSessions: async () => [
            { id: 's1', command: '/usr/bin/bash', isActive: true },
            { id: 's2', command: '/usr/bin/bash', isActive: false },
          ],
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const streams = await handle.listStreams();
    expect(streams).toEqual([
      { id: 's1', command: '/usr/bin/bash', isActive: true },
      { id: 's2', command: '/usr/bin/bash', isActive: false },
    ]);
  });

  it('given a SandboxStream, should write/resize/kill through to the underlying command', async () => {
    const writes: unknown[] = [];
    const resizes: Array<[number, number]> = [];
    let killed: string[] = [];
    const { sdk } = makeSdk({
      getSprite: async () =>
        fakeSprite({
          createSession: () => {
            const fake = fakeCommand({
              autoExit: false,
              stdin: { write: (data) => writes.push(data) },
              resize: (c, r) => resizes.push([c, r]),
            });
            killed = (fake.command as unknown as { killed: string[] }).killed;
            return fake.command;
          },
        }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    stream.write('ls\n');
    stream.resize(100, 40);
    stream.kill('SIGKILL');

    expect(writes).toEqual(['ls\n']);
    expect(resizes).toEqual([[100, 40]]);
    expect(killed).toEqual(['SIGKILL']);
  });

  it('given killSession, should delegate to the underlying Sprite.killSession by id', async () => {
    const killed: string[] = [];
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ killSession: async (id) => { killed.push(id); } }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await handle.killSession('sess-1');

    expect(killed).toEqual(['sess-1']);
  });

  it('given killSession against an already-dead/unknown session, should resolve rather than reject — idempotent', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ killSession: async () => {} }), // the driver already treats 404/410 as success
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    await expect(handle.killSession('sess-dead')).resolves.toBeUndefined();
  });

  it('given a SandboxStream with no stdin (batch command reused as a stream), should throw on write rather than silently drop input', async () => {
    const { sdk } = makeSdk({
      getSprite: async () => fakeSprite({ createSession: () => fakeCommand({ autoExit: false, stdin: undefined }).command }),
    });
    const client = createSpritesSandboxClient({ sdk });
    const host = createSpriteSandboxHost({ sdk, client });
    const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

    const stream = await handle.stream({});
    expect(() => stream.write('x')).toThrow(/not interactive/);
  });

  describe('services + url (dev-preview seam)', () => {
    it('given services.create, should PUT via createService and drain its startup log stream before resolving', async () => {
      let created: { name: string; config: unknown; duration: unknown } | undefined;
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          createService: async (name, config, duration) => {
            created = { name, config, duration };
            return fakeServiceLogStream([{ type: 'started' }, { type: 'complete' }]);
          },
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await handle.services.create({ name: 'devserver', command: 'python3', args: ['-m', 'http.server'], httpPort: 8000 });

      expect(created).toEqual({
        name: 'devserver',
        config: { cmd: 'python3', args: ['-m', 'http.server'], httpPort: 8000 },
        duration: '5s',
      });
    });

    it('given services.create, should reject when the startup log stream reports an error event', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          createService: async () => fakeServiceLogStream([{ type: 'error', data: 'boom' }]),
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.services.create({ name: 'devserver', command: 'python3' })).rejects.toThrow(/boom/);
    });

    it('given services.list, should normalize a Sprite service record onto the provider-neutral shape', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          listServices: async () => [
            {
              name: 'devserver',
              cmd: 'python3',
              args: ['-m', 'http.server'],
              needs: null,
              httpPort: 8000,
              state: { name: 'devserver', status: 'running', pid: 26 },
            },
          ],
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.services.list()).resolves.toEqual([
        { name: 'devserver', command: 'python3', args: ['-m', 'http.server'], httpPort: 8000, status: 'running', pid: 26 },
      ]);
    });

    it('given services.list, should normalize an unrecognized status string to "unknown" rather than leak it', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          listServices: async () => [
            { name: 'x', cmd: 'x', args: [], state: { name: 'x', status: 'crashlooping' as never } },
          ],
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const [service] = await handle.services.list();
      expect(service?.status).toBe('unknown');
    });

    it('given services.get for a name present in the listing, should return its normalized record', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          listServices: async () => [
            { name: 'devserver', cmd: 'python3', args: [], state: { name: 'devserver', status: 'running' } },
          ],
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.services.get('devserver')).resolves.toMatchObject({ name: 'devserver', status: 'running' });
    });

    it('given services.get for a name absent from the listing, should return null', async () => {
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ listServices: async () => [] }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.services.get('missing')).resolves.toBeNull();
    });

    it('given services.stop, should record a "failed" status verbatim — Sprite records a stop as a failed exit, not "stopped"', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          stopService: async () => fakeServiceLogStream([{ type: 'stopping' }, { type: 'stopped' }]),
          listServices: async () => [
            { name: 'devserver', cmd: 'python3', args: [], state: { name: 'devserver', status: 'failed', error: 'exited with code 143' } },
          ],
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await handle.services.stop('devserver');
      await expect(handle.services.get('devserver')).resolves.toMatchObject({ status: 'failed', error: 'exited with code 143' });
    });

    it('given services.start, should call startService and drain its stream', async () => {
      let started: string | undefined;
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({
          startService: async (name) => { started = name; return fakeServiceLogStream([{ type: 'started' }]); },
        }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await handle.services.start('devserver');
      expect(started).toBe('devserver');
    });

    it('given services.remove, should call deleteService', async () => {
      let removed: string | undefined;
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({ deleteService: async (name) => { removed = name; } }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await handle.services.remove('devserver');
      expect(removed).toBe('devserver');
    });

    it('given urlInfo, should report the sprite url + normalized auth mode', async () => {
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({ url: 'https://x.sprites.app', urlSettings: { auth: 'sprite' } }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.urlInfo()).resolves.toEqual({ url: 'https://x.sprites.app', auth: 'sprite' });
    });

    it('given urlInfo, should normalize an absent/unrecognized auth mode to "unknown" — never default to a proven-private claim', async () => {
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ url: 'https://x.sprites.app', urlSettings: undefined }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.urlInfo()).resolves.toEqual({ url: 'https://x.sprites.app', auth: 'unknown' });
    });

    it('given urlInfo on a sprite reporting no url, should return url: null', async () => {
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ url: undefined }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await expect(handle.urlInfo()).resolves.toEqual({ url: null, auth: 'unknown' });
    });

    it('given setUrlAuth, should call updateURLSettings with the requested mode', async () => {
      let settings: { auth: string } | undefined;
      const { sdk } = makeSdk({
        getSprite: async () => fakeSprite({ updateURLSettings: async (s) => { settings = s; } }),
      });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      await handle.setUrlAuth('public');
      expect(settings).toEqual({ auth: 'public' });
    });
  });

  describe('onPortEvent (port_opened/port_closed frames)', () => {
    // fakeCommand's 'spawn' auto-fires on a setTimeout(0) registered at
    // CONSTRUCTION time — building it before `host.provision()` (which itself
    // awaits) would fire 'spawn' before `awaitStreamOpen`'s listener attaches,
    // and the stream would never open. So `createSession` builds a FRESH
    // command at call time (the pattern every other test in this file uses)
    // and stashes it in `cmdRef` so the test can emit on it afterwards.
    function fakeSessionCommand(over: Partial<Parameters<typeof fakeCommand>[0]> = {}) {
      let cmdRef: ReturnType<typeof fakeCommand> | undefined;
      const createSession = () => {
        cmdRef = fakeCommand({ autoExit: false, ...over });
        return cmdRef.command;
      };
      return {
        createSession,
        emitMessage: (message: unknown) => cmdRef?.emitMessage(message),
        emitSpawn: () => cmdRef?.emitSpawn(),
      };
    }

    it('given a port_opened control frame delivered AFTER the caller subscribes, should deliver it live', async () => {
      const session = fakeSessionCommand();
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
      const stream = await handle.stream({});

      const events: unknown[] = [];
      stream.onPortEvent((event) => events.push(event));
      session.emitMessage({ type: 'port_opened', port: 8124, address: '10.0.0.1', pid: 383 });

      expect(events).toEqual([{ type: 'port_opened', port: 8124, address: '10.0.0.1', pid: 383 }]);
    });

    it('given a non-port control frame (e.g. session_info), should not invoke the port-event listener', async () => {
      const session = fakeSessionCommand();
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
      const stream = await handle.stream({});

      const events: unknown[] = [];
      stream.onPortEvent((event) => events.push(event));
      session.emitMessage({ type: 'session_info', session_id: '1' });

      expect(events).toEqual([]);
    });

    it('given a port_opened frame that arrives BEFORE the caller can call onPortEvent (a fast dev server racing stream() itself), should still deliver it — buffered, not dropped', async () => {
      // Codex review, PR #2520: EventEmitter never replays a past event to a
      // late subscriber. A caller can only call `onPortEvent` AFTER `stream()`
      // resolves, but the server can emit `port_opened` the instant the
      // process binds a port — which can be before `stream()` even returns.
      // Manual spawn control (autoSpawn: false) lets this test put the frame
      // in exactly that window: after the command exists (so
      // `bufferPortEvents` has attached its listener) but before `spawn`
      // fires (so `stream()` has not yet resolved, and the caller could not
      // possibly have called `onPortEvent` yet).
      const session = fakeSessionCommand({ autoSpawn: false });
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const streamPromise = handle.stream({});
      // Flush the microtasks up through `sdk.getSprite` resolving and
      // `sprite.createSession(...)` running synchronously after it — enough
      // for `bufferPortEvents` to have attached its `message` listener, but
      // `awaitStreamOpen` is still waiting (spawn is manual in this test).
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.emitMessage({ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 500 });
      session.emitSpawn();
      const stream = await streamPromise;

      const events: unknown[] = [];
      stream.onPortEvent((event) => events.push(event));

      expect(events).toEqual([{ type: 'port_opened', port: 5173, address: '10.0.0.1', pid: 500 }]);
    });

    it('given both a buffered pre-subscribe event and a later live one, should deliver both in order without duplication', async () => {
      const session = fakeSessionCommand({ autoSpawn: false });
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const streamPromise = handle.stream({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.emitMessage({ type: 'port_opened', port: 5173 });
      session.emitSpawn();
      const stream = await streamPromise;

      const events: unknown[] = [];
      stream.onPortEvent((event) => events.push(event));
      session.emitMessage({ type: 'port_closed', port: 5173 });

      expect(events).toEqual([{ type: 'port_opened', port: 5173 }, { type: 'port_closed', port: 5173 }]);
    });

    it('given a SECOND onPortEvent subscriber, should deliver live events to BOTH — matching onData/onExit/onError fan-out, not silently orphaning the first', async () => {
      const session = fakeSessionCommand();
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });
      const stream = await handle.stream({});

      const first: unknown[] = [];
      const second: unknown[] = [];
      stream.onPortEvent((event) => first.push(event));
      stream.onPortEvent((event) => second.push(event));
      session.emitMessage({ type: 'port_opened', port: 8000 });

      expect(first).toEqual([{ type: 'port_opened', port: 8000 }]);
      expect(second).toEqual([{ type: 'port_opened', port: 8000 }]);
    });

    it('given a pre-subscribe buffered event, a second (later) subscriber should NOT receive it again — only the first subscriber drains the backlog', async () => {
      const session = fakeSessionCommand({ autoSpawn: false });
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const streamPromise = handle.stream({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.emitMessage({ type: 'port_opened', port: 5173 });
      session.emitSpawn();
      const stream = await streamPromise;

      const first: unknown[] = [];
      const second: unknown[] = [];
      stream.onPortEvent((event) => first.push(event));
      stream.onPortEvent((event) => second.push(event));

      expect(first).toEqual([{ type: 'port_opened', port: 5173 }]);
      expect(second).toEqual([]);
    });

    it('given more port events than the buffer cap while nobody has subscribed, should drop the oldest rather than grow unbounded', async () => {
      const session = fakeSessionCommand({ autoSpawn: false });
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const streamPromise = handle.stream({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 70 events, well past the 64-entry cap, before anyone subscribes.
      for (let port = 0; port < 70; port += 1) {
        session.emitMessage({ type: 'port_opened', port });
      }
      session.emitSpawn();
      const stream = await streamPromise;

      const events: Array<{ port: number }> = [];
      stream.onPortEvent((event) => events.push(event as { port: number }));

      expect(events.length).toBe(64);
      // The oldest (lowest ports) were dropped; the tail survives, in order.
      expect(events[0]).toEqual({ type: 'port_opened', port: 6 });
      expect(events[events.length - 1]).toEqual({ type: 'port_opened', port: 69 });
    });

    it('given a replay callback that itself calls onPortEvent (a nested subscribe), the nested listener should get NO backlog replay of its own and the outer listener should still see the full backlog exactly once', async () => {
      // CodeRabbit review, PR #2520: with the naive "replay, then check
      // listeners.length, then push" ordering, a subscribe triggered
      // synchronously from inside a replay callback would see
      // listeners.length === 0 (the outer subscribe hadn't pushed yet) and
      // replay the SAME backlog again to the nested listener — while also
      // mutating `buffered.length` mid-iteration out from under the outer
      // loop. Register-then-drain-atomically fixes both.
      const session = fakeSessionCommand({ autoSpawn: false });
      const { sdk } = makeSdk({ getSprite: async () => fakeSprite({ createSession: session.createSession }) });
      const client = createSpritesSandboxClient({ sdk });
      const host = createSpriteSandboxHost({ sdk, client });
      const handle = await host.provision({ name: 'k', substrate: { kind: 'sprite' }, options });

      const streamPromise = handle.stream({});
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.emitMessage({ type: 'port_opened', port: 3000 });
      session.emitMessage({ type: 'port_opened', port: 3001 });
      session.emitSpawn();
      const stream = await streamPromise;

      const outer: unknown[] = [];
      const nested: unknown[] = [];
      let nestedSubscribed = false;
      stream.onPortEvent((event) => {
        outer.push(event);
        if (!nestedSubscribed) {
          nestedSubscribed = true;
          stream.onPortEvent((e) => nested.push(e));
        }
      });

      expect(outer).toEqual([{ type: 'port_opened', port: 3000 }, { type: 'port_opened', port: 3001 }]);
      expect(nested).toEqual([]);

      // A live event after both are subscribed reaches both.
      session.emitMessage({ type: 'port_closed', port: 3000 });
      expect(outer).toEqual([
        { type: 'port_opened', port: 3000 },
        { type: 'port_opened', port: 3001 },
        { type: 'port_closed', port: 3000 },
      ]);
      expect(nested).toEqual([{ type: 'port_closed', port: 3000 }]);
    });
  });
});
