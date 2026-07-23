/**
 * Production wiring for Machine Settings (Terminal — GA, Machine page rebuild).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * machine-settings`) to the real DB + Sprite implementations. Access is governed
 * by the Machine page — this reuses `canViewMachine`/`canEditMachine` (re-exported
 * here as `canAccessMachine` for the settings route) from the canonical
 * `./machine-access-runtime`, rather than duplicating the page-permission check.
 *
 * `createDbMachineSettingsStore` reads/writes the four settings fields on the
 * Machine's `pages` row, broadcasts a page `updated`/`trashed` event (so other
 * clients and the drive tree don't show a stale name/still-present page — the
 * same events the canonical page routes emit), and soft-deletes the page via
 * the canonical `pageService.trashPage` (descendant cascade-trash, revision
 * bump + page version, page-trash workflow triggers — exactly what the page
 * DELETE route does).
 *
 * `createDbMachineRefScrub` removes the deleted machineId from every agent
 * config that references it: AI_CHAT agents' `machines` MachineRef arrays
 * (written through the canonical `applyPageMutation` so each agent page gets
 * its own revision bump/version/activity entry, as `pageAgentRepository.
 * updateAgentConfig` does) and the per-user `global_assistant_config.machines`
 * blob (same MachineRef shape — migration 0195 rewrote both together). Without
 * this, a freshly-deleted Machine lingers in agent configs as a dangling ref.
 * Scrubbed refs are NOT restored when the Machine page is restored — a ref is
 * the referencing agent's setting, and its owner re-links explicitly.
 *
 * `createMachineSpriteTeardown` tears down ALL the compute the delete hides:
 * every MACHINE page in the trashed subtree (the cascade-trash hides nested
 * Machines too, so skipping them would leak live microVMs behind hidden pages),
 * and per machine, each branch's OWN Sprite (tracked only in `machine_branches`
 * — a Sprite that goes idle simply hibernates on its own, it is never destroyed
 * automatically), then that Machine's own persistent Sprite (resolved the same
 * way the shell/session layer does: derive the `machine_sessions` key from
 * (tenant, drive, page), look up its `sandboxId`, kill through the `MachineHost`
 * seam). Everything runs inside `teardown()` so any host error surfaces AFTER
 * the page is trashed, landing in `deleteMachine`'s recoverable path. Only
 * own-Sprite kill failures govern `spriteTornDown`; branch kills and the
 * tracking-row removal are best-effort so they never invert that flag.
 *
 * The Machine's dependent metadata ROWS (`machine_projects` / `machine_branches` /
 * `machine_agent_terminals`) are intentionally left in place — they FK-cascade on
 * the page's eventual HARD purge, so a reversible soft-delete never destroys the
 * user's configured-repo metadata (killing the Sprites frees the compute; the rows
 * stay for a restore). `machine_branches` rows are STAMPED
 * (`spriteTornDownAt`) rather than deleted for exactly this reason: they are
 * re-creatable config, and deleting one would cascade away its branch-scoped
 * `machine_agent_terminals` too.
 *
 * `machine_sessions` is the one row that IS deleted on a confirmed kill: it is a
 * pure live-Sprite pointer, and the storage reconcile bills every row it finds,
 * so a row outliving its Sprite would bill storage for a destroyed VM. A restore
 * simply provisions a fresh Sprite under the same derived session key.
 *
 * Before any kill, the teardown stamps `teardownRequestedAt` on the rows it is
 * about to destroy. That INTENT — not the page's trashed state — is what
 * licenses the orphan reconciler (`machine-orphan-reconcile.ts`) to finish the
 * job if a kill here fails or this process dies mid-teardown. It has to be
 * recorded, because a kill is an irreversible DESTROY while a trash is not: the
 * generic page-trash paths (`pageService.trashPage`, bulk delete, folder
 * cascade-trash) hide a MACHINE page WITHOUT tearing anything down, and those
 * Sprites must survive for a restore. So "trashed + a Sprite we still believe is
 * LIVE + a teardown was requested" is the reclaim signal — and it is written
 * first, deliberately, so a crash before the kill leaves the row reclaimable
 * rather than stranded.
 *
 * NOT handled here (deliberate scope): PATCH (`updateSettings`) still writes the
 * settings fields via raw `db.update` — a Machine rename/toggle does not bump the
 * page revision or fire page-update workflow triggers (the DELETE path is now
 * fully canonical; PATCH canonicalization is a separate follow-up). Also not
 * handled: returning 404 (vs 403) for an already-deleted machineId.
 * DELETE-permission gating IS enforced (`canDeleteMachine`), matching the
 * canonical page-trash — `pageService.trashPage` re-checks it on the canonical
 * path as well.
 */

