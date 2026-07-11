/**
 * The cold-connect Sprite budget (sprites 1-4).
 *
 * Composes the REAL production stack a terminal connect runs through —
 * `createSpriteHandleCache` -> `createSpritesSandboxClient` ->
 * `createSpriteMachineHost` -> `createExecClientFromMachineHost` ->
 * `acquireTerminalSandbox` -> `resolveTerminalSandbox` — with the DB stores
 * faked, and counts what it does to the Sprites control plane.
 *
 * This is the only level the leaf's headline requirements are actually
 * observable at: "one getSprite per connect" is a property of the COMPOSITION
 * (acquire + auth + launch resolution each used to read the Sprite separately),
 * not of any single unit. `apps/realtime/src/index.ts` wires exactly these
 * pieces; it is not importable under test (it binds a socket server at module
 * load), so the wiring is mirrored here.
 */

import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  createSpritesSandboxClient,
  createSpriteHandleCache,
  type SpritesSdk,
  type SpriteInstanceLike,
  type SpriteCommandLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-machine-host';
import { createExecClientFromMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/machine-host-adapter';
import {
  acquireTerminalSandbox,
  deriveTerminalSessionKey,
  type TerminalSessionRecord,
  type TerminalSessionStore,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import { resolveTerminalSandbox } from '../agent-terminal-access';

const SECRET = 'test-secret';
const MACHINE_ID = 'machine-page-1';
const DRIVE_ID = 'drive-1';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

/**
 * A Sprite is named by the terminal's derived session key (truncated to the
 * Sprites API's 63-char DNS-label limit), so a RESUMED connect must be seeded
 * under exactly that name — seeding an arbitrary id would silently exercise the
 * create path instead, and the resume assertions would prove nothing.
 */
const SESSION_KEY = deriveTerminalSessionKey({
  tenantId: TENANT_ID,
  driveId: DRIVE_ID,
  pageId: MACHINE_ID,
  secret: SECRET,
});
const SPRITE_NAME = SESSION_KEY.slice(0, 63);

/** Everything the connect did to the Sprites control plane. */
interface SpriteCalls {
  getSprite: string[];
  createSprite: string[];
  /** Every exec spawned, as `[file, ...args]` — a `sh -c :` here is a no-op wake exec. */
  spawned: string[][];
  createdSessions: number;
}

function noopCommand(): SpriteCommandLike {
  return {
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    on: (event: string, listener: (arg: never) => void) => {
      // Batch execs (the egress lockdown's mkdir) resolve via 'exit'.
      if (event === 'exit') setTimeout(() => (listener as (code: number) => void)(0), 0);
      return undefined;
    },
    kill: () => undefined,
  } as unknown as SpriteCommandLike;
}

function fakeSprite(name: string, calls: SpriteCalls): SpriteInstanceLike {
  return {
    name,
    spawn: (file, args) => {
      calls.spawned.push([file, ...(args ?? [])]);
      return noopCommand();
    },
    createSession: () => {
      calls.createdSessions += 1;
      return noopCommand();
    },
    attachSession: () => noopCommand(),
    listSessions: async () => [],
    filesystem: () => {
      throw new Error('the connect path must not touch the fs API');
    },
    updateNetworkPolicy: async () => {},
    destroy: async () => {},
  };
}

function fakeSdk(calls: SpriteCalls, existing: Set<string>): SpritesSdk {
  return {
    getSprite: async (name) => {
      calls.getSprite.push(name);
      if (!existing.has(name)) throw Object.assign(new Error('sprite not found'), { status: 404 });
      return fakeSprite(name, calls);
    },
    createSprite: async (name) => {
      calls.createSprite.push(name);
      existing.add(name);
      return fakeSprite(name, calls);
    },
    deleteSprite: async (name) => {
      existing.delete(name);
    },
  };
}

function fakeSessionStore(record: TerminalSessionRecord | null): TerminalSessionStore {
  let current = record;
  return {
    findBySessionKey: async () => current,
    save: async (input) => {
      current = {
        sessionKey: input.sessionKey,
        pageId: input.pageId,
        sandboxId: input.sandboxId,
        userId: input.userId,
        lastActiveAt: input.now,
      };
    },
    touch: async () => {},
    remove: async () => {
      current = null;
    },
  };
}

/**
 * The connect path exactly as `apps/realtime/src/index.ts` wires it: ONE handle
 * cache, threaded through both the machine acquire and the launch resolution.
 */
async function runColdConnect({
  resumed,
  lastActiveAt,
}: {
  /** Seed BOTH the session store and the Sprites control plane, so the connect resumes a real, existing Sprite. */
  resumed: boolean;
  lastActiveAt?: Date;
}) {
  const calls: SpriteCalls = { getSprite: [], createSprite: [], spawned: [], createdSessions: 0 };
  const existing = new Set<string>(resumed ? [SPRITE_NAME] : []);

  // One cache per connect — the whole point of the leaf.
  const sdk = createSpriteHandleCache(fakeSdk(calls, existing));

  const store = fakeSessionStore(
    resumed
      ? {
          sessionKey: SESSION_KEY,
          pageId: MACHINE_ID,
          sandboxId: SPRITE_NAME,
          userId: USER_ID,
          lastActiveAt: lastActiveAt ?? new Date(),
        }
      : null,
  );

  const rawClient = createSpritesSandboxClient({ sdk });
  const host = createSpriteMachineHost({ sdk, client: rawClient });
  const client = createExecClientFromMachineHost(host, { kind: 'sprite' });

  const sandbox = await resolveTerminalSandbox(
    { machineId: MACHINE_ID, name: 'shell' },
    {
      resolveAgentTerminal: async () => {
        const acquired = await acquireTerminalSandbox({
          pageId: MACHINE_ID,
          driveId: DRIVE_ID,
          tenantId: TENANT_ID,
          userId: USER_ID,
          canRun: true,
          deps: {
            store,
            client,
            now: () => new Date(),
            secret: SECRET,
            checkFullEgressEnablement: async () => ({ ok: true }),
          },
        });
        if (!acquired.ok) throw new Error(`acquire failed: ${acquired.reason}`);
        return {
          ok: true,
          agentTerminalId: 'agent-terminal-1',
          sandboxId: acquired.sandboxId,
          cwd: '/workspace',
          agentType: 'shell',
          command: null,
          streamSessionId: null,
        };
      },
      getSprite: (sandboxId) => sdk.getSprite(sandboxId),
    },
  );

  return { calls, sandbox };
}

describe('cold connect — Sprite control-plane budget', () => {
  it('given a RESUMED sprite, should read it exactly once across acquire + auth + launch resolution', async () => {
    // The session store already knows this machine's Sprite, and the Sprite exists:
    // the resume path, which used to cost THREE getSprite calls (getOrCreate's probe,
    // the wake's read, and the launch resolution's read).
    const { calls, sandbox } = await runColdConnect({ resumed: true });

    assert({
      given: 'a full cold connect against a resumed Sprite',
      should: 'call sdk.getSprite at most once — the handle is threaded, not re-fetched',
      actual: calls.getSprite.length,
      expected: 1,
    });

    assert({
      given: 'a resumed connect',
      should: 'resume the existing Sprite (never create a duplicate) and hand its handle to the PTY',
      actual: { created: calls.createSprite, sprite: sandbox.ok && sandbox.sprite.name },
      expected: { created: [], sprite: SPRITE_NAME },
    });
  });

  it('given a RESUMED sprite, should run NO no-op wake exec (the PTY session-open is the wake)', async () => {
    const { calls } = await runColdConnect({ resumed: true });

    assert({
      given: 'a resumed Sprite on the terminal connect path',
      should: 'spawn no `sh -c :` no-op wake exec',
      actual: calls.spawned.filter((cmd) => cmd.join(' ') === 'sh -c :'),
      expected: [],
    });
  });

  it('given a hibernated-IDLE sprite (the persistent noop path), should still read it only once and not wake it', async () => {
    // Idle past the warm window: `planTerminalLifecycle` returns `noop` (persistent),
    // which reconnects via getOrCreate. This is the path a tab-back onto a Sprite that
    // has been asleep for hours takes.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { calls } = await runColdConnect({ resumed: true, lastActiveAt: longAgo });

    assert({
      given: 'a long-idle (hibernated) Sprite',
      should: 'read it once and issue no no-op wake exec',
      actual: {
        reads: calls.getSprite.length,
        wakes: calls.spawned.filter((cmd) => cmd.join(' ') === 'sh -c :').length,
      },
      expected: { reads: 1, wakes: 0 },
    });
  });

  it('given a FRESH sprite (no session yet), should probe once, create it, and serve the launch handle from that create', async () => {
    const { calls, sandbox } = await runColdConnect({ resumed: false });

    assert({
      given: 'a first-ever connect (no Sprite exists)',
      should: 'issue exactly one getSprite (the not-found probe) and one createSprite',
      actual: { reads: calls.getSprite.length, created: calls.createSprite.length },
      expected: { reads: 1, created: 1 },
    });

    assert({
      given: 'a freshly created Sprite',
      should: 'hand the launch path the created handle without re-reading it',
      actual: sandbox.ok && sandbox.sprite.name,
      expected: SPRITE_NAME,
    });
  });
});
