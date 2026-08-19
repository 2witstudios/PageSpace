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
import type {
  AgentSessionRecord,
  AgentSessionStore,
  DriveEnvSpritePointers,
} from '../agent-workspaces-store';
import { stampColumns } from '../agent-workspaces-store';
import { planSessionReopen } from '../../../agent-workspaces/plan-workspace-lifecycle';
import { MAX_ACTIVE_WORKSPACES_PER_OWNER } from '../../../agent-workspaces/session-contract';
import type { SessionShellRecord, SessionShellStore } from '../workspace-shells-store';

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
    /** Ephemeral by default — the shape every existing lifecycle test assumes. */
    envId: null,
    spriteKey: null,
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
  /** conversationId → workspaceId, modelling the chat-bound node that IS membership. */
  conversationBindings: Map<string, string>;
  /**
   * envId → the env row's Sprite pointers, modelling what the real `list()`
   * LEFT JOINs off `drive_envs`. An `envId` with no entry here models an env
   * that vanished under the query — the same null the join yields.
   */
  envSprites: Map<string, DriveEnvSpritePointers>;
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
  const envSprites = new Map<string, DriveEnvSpritePointers>();
  let minted = 0;

  const store: AgentSessionStore = {
    async findById(workspaceId) {
      return rows.get(workspaceId) ?? null;
    },

    async findByConversation(conversationId) {
      // Models the chat-bound node: a thread with no binding (or whose session
      // is gone) resolves to null, never to a fallback.
      const workspaceId = conversationBindings.get(conversationId);
      if (workspaceId === undefined) return null;
      return rows.get(workspaceId) ?? null;
    },

    async create(input) {
      calls.create += 1;
      minted += 1;
      const row = makeSessionRecord({
        id: `ses-minted-${minted}`,
        ownerId: input.ownerId,
        driveId: input.driveId,
        name: input.name,
        envId: input.envId,
        storageLastBilledAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      });
      rows.set(row.id, row);
      return row;
    },

    async createIfUnderLimit({ ownerId, driveId, name, envId, now, maxActive }) {
      const activeCount = [...rows.values()].filter((row) => row.ownerId === ownerId && row.endedAt === null).length;
      if (activeCount >= maxActive) return { ok: false, reason: 'limit_reached' };
      calls.create += 1;
      minted += 1;
      const row = makeSessionRecord({
        id: `ses-minted-${minted}`,
        ownerId,
        driveId,
        name,
        envId,
        storageLastBilledAt: now,
        createdAt: now,
        updatedAt: now,
      });
      rows.set(row.id, row);
      return { ok: true, session: row };
    },

    async list(filter) {
      // Mirrors the real store: active rows only, newest activity first,
      // capped at MAX_ACTIVE_WORKSPACES_PER_OWNER (the sidebar polls this every few
      // seconds — an unbounded fake would let a test pass against a query
      // shape the real store never allows). Also mirrors the real store's
      // driveId+ownerId union: an OWNED drive-scoped filter additionally
      // matches that owner's own global sessions (driveId null); an
      // OWNERLESS drive-scoped filter does not, since without an owner to
      // scope it that would leak every user's global sessions (review: Codex
      // P1 on #2325). Normalized to a VALUE check (not `'ownerId' in filter`),
      // matching the real store's guard against `{ driveId, ownerId:
      // undefined }` being treated as owned (review: CodeRabbit on #2325).
      const ownerId = 'ownerId' in filter ? filter.ownerId : undefined;
      return [...rows.values()]
        .filter((row) => {
          if ('driveId' in filter) {
            const matchesDrive = row.driveId === filter.driveId;
            const matchesOwnerGlobal = ownerId !== undefined && row.driveId === null;
            if (!matchesDrive && !matchesOwnerGlobal) return false;
          }
          if (ownerId !== undefined && row.ownerId !== ownerId) return false;
          return row.endedAt === null;
        })
        .sort((a, b) => {
          const aAt = a.lastActiveAt?.getTime() ?? -1;
          const bAt = b.lastActiveAt?.getTime() ?? -1;
          if (aAt !== bAt) return bAt - aAt;
          return b.createdAt.getTime() - a.createdAt.getTime();
        })
        .slice(0, MAX_ACTIVE_WORKSPACES_PER_OWNER)
        // The real store's LEFT JOIN, modelled: an env-bound row carries its
        // env's pointers, an ordinary row carries null.
        .map((row) => ({ ...row, env: row.envId === null ? null : (envSprites.get(row.envId) ?? null) }));
    },

    async countActive(ownerId) {
      return [...rows.values()].filter((row) => row.ownerId === ownerId && row.endedAt === null).length;
    },

    async countLive(ownerId) {
      return [...rows.values()].filter(
        (row) => row.ownerId === ownerId && row.sandboxId !== null && row.spriteTornDownAt === null,
      ).length;
    },

    async recordStorageMeasurement({ workspaceId, spriteInstanceId, measuredBytes, measuredAt }) {
      const row = rows.get(workspaceId);
      // Mirrors the real store's live-row guard: a measurement landing after
      // teardown describes a filesystem that no longer exists.
      if (!row || row.spriteTornDownAt !== null) return;
      // ...and its generation CAS. A fake that accepts writes the real store
      // rejects makes every test using it agree with a bug: the liveness guard
      // alone passes a stale measurement onto the NEXT generation, because
      // re-provisioning clears `spriteTornDownAt`.
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return;
      row.storageMeasuredBytes = measuredBytes;
      row.storageMeasuredAt = measuredAt;
    },

    async updateSpriteIdentity(input) {
      calls.updateSpriteIdentity += 1;
      const row = rows.get(input.workspaceId);
      if (!row) return false;
      // CAS on the CURRENT pointer — null for a first provision, the
      // vanished/replaced name for a re-provision.
      if ((row.sandboxId ?? null) !== (input.previousSandboxId ?? null)) return false;
      rows.set(input.workspaceId, {
        ...row,
        spriteKey: input.spriteKey,
        sandboxId: input.sandboxId,
        spriteInstanceId: input.spriteInstanceId,
        egressPolicyToken: input.egressPolicyToken,
        // MONOTONIC, mirroring the real store's `GREATEST(column, <now>)`. The
        // provision's timestamp is captured before the provider IO, so it can be
        // older than a watermark a reconcile tick has already advanced — assigning
        // it would drag the watermark back over billed time. A fake that assigned
        // would let that guard be deleted with every fake-backed test still green.
        storageLastBilledAt:
          row.storageLastBilledAt > input.now ? row.storageLastBilledAt : input.now,
        updatedAt: input.now,
        ...stampColumns(input.stamps),
      });
      return true;
    },

    async applyStamps({ workspaceId, stamps, cas }) {
      const row = rows.get(workspaceId);
      if (!row) return true;
      // Mirrors the real store: a stamp write with nothing to write is a
      // legitimate no-op verdict, and must not bump updatedAt on a row it
      // otherwise leaves untouched.
      const columns = stampColumns(stamps);
      if (Object.keys(columns).length === 0) return true;
      if (cas?.sandboxId !== undefined && (row.sandboxId ?? null) !== (cas.sandboxId ?? null)) return false;
      if (cas?.endedAt !== undefined && (row.endedAt?.getTime() ?? null) !== (cas.endedAt?.getTime() ?? null)) return false;
      rows.set(workspaceId, { ...row, ...columns, updatedAt: now() });
      return true;
    },

    async reopenListingIfPopulated({ workspaceId, endedAt }) {
      const row = rows.get(workspaceId);
      if (!row) return false;
      // BOTH conditions or neither, which is what the real one buys by putting
      // them in one statement: a fake that checked emptiness separately would
      // let a test pass over the interleave the single statement exists to make
      // impossible.
      if ((row.endedAt?.getTime() ?? null) !== endedAt.getTime()) return false;
      const holdsATree = [...conversationBindings.values()].includes(workspaceId);
      if (!holdsATree) return false;
      rows.set(workspaceId, { ...row, ...stampColumns(planSessionReopen()), updatedAt: now() });
      return true;
    },

    async requestTeardown({ workspaceId, sandboxId, spriteInstanceId, at }) {
      const row = rows.get(workspaceId);
      if (!row) return;
      // CAS-guarded: a session already revived onto a NEW VM must not be left
      // carrying a teardown request.
      if (row.sandboxId !== sandboxId) return;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return;
      rows.set(workspaceId, { ...row, teardownRequestedAt: at, updatedAt: at });
    },

    async stampSpriteTornDown({ workspaceId, sandboxId, spriteInstanceId, stamps }) {
      const row = rows.get(workspaceId);
      if (!row) return false;
      if (row.sandboxId !== sandboxId) return false;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return false;
      rows.set(workspaceId, { ...row, ...stampColumns(stamps), updatedAt: now() });
      return true;
    },

    async reloadSpritePointer(workspaceId) {
      const row = rows.get(workspaceId);
      if (!row) return null;
      return { sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId };
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Idempotent on the sandboxId, chasing the newest instance — mirrors the
      // AFTER-DELETE trigger's own insert.
      reclaims.set(sandboxId, spriteInstanceId ?? reclaims.get(sandboxId) ?? null);
    },
  };

  return { store, rows, reclaims, calls, conversationBindings, envSprites };
}