import { and, eq, eqOrIsNull, inArray, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { globalAssistantConfig } from '@pagespace/db/schema/integrations';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { machineProjects } from '@pagespace/db/schema/machine-projects';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import {
  createDbMachineSessionStore,
  deriveMachineSessionKey,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canUserDeletePage } from '@pagespace/lib/permissions/permissions';
import { isMachinePage } from '@pagespace/lib/content/page-types.config';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { pageService } from '@/services/api/page-service';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { isMachineRef, type MachineRef } from '@/lib/repositories/page-agent-repository';
import type { PageType } from '@pagespace/lib/utils/enums';
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsStore,
  MachineSpriteTeardown,
  MachineRefScrub,
} from '@pagespace/lib/services/machines/machine-settings';
import { getMachineHostForBranches } from './machine-branches-runtime';
import { canViewMachine, canEditMachine } from './machine-access-runtime';

export { canViewMachine, canEditMachine as canAccessMachine };

/**
 * DELETE-level access. Destroying a Machine trashes its page, so — unlike GET
 * (view) / PATCH (edit) — it requires DELETE permission, matching the canonical
 * page-trash route (a drive MEMBER has canEdit but NOT canDelete, so gating a
 * page-trash on edit would let members destroy Machines they cannot delete).
 */
export async function canDeleteMachine(actorUserId: string, machineId: string): Promise<boolean> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machineId),
    columns: { type: true },
  });
  if (!page || !isMachinePage(page.type as PageType)) return false;
  return canUserDeletePage(actorUserId, machineId);
}

interface SettingsRow {
  title: string;
  description: string | null;
  visibleToGlobalAssistant: boolean;
  allowPageAgents: boolean;
}

function toMachineSettings(row: SettingsRow): MachineSettings {
  return {
    name: row.title,
    description: row.description ?? null,
    visibleToGlobalAssistant: row.visibleToGlobalAssistant,
    allowPageAgents: row.allowPageAgents,
  };
}

async function readSettings(machineId: string): Promise<MachineSettings | null> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machineId),
    columns: {
      title: true,
      description: true,
      visibleToGlobalAssistant: true,
      allowPageAgents: true,
      isTrashed: true,
    },
  });
  if (!page || page.isTrashed) return null;
  return toMachineSettings(page);
}

export function createDbMachineSettingsStore(actorUserId: string): MachineSettingsStore {
  return {
    getSettings: readSettings,
    async updateSettings(machineId: string, patch: MachineSettingsPatch): Promise<MachineSettings | null> {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.title = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.visibleToGlobalAssistant !== undefined) set.visibleToGlobalAssistant = patch.visibleToGlobalAssistant;
      if (patch.allowPageAgents !== undefined) set.allowPageAgents = patch.allowPageAgents;

      // The route's parsePatch guarantees >=1 field, so `set` is never empty here.
      set.updatedAt = new Date();
      // Guard `isTrashed = false` in the WHERE so a PATCH on a trashed Machine
      // mutates NOTHING (canViewMachine/canAccessMachine don't exclude trashed
      // pages) and `.returning()` yields no row → the route replies 404 without
      // having written to a trashed page. This also folds the post-update re-read
      // into the same statement instead of a second SELECT.
      const [row] = await db
        .update(pages)
        .set(set)
        .where(and(eq(pages.id, machineId), eq(pages.isTrashed, false)))
        .returning({
          title: pages.title,
          description: pages.description,
          visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
          allowPageAgents: pages.allowPageAgents,
          driveId: pages.driveId,
        });
      if (!row) return null;

      // Broadcast only when the drive tree's view actually changed (the title) —
      // toggling a flag or editing the description alters nothing the tree renders,
      // so those saves skip the fan-out.
      if (patch.name !== undefined) {
        await broadcastPageEvent(createPageEventPayload(row.driveId, machineId, 'updated', { title: row.title }));
      }
      return toMachineSettings(row);
    },
    async trashPage(machineId: string): Promise<void> {
      // The canonical page-trash: descendant cascade, revision bump + page
      // version, and page-trash workflow triggers, exactly like the page
      // DELETE route. It re-checks delete permission for `actorUserId` — the
      // route's canDeleteMachine gate is the same check, so this never flips
      // an authorized delete to a failure.
      const result = await pageService.trashPage(machineId, actorUserId, {
        trashChildren: true,
        metadata: { source: 'machine_settings' },
      });
      if (!result.success) {
        // deleteMachine treats a trashPage throw as the non-recoverable step
        // failing — nothing has been torn down yet, so surfacing is correct.
        throw new Error(`Failed to trash Machine page: ${result.error}`);
      }
      await broadcastPageEvent(
        createPageEventPayload(result.driveId, machineId, 'trashed', {
          title: result.pageTitle ?? undefined,
          parentId: result.parentId ?? undefined,
        }),
      );
    },
  };
}

