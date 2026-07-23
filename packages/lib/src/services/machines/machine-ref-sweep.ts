/**
 * Dangling-MachineRef sweep (issue #2156) — the self-healing counterpart to
 * `createDbMachineRefScrub`.
 *
 * A Machine reference is stored TWICE: once as the Machine's own
 * `PageType.MACHINE` page row, and again — denormalized — as a `MachineRef`
 * inside two JSONB blobs, `pages.machines` on AI_CHAT agent pages and
 * `global_assistant_config.machines` per user. Only ONE code path keeps the
 * blobs honest: the Machine Settings delete (`deleteMachine` →
 * `MachineRefScrub`, machine-settings.ts). Every OTHER way a Machine page can
 * cease to exist bypasses it — "delete permanently" from the trash, a permanent
 * drive delete (pages FK-cascade), the 30-day purge cron, account erasure — and
 * each leaves a `{kind:'existing', machineId}` pointing at nothing, forever.
 *
 * Guarding each of those call sites is the same losing game the Sprite-reclaim
 * outbox already rejected (see machine-orphan-reconcile.ts's module doc): there
 * is always one more delete path, and erasure must never be blocked by
 * bookkeeping. So this module does not guard deletes — it RECONCILES: whatever
 * ids the blobs still reference, minus the ids that still have a page row, is
 * the dead set, and dead refs are dropped. That converges no matter how the row
 * vanished, including by hand in psql.
 *
 * DEAD MEANS "NO `pages` ROW AT ALL" — a TRASHED machine is ALIVE here. This is
 * the load-bearing distinction of the whole module. A trash is REVERSIBLE
 * (`pageService.trashPage`, bulk delete, folder cascade-trash all hide a MACHINE
 * page and a restore brings it back), while dropping a ref is NOT: a scrubbed
 * ref is never re-added on restore, because a `MachineRef` is the REFERENCING
 * agent's setting and only its owner re-links it (machine-settings.ts's
 * `deleteMachine` doc). Scrubbing on trash would therefore destroy a setting
 * that the user can still legitimately expect back. Same reason the orphan
 * reconciler refuses to kill a merely-trashed Machine's Sprite.
 *
 * Every effect is injected, so the decisions below are unit-testable without a
 * database. Runtime wiring: `apps/web/src/lib/machines/machine-ref-sweep-runtime.ts`.
 */

/**
 * Structural mirror of the canonical `MachineRef`
 * (apps/web/src/lib/repositories/page-agent-repository.ts) — same trick, and the
 * same reason, as `machine-session.ts`: @pagespace/lib must not import from the
 * web app.
 */
export type MachineRefLike = { kind: 'own' } | { kind: 'existing'; machineId: string };

/** The two blob homes, reduced to what a rewrite decision actually needs. */
export interface MachineRefHolder {
  /** The raw JSONB value. Deliberately `unknown` — a blob written by an older shape must not crash the sweep. */
  entries: unknown;
  machineAccess: boolean;
}

export interface MachineRefRewrite {
  /** False when no ref was dropped — the caller MUST skip the write (no revision churn, no activity noise). */
  changed: boolean;
  /** The surviving entries, in order. Non-ref elements are passed through by IDENTITY, never re-serialized. */
  machines: unknown[];
  machineAccess: boolean;
}

function isExistingRef(value: unknown): value is { kind: 'existing'; machineId: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, machineId } = value as { kind?: unknown; machineId?: unknown };
  return kind === 'existing' && typeof machineId === 'string' && machineId.length > 0;
}

function toEntryArray(entries: unknown): unknown[] {
  return Array.isArray(entries) ? entries : [];
}

/** Every machine id referenced by a batch of holders. Malformed elements contribute nothing. */
export function collectReferencedMachineIds(holders: readonly MachineRefHolder[]): Set<string> {
  const ids = new Set<string>();
  for (const holder of holders) {
    for (const entry of toEntryArray(holder.entries)) {
      if (isExistingRef(entry)) ids.add(entry.machineId);
    }
  }
  return ids;
}

/**
 * Decide one blob's rewrite. Mirrors `createDbMachineRefScrub`'s semantics
 * exactly, deliberately:
 *
 *  - only `{kind:'existing'}` elements naming a DEAD machine are removed;
 *  - `{kind:'own'}` and any malformed element survive untouched (we are fixing
 *    dangling pointers, not normalizing user data);
 *  - when the removal EMPTIES a list whose access was on, access is turned off
 *    too. `resolveConfiguredMachines`/`resolveGlobalConfiguredMachines`
 *    (sandbox-tools-runtime.ts) read `machineAccess=true` + `machines=[]` as
 *    "fall back to {kind:'own'}", so leaving access on would silently repoint
 *    the agent at a DIFFERENT machine instead of removing the one it lost.
 */
