/**
 * Production wiring for Machine Settings (Terminal — GA, Machine page rebuild).
 *
 * Binds the provider-agnostic orchestration (`@pagespace/lib/services/machines/
 * machine-settings`) to the real DB + Sprite implementations. Access is governed
 * by the Machine's Terminal page — this reuses `canAccessMachine`/`canViewMachine`
 * from the Branches runtime (`./machine-branches-runtime`, the canonical home the
 * other machine routes also import) rather than duplicating the page-permission
 * check. (Phase 0's shared `machine-access.ts` is not present on this branch; the
 * established sibling convention is these two functions.)
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
 * the shell/session layer does: derive the `terminal_sessions` key from (tenant,
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
 * NOT handled here (deliberate, documented scope): trashing DESCENDANT pages of a
 * Machine (Machine/TERMINAL pages are leaf-like in practice, and cascading under
 * the task's edit-access DELETE would let an editor trash children they may lack
 * delete permission on — that reconciliation is a follow-up), and returning 404
 * (vs the current 403) for an already-deleted terminalId.
 */

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import {
  createDbTerminalSessionStore,
  deriveTerminalSessionKey,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsStore,
  MachineSpriteTeardown,
} from '@pagespace/lib/services/machines/machine-settings';
import { canAccessMachine, canViewMachine, getMachineHostForBranches } from './machine-branches-runtime';

export { canAccessMachine, canViewMachine };

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

async function readSettings(terminalId: string): Promise<MachineSettings | null> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, terminalId),
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
    async updateSettings(terminalId: string, patch: MachineSettingsPatch): Promise<MachineSettings | null> {
      const set: Record<string, unknown> = {};
      if (patch.name !== undefined) set.title = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.visibleToGlobalAssistant !== undefined) set.visibleToGlobalAssistant = patch.visibleToGlobalAssistant;
      if (patch.allowPageAgents !== undefined) set.allowPageAgents = patch.allowPageAgents;

      // Nothing to change — just report the current state.
      if (Object.keys(set).length === 0) return readSettings(terminalId);

      set.updatedAt = new Date();
      // Guard `isTrashed = false` in the WHERE so a PATCH on a trashed Machine
      // mutates NOTHING (canViewMachine/canAccessMachine don't exclude trashed
      // pages) and `.returning()` yields no row → the route replies 404 without
      // having written to a trashed page. This also folds the post-update re-read
      // into the same statement instead of a second SELECT.
      const [row] = await db
        .update(pages)
        .set(set)
        .where(and(eq(pages.id, terminalId), eq(pages.isTrashed, false)))
        .returning({
          title: pages.title,
          description: pages.description,
          visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
          allowPageAgents: pages.allowPageAgents,
          driveId: pages.driveId,
        });
      if (!row) return null;

      // Broadcast so the drive tree / other tabs pick up the new name immediately,
      // matching the canonical page-title update path (pages/[pageId] PATCH).
      await broadcastPageEvent(createPageEventPayload(row.driveId, terminalId, 'updated', { title: row.title }));
      return toMachineSettings(row);
    },
    async trashPage(terminalId: string): Promise<void> {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, terminalId),
        columns: { driveId: true, parentId: true },
      });
      await pageRepository.trash(terminalId);
      if (page) {
        await broadcastPageEvent(
          createPageEventPayload(page.driveId, terminalId, 'trashed', { parentId: page.parentId }),
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
    async teardown(terminalId: string): Promise<void> {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, terminalId),
        columns: { driveId: true },
      });
      if (!page) return;

      const branchRows = await db
        .select({ sandboxId: machineBranches.sandboxId })
        .from(machineBranches)
        .where(eq(machineBranches.terminalId, terminalId));

      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, page.driveId),
        columns: { ownerId: true },
      });
      const sessionKey = drive
        ? deriveTerminalSessionKey({
            tenantId: drive.ownerId,
            driveId: page.driveId,
            pageId: terminalId,
            secret: getSandboxSessionSecret(),
          })
        : null;
      const sessionStore = await createDbTerminalSessionStore();
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
          // Sprite is dead; a stale terminal_sessions row is harmless (the reaper
          // or a re-provision under the same key reclaims it).
        }
      }
    },
  };
}
