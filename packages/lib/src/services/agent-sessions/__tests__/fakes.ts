/**
 * In-memory fakes for the agent-session services — the same fake-injection
 * discipline `services/machines/__tests__` uses: every test in this directory
 * runs with NO database and NO live Sprite.
 *
 * These are not stubs that return canned answers. The store fake implements the
 * REAL compare-and-swap semantics (identity CAS on the previous pointer,
 * teardown CAS on the instance) and the Sprite host fake implements the REAL
 * name-keyed provisioning contract — two provisions of one name hand back one
 * physical VM. That is what lets the concurrency tests mean something: a race
 * that the production CAS would resolve is resolved here the same way, and one
 * that it would not is visible as a duplicate.
 */

import type {
  SandboxHandle,
  SandboxHost,
  SandboxStream,
  SandboxStreamSessionInfo,
} from '../../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../../sandbox/sandbox-host';
import type { AgentSessionRecord, AgentSessionStore } from '../agent-sessions-store';
import { SESSION_LIST_LIMIT, stampColumns } from '../agent-sessions-store';
import type { SessionShellRecord, SessionShellStore } from '../session-shells-store';

export const NOW = new Date('2026-07-28T12:00:00.000Z');
export const SESSION_ID = 'ses-1';
export const OWNER_ID = 'user-1';
export const DRIVE_ID = 'drive-1';
export const TENANT_ID = 'tenant-1';
/** >= 32 chars — `deriveAgentSessionSpriteKey` refuses anything shorter. */
export const SECRET = 'x'.repeat(40);

