/**
 * Shared "which commands can this user see here?" query (Universal Commands).
 *
 * One source of truth for the merged, precedence-resolved command list:
 * the suggest endpoint (picker) and the /help built-in (AI injection) both
 * consume this, so the list the picker shows and the list the AI describes
 * can never drift apart.
 *
 * Membership is the CALLER's contract: `driveId` must already be verified
 * with isUserDriveMember (the suggest route 403s, the command resolver
 * degrades to a null drive). This keeps the hot suggest path at one
 * membership check instead of two.
 */

import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { commands } from '@pagespace/db/schema/commands';
import {
  BUILTIN_COMMANDS,
  resolveCommandPrecedence,
  type CommandSummary,
  type ResolvedCommands,
} from '@pagespace/lib/commands/command-core';

type EntryPageRef = { driveId: string; isTrashed: boolean };

// Entry pages are loaded alongside each command so save-time invariants are
// re-checked at use: a trashed entry page suppresses the command, and a drive
// command whose entry page has since moved to another drive (e.g. via
// bulk-move) is suppressed rather than offered while broken.
const hasLiveEntryPage = <T extends { entryPage: EntryPageRef | null }>(
  row: T
): row is T & { entryPage: EntryPageRef } => row.entryPage !== null && !row.entryPage.isTrashed;

/**
 * Load and precedence-resolve every command available to `userId`:
 * built-ins from the lib registry + the user's enabled personal commands +
 * (when `driveId` is non-null) that drive's enabled commands.
 *
 * `driveId` must be membership-verified by the caller; pass null for
 * contexts without a drive (global assistant) or non-members.
 */
export async function loadAvailableCommands(
  userId: string,
  driveId: string | null
): Promise<ResolvedCommands> {
  const builtins: CommandSummary[] = BUILTIN_COMMANDS.map((builtin) => ({
    id: `builtin:${builtin.trigger}`,
    trigger: builtin.trigger,
    description: builtin.description,
    scope: 'builtin',
    type: 'builtin',
  }));

  const personalRows = await db.query.commands.findMany({
    where: and(eq(commands.userId, userId), eq(commands.enabled, true)),
    with: { entryPage: { columns: { driveId: true, isTrashed: true } } },
  });
  const userCommands: CommandSummary[] = personalRows.filter(hasLiveEntryPage).map((row) => ({
    id: row.id,
    trigger: row.trigger,
    description: row.description,
    scope: 'user',
    type: row.type as CommandSummary['type'],
    entryPageId: row.entryPageId,
  }));

  let driveCommands: CommandSummary[] = [];
  if (driveId) {
    const driveRows = await db.query.commands.findMany({
      where: and(eq(commands.driveId, driveId), eq(commands.enabled, true)),
      with: { entryPage: { columns: { driveId: true, isTrashed: true } } },
    });
    driveCommands = driveRows
      .filter((row) => hasLiveEntryPage(row) && row.entryPage.driveId === driveId)
      .map((row) => ({
        id: row.id,
        trigger: row.trigger,
        description: row.description,
        scope: 'drive',
        type: row.type as CommandSummary['type'],
        entryPageId: row.entryPageId,
        driveId: row.driveId ?? undefined,
      }));
  }

  return resolveCommandPrecedence(builtins, userCommands, driveCommands);
}