/**
 * Delete-time scrub of MachineRef entries pointing at a deleted Machine. Two
 * homes hold them (the same pair migration 0195 rewrote): AI_CHAT agent pages'
 * `machines` jsonb — written through `applyPageMutation` so each touched agent
 * gets the canonical revision/version/activity treatment — and the per-user
 * `global_assistant_config.machines` blob (not a page; a direct jsonb rewrite,
 * filtered element-wise in SQL). Only elements matching the deleted machineId
 * are removed; every other element (including any malformed one) is preserved
 * byte-for-byte. Per-agent failures don't stop the sweep — the error is thrown
 * at the end so `deleteMachine` reports `agentRefsScrubbed: false`.
 */
export function createDbMachineRefScrub(actorUserId: string): MachineRefScrub {
  return {
    async scrub(machineId: string): Promise<void> {
      const ref = { kind: 'existing', machineId } satisfies MachineRef;
      const refJson = JSON.stringify(ref);
      const refArrayJson = JSON.stringify([ref]);

      const agents = await db
        .select({
          id: pages.id,
          revision: pages.revision,
          machines: pages.machines,
          machineAccess: pages.machineAccess,
        })
        .from(pages)
        .where(and(eq(pages.type, 'AI_CHAT'), sql`${pages.machines} @> ${refArrayJson}::jsonb`));

      const actorInfo = agents.length > 0 ? await getActorInfo(actorUserId) : null;

      let failures = 0;
      for (const agent of agents) {
        const current = Array.isArray(agent.machines) ? (agent.machines as unknown[]) : [];
        const filtered = current.filter(
          (entry) => !(isMachineRef(entry) && entry.kind === 'existing' && entry.machineId === machineId),
        );
        // When the scrub empties the list, machine access must be disabled too:
        // `resolveConfiguredMachines` treats machineAccess=true + machines=[] as
        // "fall back to {kind:'own'}", so leaving access on would silently
        // repoint the agent at a DIFFERENT machine instead of removing the one
        // it had. The agent's owner re-enables (and re-links) explicitly.
        const disableAccess = filtered.length === 0 && agent.machineAccess;
        try {
          await applyPageMutation({
            pageId: agent.id,
            operation: 'agent_config_update',
            updates: disableAccess ? { machines: filtered, machineAccess: false } : { machines: filtered },
            updatedFields: disableAccess ? ['machines', 'machineAccess'] : ['machines'],
            expectedRevision: agent.revision,
            context: {
              userId: actorUserId,
              actorEmail: actorInfo?.actorEmail,
              actorDisplayName: actorInfo?.actorDisplayName ?? undefined,
              changeGroupType: 'system',
              resourceType: 'agent',
              metadata: { cascade: 'machine_delete', machineId },
            },
          });
        } catch {
          // Keep sweeping — one blocked agent (e.g. a concurrent config save
          // bumped its revision) must not leave the rest dangling.
          failures += 1;
        }
      }

      // Both SET expressions read the OLD row, so the machineAccess CASE and
      // the machines rewrite see the same pre-update list: when removing the
      // ref empties it, access flips off in the same statement — same reason
      // as the agent path (`resolveGlobalConfiguredMachines` falls back to
      // {kind:'own'} and would auto-provision the user's personal Machine).
      await db
        .update(globalAssistantConfig)
        .set({
          machines: sql`(
            SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
            FROM jsonb_array_elements(${globalAssistantConfig.machines}) AS elem
            WHERE NOT (elem @> ${refJson}::jsonb)
          )`,
          machineAccess: sql`CASE WHEN NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${globalAssistantConfig.machines}) AS elem
            WHERE NOT (elem @> ${refJson}::jsonb)
          ) THEN false ELSE ${globalAssistantConfig.machineAccess} END`,
        })
        .where(sql`${globalAssistantConfig.machines} @> ${refArrayJson}::jsonb`);

      if (failures > 0) {
        throw new Error(`Failed to scrub deleted machine ${machineId} from ${failures} agent config(s)`);
      }
    },
  };
}

/**
 * Tears down the Sprites of ONE Machine page: branch Sprites (never destroyed
 * automatically — only hibernated on idle) are killed best-effort first, then
 * the Machine's own Sprite, whose kill failure throws; the tracking-row
 * removal is best-effort so a post-kill DB error can't falsely report the
 * Sprite as still alive.
 */
