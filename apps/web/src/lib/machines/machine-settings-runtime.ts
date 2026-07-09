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
 */

import { eq } from '@pagespace/db/operators';
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

      if (Object.keys(set).length > 0) {
        set.updatedAt = new Date();
        await db.update(pages).set(set).where(eq(pages.id, terminalId));
      }
      return readSettings(terminalId);
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