export interface FakeSpriteHost {
  host: SandboxHost;
  /** Live VMs by NAME. A name is reused across re-creates, which is exactly why instances exist. */
  live: Map<string, { instanceId: string | null; egressPolicyToken?: string }>;
  /**
   * One filesystem per sandbox NAME — the fake's model of the platform contract
   * the whole environment design rests on: provisioning a name that already
   * exists hands back that VM AND its disk. Survives a re-create under the same
   * name for the same reason a real Sprite's does; a kill drops it, because
   * that is what destroying a VM means.
   */
  disks: Map<string, Map<string, Buffer>>;
  calls: {
    provision: Array<{ name: string; appliedEgressToken?: string | null }>;
    kill: Array<{ sandboxId: string; expectedInstanceId?: string | null }>;
    attach: string[];
  };
}

export function makeHandle(
  sandboxId: string,
  instanceId: string | null,
  egressPolicyToken?: string,
  /**
   * The SANDBOX's filesystem — passed in rather than owned, because a disk
   * belongs to the VM and not to a handle. Two handles onto one `sandboxId`
   * therefore read and write the SAME files, which is the whole property that
   * makes an environment shared: the fs/diff/git tooling is handle-keyed, so
   * "do two sessions see each other's files" is decided entirely by whether
   * they resolved the same sandbox. Omitted (an isolated scratch disk) for the
   * callers that never touch files.
   */
  disk: Map<string, Buffer> = new Map(),
): SandboxHandle {
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
    // Both directions COPY. A real handle's bytes cross a wire, so neither side
    // can hand the caller a reference into the VM's disk — and a fake that did
    // would be more permissive than the thing it models: a caller mutating the
    // buffer it read would silently rewrite the file, and the next read would
    // agree with it, so a test could pass against a bug that cannot exist in
    // production.
    writeFiles: async (files) => {
      for (const file of files) {
        disk.set(file.path, Buffer.from(file.content as string | Uint8Array));
      }
    },
    readFile: async ({ path }) => {
      const content = disk.get(path);
      return content === undefined ? null : Buffer.from(content);
    },
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
  const disks = new Map<string, Map<string, Buffer>>();
  /** The disk for this NAME, minted on first touch — one per VM, not per handle. */
  const diskFor = (name: string): Map<string, Buffer> => {
    const existing = disks.get(name);
    if (existing) return existing;
    const fresh = new Map<string, Buffer>();
    disks.set(name, fresh);
    return fresh;
  };
  const calls: FakeSpriteHost['calls'] = { provision: [], kill: [], attach: [] };
  let attempts = 0;

  const host: SandboxHost = {
    async provision({ name, appliedEgressToken }) {
      calls.provision.push({ name, appliedEgressToken });
      if (options.provisionError) throw options.provisionError;
      attempts += 1;
      const existing = live.get(name);
      if (existing && !options.nextInstanceId) {
        return makeHandle(name, existing.instanceId, existing.egressPolicyToken, diskFor(name));
      }
      const instanceId = options.nextInstanceId ? options.nextInstanceId(name, attempts) : `inst-${name}`;
      const egressPolicyToken = options.egressTokenFor?.(name) ?? existing?.egressPolicyToken;
      live.set(name, { instanceId, egressPolicyToken });
      return makeHandle(name, instanceId, egressPolicyToken, diskFor(name));
    },

    async attach({ sandboxId }) {
      calls.attach.push(sandboxId);
      if (options.attachError) throw options.attachError;
      const existing = live.get(sandboxId);
      if (!existing) return null;
      return makeHandle(sandboxId, existing.instanceId, existing.egressPolicyToken, diskFor(sandboxId));
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
      // A destroyed VM takes its filesystem with it. Modelled, because
      // "rebuild gives you a fresh disk under the same name" is a claim this
      // epic makes and a fake that kept the files would agree with a bug.
      disks.delete(sandboxId);
    },
  };

  return { host, live, calls, disks };
}

export function makeShellRecord(over: Partial<SessionShellRecord> = {}): SessionShellRecord {
  return {
    id: 'shell-id-1',
    workspaceId: SESSION_ID,
    ownerId: OWNER_ID,
    name: 'shell-1',
    agentType: 'shell',
    command: null,
    spriteExecId: null,
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
    async list(workspaceId) {
      return [...rows.values()].filter((row) => row.workspaceId === workspaceId);
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async create(input) {
      const duplicate = [...rows.values()].some(
        (row) => row.workspaceId === input.workspaceId && row.name === input.name,
      );
      if (duplicate) {
        // The `(workspaceId, name)` unique index, as Postgres reports it.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row = makeShellRecord({
        id: `shell-id-${counter}`,
        workspaceId: input.workspaceId,
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
    async updateSpriteExecId({ id, spriteExecId, now }) {
      const row = rows.get(id);
      if (!row) return;
      rows.set(id, { ...row, spriteExecId, updatedAt: now });
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