export function makeSessionRecord(over: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: SESSION_ID,
    ownerId: OWNER_ID,
    driveId: DRIVE_ID,
    name: null,
    sessionKey: null,
    sandboxId: null,
    spriteInstanceId: null,
    egressPolicyToken: null,
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    storageLastBilledAt: NOW,
    storageMeasuredBytes: null,
    storageMeasuredAt: null,
    lastActiveAt: null,
    endedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export interface FakeAgentSessionStore {
  store: AgentSessionStore;
  rows: Map<string, AgentSessionRecord>;
  /** Models `machine_sprite_reclaims`: sandboxId → spriteInstanceId. */
  reclaims: Map<string, string | null>;
  calls: { create: number; updateSpriteIdentity: number };
  /** conversationId → sessionId, modelling `conversations.sessionId`. */
  conversationBindings: Map<string, string>;
}

export function makeAgentSessionStore(
  seed: AgentSessionRecord[] = [],
  /** Mirrors the real store's own `updatedAt` bump on a no-identity stamp write. */
  now: () => Date = () => NOW,
): FakeAgentSessionStore {
  const rows = new Map<string, AgentSessionRecord>();
  for (const row of seed) rows.set(row.id, row);
  const reclaims = new Map<string, string | null>();
  const calls = { create: 0, updateSpriteIdentity: 0 };
  const conversationBindings = new Map<string, string>();
  let minted = 0;

  const store: AgentSessionStore = {
    async findById(sessionId) {
      return rows.get(sessionId) ?? null;
    },

    async findByConversation(conversationId) {
      // Models conversations.sessionId: a thread with no binding (or whose
      // session is gone) resolves to null, never to a fallback.
      const sessionId = conversationBindings.get(conversationId);
      if (sessionId === undefined) return null;
      return rows.get(sessionId) ?? null;
    },

    async create(input) {
      calls.create += 1;
      minted += 1;
      const row = makeSessionRecord({
        id: `ses-minted-${minted}`,
        ownerId: input.ownerId,
        driveId: input.driveId,
        name: input.name,
        storageLastBilledAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      });
      rows.set(row.id, row);
      return row;
    },

    async list(filter) {
      // Mirrors the real store: active rows only, newest activity first,
      // capped at SESSION_LIST_LIMIT (the sidebar polls this every few
      // seconds — an unbounded fake would let a test pass against a query
      // shape the real store never allows).
      return [...rows.values()]
        .filter((row) => {
          if ('driveId' in filter && row.driveId !== filter.driveId) return false;
          if (filter.ownerId !== undefined && row.ownerId !== filter.ownerId) return false;
          return row.endedAt === null;
        })
        .sort((a, b) => {
          const aAt = a.lastActiveAt?.getTime() ?? -1;
          const bAt = b.lastActiveAt?.getTime() ?? -1;
          if (aAt !== bAt) return bAt - aAt;
          return b.createdAt.getTime() - a.createdAt.getTime();
        })
        .slice(0, SESSION_LIST_LIMIT);
    },

    async countActive(ownerId) {
      return [...rows.values()].filter((row) => row.ownerId === ownerId && row.endedAt === null).length;
    },

    async countLive(ownerId) {
      return [...rows.values()].filter(
        (row) => row.ownerId === ownerId && row.sandboxId !== null && row.spriteTornDownAt === null,
      ).length;
    },

    async recordStorageMeasurement({ sessionId, measuredBytes, measuredAt }) {
      const row = rows.get(sessionId);
      // Mirrors the real store's live-row guard: a measurement landing after
      // teardown describes a filesystem that no longer exists.
      if (!row || row.spriteTornDownAt !== null) return;
      row.storageMeasuredBytes = measuredBytes;
      row.storageMeasuredAt = measuredAt;
    },

    async updateSpriteIdentity(input) {
      calls.updateSpriteIdentity += 1;
      const row = rows.get(input.sessionId);
      if (!row) return false;
      // CAS on the CURRENT pointer — null for a first provision, the
      // vanished/replaced name for a re-provision.
      if ((row.sandboxId ?? null) !== (input.previousSandboxId ?? null)) return false;
      rows.set(input.sessionId, {
        ...row,
        sessionKey: input.sessionKey,
        sandboxId: input.sandboxId,
        spriteInstanceId: input.spriteInstanceId,
        egressPolicyToken: input.egressPolicyToken,
        storageLastBilledAt: input.now,
        updatedAt: input.now,
        ...stampColumns(input.stamps),
      });
      return true;
    },

    async applyStamps({ sessionId, stamps }) {
      const row = rows.get(sessionId);
      if (!row) return;
      // Mirrors the real store: a stamp write with nothing to write is a
      // legitimate no-op verdict, and must not bump updatedAt on a row it
      // otherwise leaves untouched.
      const columns = stampColumns(stamps);
      if (Object.keys(columns).length === 0) return;
      rows.set(sessionId, { ...row, ...columns, updatedAt: now() });
    },

    async requestTeardown({ sessionId, sandboxId, spriteInstanceId, at }) {
      const row = rows.get(sessionId);
      if (!row) return;
      // CAS-guarded: a session already revived onto a NEW VM must not be left
      // carrying a teardown request.
      if (row.sandboxId !== sandboxId) return;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return;
      rows.set(sessionId, { ...row, teardownRequestedAt: at, updatedAt: at });
    },

    async stampSpriteTornDown({ sessionId, sandboxId, spriteInstanceId, stamps }) {
      const row = rows.get(sessionId);
      if (!row) return false;
      if (row.sandboxId !== sandboxId) return false;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return false;
      rows.set(sessionId, { ...row, ...stampColumns(stamps), updatedAt: now() });
      return true;
    },

    async reloadSpritePointer(sessionId) {
      const row = rows.get(sessionId);
      if (!row) return null;
      return { sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId };
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Idempotent on the sandboxId, chasing the newest instance — mirrors the
      // AFTER-DELETE trigger's own insert.
      reclaims.set(sandboxId, spriteInstanceId ?? reclaims.get(sandboxId) ?? null);
    },
  };

  return { store, rows, reclaims, calls, conversationBindings };
}

export interface FakeSpriteHost {
  host: SandboxHost;
  /** Live VMs by NAME. A name is reused across re-creates, which is exactly why instances exist. */
  live: Map<string, { instanceId: string | null; egressPolicyToken?: string }>;
  calls: {
    provision: Array<{ name: string; appliedEgressToken?: string | null }>;
    kill: Array<{ sandboxId: string; expectedInstanceId?: string | null }>;
    attach: string[];
  };
}

export function makeHandle(sandboxId: string, instanceId: string | null, egressPolicyToken?: string): SandboxHandle {
  const unusedStream: SandboxStream = {
    write: () => {},
    resize: () => {},
    onData: () => {},
    onExit: () => {},
    onError: () => {},
    kill: () => {},
  };
  return {
    sandboxId,
    spriteInstanceId: instanceId,
    egressPolicyToken,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => unusedStream,
    listStreams: async (): Promise<SandboxStreamSessionInfo[]> => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
  };
}

/**
 * A name-keyed Sprite host.
 *
 * `provision` is `getOrCreate` semantics: the SAME name always resolves to the
 * SAME live VM, which is the property that makes two concurrent provisioners of
 * one session share a physical Sprite (and therefore the property the identity
 * CAS exists to resolve). `nextInstanceId` lets a test force the opposite —
 * distinct VMs under one name — to exercise the reconcile-then-kill path.
 */
export function makeSpriteHost(
  options: {
    seed?: Record<string, { instanceId: string | null; egressPolicyToken?: string }>;
    /** Called on each fresh create; default mints one stable instance per name. */
    nextInstanceId?: (name: string, attempt: number) => string | null;
    egressTokenFor?: (name: string) => string | undefined;
    provisionError?: Error;
    attachError?: Error;
    killError?: Error;
  } = {},
): FakeSpriteHost {
  const live = new Map<string, { instanceId: string | null; egressPolicyToken?: string }>(
    Object.entries(options.seed ?? {}),
  );
  const calls: FakeSpriteHost['calls'] = { provision: [], kill: [], attach: [] };
  let attempts = 0;

  const host: SandboxHost = {
    async provision({ name, appliedEgressToken }) {
      calls.provision.push({ name, appliedEgressToken });
      if (options.provisionError) throw options.provisionError;
      attempts += 1;
      const existing = live.get(name);
      if (existing && !options.nextInstanceId) {
        return makeHandle(name, existing.instanceId, existing.egressPolicyToken);
      }
      const instanceId = options.nextInstanceId ? options.nextInstanceId(name, attempts) : `inst-${name}`;
      const egressPolicyToken = options.egressTokenFor?.(name) ?? existing?.egressPolicyToken;
      live.set(name, { instanceId, egressPolicyToken });
      return makeHandle(name, instanceId, egressPolicyToken);
    },

    async attach({ sandboxId }) {
      calls.attach.push(sandboxId);
      if (options.attachError) throw options.attachError;
      const existing = live.get(sandboxId);
      if (!existing) return null;
      return makeHandle(sandboxId, existing.instanceId, existing.egressPolicyToken);
    },

    async kill({ sandboxId, expectedInstanceId }) {
      calls.kill.push({ sandboxId, expectedInstanceId });
      if (options.killError) throw options.killError;
      const existing = live.get(sandboxId);
      if (!existing) return; // idempotent: already gone
      if (
        expectedInstanceId !== undefined &&
        expectedInstanceId !== null &&
        existing.instanceId !== null &&
        existing.instanceId !== expectedInstanceId
      ) {
        // A DIFFERENT VM holds this name now — refuse rather than destroy it.
        throw new SandboxSpriteReplacedError(sandboxId, expectedInstanceId, existing.instanceId);
      }
      live.delete(sandboxId);
    },
  };

  return { host, live, calls };
}

export function makeShellRecord(over: Partial<SessionShellRecord> = {}): SessionShellRecord {
  return {
    id: 'shell-id-1',
    sessionId: SESSION_ID,
    ownerId: OWNER_ID,
    name: 'shell-1',
    agentType: 'shell',
    command: null,
    streamSessionId: null,
    coldTail: null,
    coldTailAt: null,
    coldTailHasOutput: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export interface FakeSessionShellStore {
  store: SessionShellStore;
  rows: Map<string, SessionShellRecord>;
}

export function makeSessionShellStore(seed: SessionShellRecord[] = []): FakeSessionShellStore {
  const rows = new Map<string, SessionShellRecord>();
  for (const row of seed) rows.set(row.id, row);
  let counter = seed.length;

  const store: SessionShellStore = {
    async list(sessionId) {
      return [...rows.values()].filter((row) => row.sessionId === sessionId);
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async create(input) {
      const duplicate = [...rows.values()].some(
        (row) => row.sessionId === input.sessionId && row.name === input.name,
      );
      if (duplicate) {
        // The `(sessionId, name)` unique index, as Postgres reports it.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row = makeShellRecord({
        id: `shell-id-${counter}`,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        name: input.name,
        agentType: input.agentType,
        command: input.command,
        createdAt: input.now,
        updatedAt: input.now,
      });
      rows.set(row.id, row);
      return row;
    },
    async updateStreamSessionId({ id, streamSessionId, now }) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, { ...row, streamSessionId, updatedAt: now });
    },
    async recordColdTail({ id, tail, hasOutput, endedAt }) {
      const row = rows.get(id);
      if (!row) return;
      if (row.coldTailAt !== null && row.coldTailAt >= endedAt) return;
      rows.set(id, { ...row, coldTail: tail, coldTailAt: endedAt, coldTailHasOutput: hasOutput });
    },
    async remove(id) {
      rows.delete(id);
    },
  };

  return { store, rows };
}
