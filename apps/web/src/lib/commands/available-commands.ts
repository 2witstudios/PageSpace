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
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import {
  BUILTIN_COMMANDS,
  builtinCommandId,
  resolveCommandPrecedence,
  type CommandScope,
  type CommandSummary,
  type ResolvedCommands,
} from '@pagespace/lib/commands/command-core';

type EntryPageRef = { driveId: string; isTrashed: boolean };

interface CommandRowShape {
  id: string;
  trigger: string;
  description: string;
  entryPageId: string;
  type: string;
  driveId: string | null;
  entryPage: EntryPageRef | null;
}

// Entry pages are loaded alongside each command so save-time invariants are
// re-checked at use: a trashed entry page suppresses the command, and a drive
// command whose entry page has since moved to another drive (e.g. via
// bulk-move) is suppressed rather than offered while broken.
const hasLiveEntryPage = <T extends { entryPage: EntryPageRef | null }>(
  row: T
): row is T & { entryPage: EntryPageRef } => row.entryPage !== null && !row.entryPage.isTrashed;

const toSummary = (row: CommandRowShape, scope: CommandScope): CommandSummary => ({
  id: row.id,
  trigger: row.trigger,
  description: row.description,
  scope,
  type: row.type as CommandSummary['type'],
  entryPageId: row.entryPageId,
  driveId: row.driveId ?? undefined,
});

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
    id: builtinCommandId(builtin.trigger),
    trigger: builtin.trigger,
    description: builtin.description,
    scope: 'builtin',
    type: 'builtin',
  }));

  // The personal and drive lookups are independent — run them concurrently
  // (this is the suggest picker's per-keystroke path).
  const entryPageColumns = { columns: { driveId: true, isTrashed: true } } as const;
  const [personalRows, driveRows] = await Promise.all([
    db.query.commands.findMany({
      where: and(eq(commands.userId, userId), eq(commands.enabled, true)),
      with: { entryPage: entryPageColumns },
    }),
    driveId
      ? db.query.commands.findMany({
          where: and(eq(commands.driveId, driveId), eq(commands.enabled, true)),
          with: { entryPage: entryPageColumns },
        })
      : [],
  ]);

  const livePersonal = personalRows.filter(hasLiveEntryPage);
  const liveDrive = driveRows.filter(
    (row) => hasLiveEntryPage(row) && row.entryPage.driveId === driveId
  );

  // Execution re-checks entry-page access with canUserViewPage (command
  // resolution skips with no_access otherwise), so the offered list must
  // apply the same predicate — a command the user can't actually run
  // (private entry page, custom-role denial, revoked cross-drive ref) is not
  // "available". One batched permission query covers both scopes; this keeps
  // the per-keystroke suggest path at a single permission round-trip.
  const entryPageIds = [...new Set([...livePersonal, ...liveDrive].map((row) => row.entryPageId))];
  const access =
    entryPageIds.length > 0 ? await getBatchPagePermissions(userId, entryPageIds) : null;
  const canViewEntryPage = (row: { entryPageId: string }): boolean =>
    access?.get(row.entryPageId)?.canView === true;

  return resolveCommandPrecedence(
    builtins,
    livePersonal.filter(canViewEntryPage).map((row) => toSummary(row, 'user')),
    liveDrive.filter(canViewEntryPage).map((row) => toSummary(row, 'drive'))
  );
}
