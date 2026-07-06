/**
 * Global assistant Terminal Access configuration.
 *
 * The global assistant's `terminalAccess`/`machines[]` parallel to
 * `PageAgentConfig` (page-agent-repository.ts) — same `MachineRef` shape,
 * reused (not forked), stored per-user on `globalAssistantConfig`
 * (packages/db/src/schema/integrations.ts) instead of per-page on `pages`.
 *
 * "Existing" machine selection is scoped to the user's HOME drive — the
 * global assistant has no single ambient drive the way a page agent has its
 * own drive, so the Home drive plays that role: it is also where the
 * lazily-provisioned "own machine" Terminal page lives (see
 * getOrCreateOwnMachinePageId), keeping every configured machine's driveId
 * consistent and predictable for authorization + session keying.
 */

import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { getOrCreateConfig, updateConfig as updateRawConfig } from '@pagespace/lib/integrations/repositories/config-repository';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getUserAccessiblePagesInDrive } from '@pagespace/lib/permissions/permissions';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { getDefaultContent } from '@pagespace/lib/content/page-types.config';
import { PageType } from '@pagespace/lib/utils/enums';
import { provisionHomeDriveIfNeeded } from '@/lib/onboarding/home-drive';
import { MachineRef, isMachineRefArray } from './page-agent-repository';

export const MAX_MACHINES = 20;

export interface GlobalTerminalConfig {
  terminalAccess: boolean;
  machines: MachineRef[];
}

export interface GlobalTerminalConfigUpdate {
  terminalAccess?: boolean;
  machines?: MachineRef[];
}

export type ValidateMachinesResult = { ok: true } | { ok: false; invalidIds: string[] };

function toConfig(row: { terminalAccess: boolean; machines: unknown }): GlobalTerminalConfig {
  return {
    terminalAccess: row.terminalAccess,
    machines: isMachineRefArray(row.machines) ? row.machines : [],
  };
}

export const globalTerminalConfigRepository = {
  async getConfig(userId: string): Promise<GlobalTerminalConfig> {
    const row = await getOrCreateConfig(db, userId);
    return toConfig(row);
  },

  async updateConfig(userId: string, update: GlobalTerminalConfigUpdate): Promise<GlobalTerminalConfig> {
    const data: { terminalAccess?: boolean; machines?: MachineRef[] } = {};
    if (update.terminalAccess !== undefined) data.terminalAccess = update.terminalAccess;
    if (update.machines !== undefined) data.machines = update.machines;
    const row = await updateRawConfig(db, userId, data);
    return toConfig(row);
  },

  /** Terminal pages in the user's Home drive they can see, for the "use existing machine" picker. */
  async getAvailableTerminals(userId: string): Promise<Array<{ id: string; title: string }>> {
    const homeDrive = await getHomeDrive(userId);
    if (!homeDrive) return [];
    const accessiblePageIds = await getUserAccessiblePagesInDrive(userId, homeDrive.id);
    if (accessiblePageIds.length === 0) return [];
    return db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(and(inArray(pages.id, accessiblePageIds), eq(pages.type, 'TERMINAL'), eq(pages.isTrashed, false)));
  },

  /**
   * Verify every 'existing' terminalId resolves to a non-trashed TERMINAL
   * page in the user's Home drive that they can access — mirrors
   * agent-config/route.ts's scoping, substituting the Home drive for "the
   * agent's own drive".
   */
  async validateMachines(userId: string, machines: MachineRef[]): Promise<ValidateMachinesResult> {
    const terminalIds = machines
      .filter((m): m is { kind: 'existing'; terminalId: string } => m.kind === 'existing')
      .map((m) => m.terminalId);
    if (terminalIds.length === 0) return { ok: true };

    const homeDrive = await getHomeDrive(userId);
    if (!homeDrive) return { ok: false, invalidIds: terminalIds };

    const accessiblePageIds = new Set(await getUserAccessiblePagesInDrive(userId, homeDrive.id));
    const validTerminals = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(inArray(pages.id, terminalIds), eq(pages.type, 'TERMINAL'), eq(pages.isTrashed, false)));
    const validIds = new Set(validTerminals.filter((t) => accessiblePageIds.has(t.id)).map((t) => t.id));
    const invalidIds = terminalIds.filter((id) => !validIds.has(id));
    return invalidIds.length === 0 ? { ok: true } : { ok: false, invalidIds };
  },

  /**
   * Get-or-create the personal Terminal page backing this user's "own"
   * machine (globalAssistantConfig.ownMachinePageId's doc comment). Lazily
   * provisioned on first use and persisted, so later calls reconnect to the
   * same page — and therefore the same machine session.
   */
  async getOrCreateOwnMachinePageId(userId: string): Promise<string> {
    const config = await getOrCreateConfig(db, userId);
    if (config.ownMachinePageId) {
      const existing = await pageRepository.findById(config.ownMachinePageId);
      if (existing && existing.type === PageType.TERMINAL) return existing.id;
    }

    const { driveId } = await provisionHomeDriveIfNeeded(userId);
    const position = await pageRepository.getNextPosition(driveId, null);
    const page = await pageRepository.create({
      title: 'My Machine',
      type: PageType.TERMINAL,
      content: getDefaultContent(PageType.TERMINAL),
      driveId,
      parentId: null,
      position,
      createdBy: userId,
    });

    await updateRawConfig(db, userId, { ownMachinePageId: page.id });
    return page.id;
  },
};
