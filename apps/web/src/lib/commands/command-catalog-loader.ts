/**
 * Per-request loader for the user/drive command catalog (volatile prompt
 * section + tool_search corpus entries). Membership is re-verified here —
 * the requested drive id is caller knowledge, not a trusted fact — mirroring
 * the command resolver's contract. Any failure degrades to an empty catalog:
 * capability discovery must never fail a chat request.
 */

import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { loadAvailableCommands } from './available-commands';
import {
  buildUserCommandCatalog,
  commandsToSearchEntries,
  type SkillSearchEntry,
} from '@/lib/ai/core/skill-catalog';

export interface UserCommandCatalog {
  /** Volatile AVAILABLE COMMANDS section ('' when the user has none). */
  catalogPrompt: string;
  /** The same commands as tool_search corpus entries. */
  searchEntries: SkillSearchEntry[];
}

const EMPTY: UserCommandCatalog = { catalogPrompt: '', searchEntries: [] };

export async function loadUserCommandCatalog(
  userId: string,
  requestedDriveId: string | null
): Promise<UserCommandCatalog> {
  try {
    const driveId =
      requestedDriveId && (await isUserDriveMember(userId, requestedDriveId))
        ? requestedDriveId
        : null;
    const { winners } = await loadAvailableCommands(userId, driveId);
    return {
      catalogPrompt: buildUserCommandCatalog(winners),
      searchEntries: commandsToSearchEntries(winners),
    };
  } catch (error) {
    loggers.ai.error('User command catalog failed; proceeding without it', error as Error);
    return EMPTY;
  }
}