export function planMachineRefRewrite(input: {
  entries: unknown;
  machineAccess: boolean;
  deadMachineIds: ReadonlySet<string>;
}): MachineRefRewrite {
  const entries = toEntryArray(input.entries);
  const machines = entries.filter((entry) => !(isExistingRef(entry) && input.deadMachineIds.has(entry.machineId)));
  const changed = machines.length !== entries.length;
  return {
    changed,
    machines,
    // Only a rewrite that emptied the list flips access; a config that was
    // ALREADY empty is left exactly as the user configured it.
    machineAccess: changed && machines.length === 0 ? false : input.machineAccess,
  };
}

export interface MachineRefWrite<T extends MachineRefHolder> {
  config: T;
  machines: unknown[];
  machineAccess: boolean;
  /**
   * The dead set this rewrite was derived from. Passed to the writer so a
   * write that must re-read its row under a lock (the global-config blob has no
   * revision to compare-and-swap on) can re-apply the SAME decision to whatever
   * it finds, instead of clobbering a concurrent edit with a stale array.
   */
  deadMachineIds: ReadonlySet<string>;
}

export interface SweepMachineRefsDeps<A extends MachineRefHolder, G extends MachineRefHolder> {
  /**
   * Restricts the sweep to these machine ids — the ids a caller just hard-deleted.
   * Absent = sweep everything (the cron backstop). An EMPTY array means "nothing
   * was deleted", and is a no-op, NOT a full sweep.
   *
   * Scoping also bounds what may be declared dead: a scoped run proves nothing
   * about ids outside its set, so it never scrubs them.
   */
  candidateMachineIds?: readonly string[];
  listAgentConfigs: (candidateMachineIds?: readonly string[]) => Promise<A[]>;
  listGlobalConfigs: (candidateMachineIds?: readonly string[]) => Promise<G[]>;
  /** Which of these ids still have a `pages` row — trashed or not. */
  findExistingPageIds: (ids: readonly string[]) => Promise<readonly string[]>;
  /**
   * Applies a rewrite. Resolves `false` when it deliberately wrote NOTHING — a
   * compare-and-swap that lost, or a row already repaired by the time the write
   * reached it. Not an error, and not an update: counting it as one would report
   * repairs that never happened.
   */
  writeAgentConfig: (input: MachineRefWrite<A>) => Promise<boolean>;
  writeGlobalConfig: (input: MachineRefWrite<G>) => Promise<boolean>;
}

export interface SweepMachineRefsResult {
  /** The ids found referenced with no page row behind them. */
  deadMachineIds: string[];
  agentsUpdated: number;
  globalConfigsUpdated: number;
  /** Writes that threw. Isolated per config — one blocked write never leaves the rest dangling. */
  failures: number;
}

export async function sweepMachineRefs<A extends MachineRefHolder, G extends MachineRefHolder>(
  deps: SweepMachineRefsDeps<A, G>,
): Promise<SweepMachineRefsResult> {
  const empty: SweepMachineRefsResult = {
    deadMachineIds: [],
    agentsUpdated: 0,
    globalConfigsUpdated: 0,
    failures: 0,
  };

  const { candidateMachineIds } = deps;
  if (candidateMachineIds && candidateMachineIds.length === 0) return empty;

  const [agents, globals] = await Promise.all([
    deps.listAgentConfigs(candidateMachineIds),
    deps.listGlobalConfigs(candidateMachineIds),
  ]);

  const referenced = collectReferencedMachineIds([...agents, ...globals]);
  // A scoped run may only ever declare its OWN candidates dead: a ref to some
  // other machine in the same blob is none of this run's business (and its page
  // may simply not have been queried).
  const suspects = candidateMachineIds
    ? [...referenced].filter((id) => candidateMachineIds.includes(id))
    : [...referenced];
  if (suspects.length === 0) return empty;

  const alive = new Set(await deps.findExistingPageIds(suspects));
  const deadMachineIds = suspects.filter((id) => !alive.has(id));
  if (deadMachineIds.length === 0) return empty;

  const dead = new Set(deadMachineIds);
  let agentsUpdated = 0;
  let globalConfigsUpdated = 0;
  let failures = 0;

  for (const config of agents) {
    const plan = planMachineRefRewrite({ ...config, deadMachineIds: dead });
    if (!plan.changed) continue;
    try {
      const wrote = await deps.writeAgentConfig({
        config,
        machines: plan.machines,
        machineAccess: plan.machineAccess,
        deadMachineIds: dead,
      });
      if (wrote) agentsUpdated += 1;
    } catch {
      // Keep sweeping: one blocked agent (a concurrent config save bumped its
      // revision) must not leave every other blob dangling.
      failures += 1;
    }
  }

  for (const config of globals) {
    const plan = planMachineRefRewrite({ ...config, deadMachineIds: dead });
    if (!plan.changed) continue;
    try {
      const wrote = await deps.writeGlobalConfig({
        config,
        machines: plan.machines,
        machineAccess: plan.machineAccess,
        deadMachineIds: dead,
      });
      if (wrote) globalConfigsUpdated += 1;
    } catch {
      failures += 1;
    }
  }

  return { deadMachineIds, agentsUpdated, globalConfigsUpdated, failures };
}