async function teardownOneMachine(machineId: string): Promise<void> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, machineId),
    columns: { driveId: true },
  });
  if (!page) return;

  // Only branches whose Sprite we still believe is LIVE. A row stamped by an
  // earlier teardown (trash → restore → trash) points at a Sprite that is
  // already gone, so re-killing it would just be a wasted API round-trip.
  const branchRows = await db
    .select({
      id: machineBranches.id,
      sandboxId: machineBranches.sandboxId,
      spriteInstanceId: machineBranches.spriteInstanceId,
    })
    .from(machineBranches)
    .where(and(eq(machineBranches.machineId, machineId), isNull(machineBranches.spriteTornDownAt)));

  // PROMOTED projects only: an unpromoted project is a checkout inside the
  // machine's own Sprite, which the machine-session kill below already frees.
  const projectRows = await db
    .select({
      id: machineProjects.id,
      sandboxId: machineProjects.sandboxId,
      spriteInstanceId: machineProjects.spriteInstanceId,
    })
    .from(machineProjects)
    .where(
      and(
        eq(machineProjects.machineId, machineId),
        isNotNull(machineProjects.sandboxId),
        isNull(machineProjects.spriteTornDownAt),
      ),
    );

  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, page.driveId),
    columns: { ownerId: true },
  });
  const sessionKey = drive
    ? deriveMachineSessionKey({
        tenantId: drive.ownerId,
        driveId: page.driveId,
        pageId: machineId,
        secret: getSandboxSessionSecret(),
      })
    : null;
  const sessionStore = await createDbMachineSessionStore();
  const session = sessionKey ? await sessionStore.findBySessionKey(sessionKey) : null;

  if (branchRows.length === 0 && projectRows.length === 0 && !session) return; // Nothing live to tear down.

  // Record the INTENT to destroy, BEFORE any kill — this is what licenses the
  // orphan reconciler to finish the job if a kill below fails (or if this process
  // dies mid-teardown). Without it, a failed kill is indistinguishable from a
  // Machine someone merely dragged to the trash, whose Sprite must NOT be
  // destroyed (a trash is reversible; a kill is not). Written first precisely so
  // a crash between here and the kill leaves the row RECLAIMABLE rather than
  // stranded. See `machine-orphan-reconcile.ts`'s tier 1.
  const teardownRequestedAt = new Date();
  if (session && sessionKey) {
    await db
      .update(machineSessions)
      .set({ teardownRequestedAt })
      .where(eq(machineSessions.sessionKey, sessionKey));
  }
  if (branchRows.length > 0) {
    await db
      .update(machineBranches)
      .set({ teardownRequestedAt })
      .where(
        inArray(
          machineBranches.id,
          branchRows.map((branch) => branch.id),
        ),
      );
  }
  if (projectRows.length > 0) {
    await db
      .update(machineProjects)
      .set({ teardownRequestedAt })
      .where(
        inArray(
          machineProjects.id,
          projectRows.map((project) => project.id),
        ),
      );
  }

  const host = await getMachineHostForBranches();

  // Branch Sprites: best-effort. A failure must not fail the delete or invert
  // spriteTornDown — the branch row is left UNSTAMPED so the orphan reconciler
  // (@pagespace/lib/services/machines/machine-orphan-reconcile, wired in
  // ./machine-orphan-reconcile-runtime) can find the sandboxId and retry.
  //
  // On a CONFIRMED kill we STAMP `spriteTornDownAt` — we never delete the row.
  // The row is re-creatable config, not just a pointer (`spawnBranch`
  // re-provisions a vanished branch under the same sessionKey and re-clones),
  // and its branch-scoped `machine_agent_terminals` FK-cascade off it, so
  // deleting it here would destroy the user's branch terminals on a REVERSIBLE
  // soft-delete. "Live Sprite" is therefore `spriteTornDownAt IS NULL`, not the
  // row's existence — which is exactly the signal the reconciler reclaims on.
  for (const branch of branchRows) {
    try {
      // Identity-guarded: the kill is name-keyed and names are reused, so without
      // this we could destroy a replacement VM instead of the one we mean.
      await host.kill({
        machineId: branch.sandboxId,
        expectedInstanceId: branch.spriteInstanceId ?? undefined,
      });
      await db
        .update(machineBranches)
        .set({ spriteTornDownAt: new Date() })
        // CAS on the INSTANCE, not the name: a concurrent re-provision may already
        // have written a LIVE replacement into this row, and stamping that as torn
        // down would hide a billing VM from the reconciler forever.
        .where(
          and(
            eq(machineBranches.id, branch.id),
            eq(machineBranches.sandboxId, branch.sandboxId),
            eqOrIsNull(machineBranches.spriteInstanceId, branch.spriteInstanceId),
          ),
        );
    } catch {
      // Best-effort; leave the row unstamped for the reconciler to retry.
    }
  }

  // Promoted-project Sprites: same best-effort contract as branches — a failed
  // kill leaves the row unstamped for the orphan reconciler to retry.
  for (const project of projectRows) {
    if (!project.sandboxId) continue;
    try {
      await host.kill({
        machineId: project.sandboxId,
        expectedInstanceId: project.spriteInstanceId ?? undefined,
      });
      await db
        .update(machineProjects)
        .set({ spriteTornDownAt: new Date() })
        // CAS on the INSTANCE — a concurrent re-promotion may already have
        // written a LIVE replacement into this row (see the branch loop).
        .where(
          and(
            eq(machineProjects.id, project.id),
            eq(machineProjects.sandboxId, project.sandboxId),
            eqOrIsNull(machineProjects.spriteInstanceId, project.spriteInstanceId),
          ),
        );
    } catch {
      // Best-effort; leave the row unstamped for the reconciler to retry.
    }
  }

  // The Machine's OWN Sprite. THIS kill's failure propagates — if it throws,
  // deleteMachine reports spriteTornDown=false. The tracking-row removal is
  // best-effort so a remove failure AFTER a successful kill doesn't invert the
  // flag into falsely reporting the Sprite as still alive.
  if (session && sessionKey) {
    await host.kill({
      machineId: session.sandboxId,
      expectedInstanceId: session.spriteInstanceId ?? undefined,
    });
    try {
      // CAS on sandboxId — NEVER a key-only delete. `sessionKey` is deterministic
      // per (tenant, drive, page) and `save` UPSERTS on it, so between the kill
      // above and this delete a concurrent `acquireMachineSession` can provision a
      // REPLACEMENT Sprite into this very row. Deleting by key alone would destroy
      // the pointer to that brand-new, LIVE Sprite — leaving it billing forever
      // with nothing, not even the orphan reconciler, able to find it.
      await sessionStore.removeIfSandbox({
        sessionKey,
        sandboxId: session.sandboxId,
        spriteInstanceId: session.spriteInstanceId,
      });
    } catch {
      // Sprite is dead; a stale machine_sessions row is harmless (the orphan
      // reconciler, or a re-provision under the same key, reclaims it).
    }
  }
}

