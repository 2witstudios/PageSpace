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
 * `pageRepository.trash`.
 *
 * `createMachineSpriteTeardown` tears down ALL the compute a Machine spawned:
 * each branch's OWN Sprite (tracked in `machine_branches`, which — unlike the
 * Machine's own session — has no idle reaper, so a delete that skipped them would
 * leak microVMs), then the Machine's own persistent Sprite (resolved the same way
 * the shell/session layer does: derive the `machine_sessions` key from (tenant,
 * drive, page), look up its `sandboxId`, kill through the `MachineHost` seam).
 * Everything runs inside `teardown()` so any host error surfaces AFTER the page is
 * trashed, landing in `deleteMachine`'s recoverable path. Only the Machine's OWN
 * Sprite kill governs `spriteTornDown`; branch kills and the tracking-row removal
 * are best-effort so they never invert that flag.
 *
 * The Machine's dependent metadata ROWS (`machine_projects` / `machine_branches` /
 * `machine_agent_terminals`) are intentionally left in place — they FK-cascade on
 * the page's eventual HARD purge, so a reversible soft-delete never destroys the
 * user's configured-repo metadata (killing the Sprites frees the compute; the rows
 * stay for a restore).
 *
 * NOT handled here (deliberate scope — see the PR's flagged architecture decision):
 * this route writes the page via raw `db.update` / `pageRepository.trash` rather
 * than the canonical `applyPageMutation` / `pageService.trashPage` paths, so it does
 * NOT (yet): trash DESCENDANT pages of a Machine (Machine pages are
 * leaf-like in practice), bump the page `revision` / write a page-version / fire
 * page-update|trash workflow triggers, or scrub the deleted `machineId` from
 * AI_CHAT agents' `machines` arrays. Wiring those through the canonical services is
 * a follow-up (the Settings-UI node that exercises these paths is separate, and the
 * surface is behind `CODE_EXECUTION_ENABLED`, OFF). Also not handled: returning 404
 * (vs 403) for an already-deleted machineId. DELETE-permission gating IS enforced
 * (`canDeleteMachine`), matching the canonical page-trash.
 */

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import {
  createDbMachineSessionStore,
  deriveMachineSessionKey,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/machine-session-manager';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canUserDeletePage } from '@pagespace/lib/permissions/permissions';
import { isMachinePage } from '@pagespace/lib/content/page-types.config';
import type { PageType } from '@pagespace/lib/utils/enums';
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsStore,
  MachineSpriteTeardown,
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

export function createDbMachineSettingsStore(): MachineSettingsStore {
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
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, machineId),
        columns: { driveId: true, parentId: true },
      });
      await pageRepository.trash(machineId);
      if (page) {
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, machineId, 'trashed', { parentId: page.parentId }),
        );
      }
    },
  };
}

/**
 * Tears down all the Sprites a Machine spawned. See the module doc: branch Sprites
 * (no idle reaper) are killed best-effort first, then the Machine's own Sprite
 * whose kill governs `spriteTornDown`; the tracking-row removal is best-effort so a
 * post-kill DB error can't falsely report the Sprite as still alive.
 */
export function createMachineSpriteTeardown(): MachineSpriteTeardown {
  return {
    async teardown(machineId: string): Promise<void> {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, machineId),
        columns: { driveId: true },
      });
      if (!page) return;

      const branchRows = await db
        .select({ sandboxId: machineBranches.sandboxId })
        .from(machineBranches)
        .where(eq(machineBranches.machineId, machineId));

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

      if (branchRows.length === 0 && !session) return; // Nothing live to tear down.

      const host = await getMachineHostForBranches();

      // Branch Sprites: best-effort. A failure leaves a microVM the hard-purge
      // cascade won't reclaim (rows are kept), but it must not fail the delete or
      // invert spriteTornDown — the branch row stays so a retry can find it.
      for (const branch of branchRows) {
        try {
          await host.kill({ machineId: branch.sandboxId });
        } catch {
          // Best-effort; leave the row for a later retry.
        }
      }

      // The Machine's OWN Sprite. THIS kill governs spriteTornDown — if it throws,
      // deleteMachine reports spriteTornDown=false. The tracking-row removal is
      // best-effort so a remove failure AFTER a successful kill doesn't invert the
      // flag into falsely reporting the Sprite as still alive.
      if (session && sessionKey) {
        await host.kill({ machineId: session.sandboxId });
        try {
          await sessionStore.remove(sessionKey);
        } catch {
          // Sprite is dead; a stale machine_sessions row is harmless (the reaper
          // or a re-provision under the same key reclaims it).
        }
      }
    },
  };
}
