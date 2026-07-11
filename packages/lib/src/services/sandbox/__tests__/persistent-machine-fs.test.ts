import { describe, it, expect } from 'vitest';
import { writeSandboxFile, readSandboxFile, type SandboxActorContext, type SandboxRunDeps } from '../tool-runners';
import { acquireMachineSandbox, type AcquireMachineSandboxDeps } from '../machine-session';
import type { SandboxClient, MachineSessionStore, MachineSessionRecord } from '../machine-session-manager';
import type { ExecutableSandbox } from '../sandbox-client/types';

/**
 * End-to-end proof of the epic's core claim — "my tools are already
 * installed" — by driving the REAL production code paths (writeSandboxFile /
 * readSandboxFile → acquireMachineSandbox → acquireMachineSandbox) across two
 * separate, independently-constructed contexts standing in for two different
 * conversations/turns. Only the outermost IO boundaries (the session store and
 * the Sprites client/filesystem) are faked; everything else — session-key
 * derivation, the lifecycle planner, resume re-authz, the runner's quota/audit
 * plumbing — is the real code.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const passGate = async (): Promise<{ ok: true }> => ({ ok: true });

function makeStore(): MachineSessionStore {
  const rows = new Map<string, MachineSessionRecord>();
  return {
    findBySessionKey: async (sessionKey) => rows.get(sessionKey) ?? null,
    save: async (input) => {
      rows.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        pageId: input.pageId,
        userId: input.userId,
        sandboxId: input.sandboxId,
        lastActiveAt: input.now,
      });
    },
    touch: async ({ sessionKey, now }) => {
      const row = rows.get(sessionKey);
      if (row) rows.set(sessionKey, { ...row, lastActiveAt: now });
    },
    remove: async (sessionKey) => {
      rows.delete(sessionKey);
    },
  };
}

/**
 * Models a fleet of persistent Sprites: a filesystem keyed by sandboxId that
 * outlives any single acquisition — exactly the property the real Fly Sprites
 * driver provides (hibernate + preserved fs) and the throwaway per-conversation
 * path never had.
 */
function makeSpriteWorld() {
  const filesystems = new Map<string, Map<string, string>>();
  const byName = new Map<string, string>();
  let counter = 0;

  function fsFor(sandboxId: string): Map<string, string> {
    let fs = filesystems.get(sandboxId);
    if (!fs) {
      fs = new Map();
      filesystems.set(sandboxId, fs);
    }
    return fs;
  }

  // getOrCreate is idempotent BY NAME in production (a Sprite is addressed by
  // its name and auto-resumes) — model that so two acquisitions of the SAME
  // machine land on the SAME sandboxId, and therefore the SAME filesystem.
  const client: SandboxClient = {
    getOrCreate: async ({ name }) => {
      let sandboxId = byName.get(name);
      if (!sandboxId) {
        counter += 1;
        sandboxId = `sbx-${counter}`;
        byName.set(name, sandboxId);
      }
      return { sandboxId };
    },
    get: async ({ sandboxId }) => ({ sandboxId }),
    stop: async () => {},
  };

  function reconnect(sandboxId: string): ExecutableSandbox {
    const fs = fsFor(sandboxId);
    return {
      sandboxId,
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeFiles: async (files) => {
        for (const f of files) {
          fs.set(f.path, typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('utf8'));
        }
      },
      readFileToBuffer: async ({ path }) => {
        const content = fs.get(path);
        return content === undefined ? null : Buffer.from(content, 'utf8');
      },
    };
  }

  return { client, reconnect };
}

function makeRunDeps(world: ReturnType<typeof makeSpriteWorld>, store: MachineSessionStore): SandboxRunDeps {
  const acquireDeps: AcquireMachineSandboxDeps = {
    store,
    client: world.client,
    authorize: async () => ({ ok: true }),
    now: () => NOW,
    secret: 'x'.repeat(32),
    checkFullEgressEnablement: passGate,
    checkMachineRuntimeGuardrail: () => ({ allowed: true }),
    recordMachineActivity: () => {},
  };
  return {
    isEnabled: () => true,
    acquireSandbox: (input) => acquireMachineSandbox({ ...input, deps: acquireDeps }),
    reconnect: async (sandboxId) => world.reconnect(sandboxId),
    quota: { acquireSlot: () => true, releaseSlot: () => {} },
    buildEnv: () => ({}),
    audit: async () => {},
    now: () => NOW,
  };
}

function makeCtx(over: Partial<SandboxActorContext> = {}): SandboxActorContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    driveId: 'd1',
    conversationId: 'irrelevant-to-machine-identity',
    actorEmail: 'u1@example.com',
    tier: 'pro',
    agentPageId: 'agent-1',
    ...over,
  };
}

describe('persistent machine filesystem across runs', () => {
  it('given a file written in run 1 (own machine), should be readable in run 2 — a DIFFERENT conversation, same machine', async () => {
    const world = makeSpriteWorld();
    const store = makeStore();
    const deps = makeRunDeps(world, store);

    // Run 1: one conversation writes a file to its agent's own machine.
    const run1 = await writeSandboxFile({
      path: '/workspace/notes.txt',
      content: 'installed: ripgrep',
      ctx: makeCtx({ conversationId: 'conv-1', activeMachine: { kind: 'own' } }),
      deps,
    });
    expect(run1).toMatchObject({ success: true });

    // Run 2: a brand new context — different conversationId entirely — same
    // agent's own machine. No shared in-memory state between "run 1" and "run
    // 2" other than the injected store/client, exactly as two separate chat
    // turns would see.
    const run2 = await readSandboxFile({
      path: '/workspace/notes.txt',
      ctx: makeCtx({ conversationId: 'conv-2', activeMachine: { kind: 'own' } }),
      deps,
    });
    expect(run2).toMatchObject({ success: true, content: 'installed: ripgrep' });
  });

  it('given a file written to an "existing" Terminal machine, should be readable by a DIFFERENT agent switched onto the same machine', async () => {
    const world = makeSpriteWorld();
    const store = makeStore();
    const deps = makeRunDeps(world, store);

    await writeSandboxFile({
      path: '/workspace/shared.txt',
      content: 'shared state',
      ctx: makeCtx({ agentPageId: 'agent-1', activeMachine: { kind: 'existing', machineId: 'terminal-page-1' } }),
      deps,
    });

    const readFromOtherAgent = await readSandboxFile({
      path: '/workspace/shared.txt',
      ctx: makeCtx({ agentPageId: 'agent-2', activeMachine: { kind: 'existing', machineId: 'terminal-page-1' } }),
      deps,
    });
    expect(readFromOtherAgent).toMatchObject({ success: true, content: 'shared state' });
  });

  it('given two DIFFERENT agents\' own machines, should NOT share a filesystem', async () => {
    const world = makeSpriteWorld();
    const store = makeStore();
    const deps = makeRunDeps(world, store);

    await writeSandboxFile({
      path: '/workspace/notes.txt',
      content: 'agent-1 data',
      ctx: makeCtx({ agentPageId: 'agent-1', activeMachine: { kind: 'own' } }),
      deps,
    });

    const otherAgentRead = await readSandboxFile({
      path: '/workspace/notes.txt',
      ctx: makeCtx({ agentPageId: 'agent-2', activeMachine: { kind: 'own' } }),
      deps,
    });
    expect(otherAgentRead).toMatchObject({ success: false, reason: 'not_found' });
  });
});