/**
 * Collects the ids of every MACHINE-typed page strictly BELOW the given page.
 * Nothing prevents nesting a Machine under another Machine (page creation only
 * validates that the parent exists), and the delete's cascade-trash hides the
 * whole subtree — so the teardown must free the compute of every Machine in it,
 * not just the root. Runs AFTER the trash, so it must not filter on isTrashed.
 */
async function collectDescendantMachineIds(rootId: string): Promise<string[]> {
  // `seen` guards against parentId cycles: page moves reject them, but a
  // corrupt tree must degrade to a bounded walk, not an infinite teardown loop.
  const seen = new Set<string>([rootId]);
  const machineIds: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await db
      .select({ id: pages.id, type: pages.type })
      .from(pages)
      .where(inArray(pages.parentId, frontier));
    const fresh = children.filter((child) => !seen.has(child.id));
    for (const child of fresh) seen.add(child.id);
    frontier = fresh.map((child) => child.id);
    machineIds.push(
      ...fresh.filter((child) => isMachinePage(child.type as PageType)).map((child) => child.id),
    );
  }
  return machineIds;
}

/**
 * Tears down all the Sprites a Machine delete hides: every Machine page in the
 * trashed subtree (descendants first, the deleted root last), each via
 * `teardownOneMachine`. Every machine is ATTEMPTED even when an earlier one
 * fails; any own-Sprite kill failure is rethrown at the end so `deleteMachine`
 * reports `spriteTornDown: false` (the recoverable orphaned-Sprite state).
 */
export function createMachineSpriteTeardown(): MachineSpriteTeardown {
  return {
    async teardown(machineId: string): Promise<void> {
      const descendants = await collectDescendantMachineIds(machineId);
      let failures = 0;
      for (const id of [...descendants, machineId]) {
        try {
          await teardownOneMachine(id);
        } catch {
          failures += 1;
        }
      }
      if (failures > 0) {
        throw new Error(`Sprite teardown failed for ${failures} machine(s) under ${machineId}`);
      }
    },
  };
}
