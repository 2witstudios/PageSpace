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
 * Machine's `pages` row and trashes it (soft delete) via `pageRepository.trash`.
 * `createMachineSpriteTeardown` resolves the Machine's persistent Sprite the same
 * way the shell/session layer does — derive the `terminal_sessions` key from
 * (tenant, drive, page) and look up its `sandboxId` — then kills it through the
 * `MachineHost` seam and drops the tracking row. Teardown is built LAZILY (host
 * acquisition happens inside `teardown()`, not at construction) so that any
 * runtime/host error surfaces AFTER the page has been trashed, landing in
 * `deleteMachine`'s recoverable-orphan path rather than aborting the delete before
 * the page is hidden.
 *
 * The Machine's dependent metadata (`machine_projects` / `machine_branches` /
 * `machine_agent_terminals`) is intentionally NOT touched on delete — it
 * FK-cascades on the page's eventual HARD purge, so a reversible soft-delete
 * never destroys the user's configured-repo metadata (see `deleteMachine`).
 */

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { pages, drives } from '@pagespace/db/schema/core';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import {
  createDbTerminalSessionStore,
  deriveTerminalSessionKey,
  getSandboxSessionSecret,
} from '@pagespace/lib/services/sandbox/terminal-session-manager';
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsStore,
  MachineSpriteTeardown,
} from '@pagespace/lib/services/machines/machine-settings';
import { canAccessMachine, canViewMachine, getMachineHostForBranches } from './machine-branches-runtime';

export { canAccessMachine, canViewMachine };

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
  return {
    name: page.title,
    description: page.description ?? null,
    visibleToGlobalAssistant: page.visibleToGlobalAssistant,
    allowPageAgents: page.allowPageAgents,
  };
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
        });
      if (!row) return null;
      return {
        name: row.title,
        description: row.description ?? null,
        visibleToGlobalAssistant: row.visibleToGlobalAssistant,
        allowPageAgents: row.allowPageAgents,
      };
    },
    async trashPage(terminalId: string): Promise<void> {
      await pageRepository.trash(terminalId);
    },
  };
}

/**
 * Tears down a Machine's persistent Sprite. Everything (host acquisition,
 * session lookup, kill) happens inside `teardown()` so a failure at any step is
 * caught by `deleteMachine` after the page is already trashed — see module doc.
 */
export function createMachineSpriteTeardown(): MachineSpriteTeardown {
  return {
    async teardown(terminalId: string): Promise<void> {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, terminalId),
        columns: { driveId: true },
      });
      if (!page) return;
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, page.driveId),
        columns: { ownerId: true },
      });
      if (!drive) return;

      const sessionKey = deriveTerminalSessionKey({
        tenantId: drive.ownerId,
        driveId: page.driveId,
        pageId: terminalId,
        secret: getSandboxSessionSecret(),
      });

      const sessionStore = await createDbTerminalSessionStore();
      const session = await sessionStore.findBySessionKey(sessionKey);
      if (!session) return; // No live Sprite tracked for this Machine — nothing to tear down.

      const host = await getMachineHostForBranches();
      await host.kill({ machineId: session.sandboxId });
      // Only drop the tracking row once the kill succeeds — if kill throws, the
      // row survives so the idle reaper (or a retry) can still reclaim the Sprite,
      // mirroring killBranch's untracked-orphan guard.
      await sessionStore.remove(sessionKey);
    },
  };
}
