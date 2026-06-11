/**
 * Universal Commands — pure list transforms backing the useCommands hook's
 * optimistic updates and the settings list views (spec §3.1, §4.2).
 */

import type { CommandScope } from '@pagespace/lib/commands/command-core';

/** Shape of one command as returned by GET /api/commands (list-enriched). */
export interface CommandItem {
  id: string;
  scope: CommandScope;
  driveId: string | null;
  trigger: string;
  description: string;
  entryPageId: string;
  type: string;
  enabled: boolean;
  /** Entry-page enrichment for the settings lists. */
  entryPageTitle: string | null;
  entryPageDriveId: string | null;
  entryPageAvailable: boolean;
  /** "Added by {name}" for drive command rows; null for personal commands. */
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export function sortByTrigger(list: readonly CommandItem[]): CommandItem[] {
  return [...list].sort((a, b) => a.trigger.localeCompare(b.trigger));
}

export function toggleCommandInList(
  list: readonly CommandItem[],
  commandId: string,
  enabled: boolean
): CommandItem[] {
  return list.map((command) =>
    command.id === commandId ? { ...command, enabled } : command
  );
}

export function removeCommandFromList(
  list: readonly CommandItem[],
  commandId: string
): CommandItem[] {
  return list.filter((command) => command.id !== commandId);
}

export function upsertCommandInList(
  list: readonly CommandItem[],
  command: CommandItem
): CommandItem[] {
  const without = list.filter((existing) => existing.id !== command.id);
  return sortByTrigger([...without, command]);
}

export function personalCommands(list: readonly CommandItem[]): CommandItem[] {
  return list.filter((command) => command.scope === 'user');
}

export function commandsForDrive(
  list: readonly CommandItem[],
  driveId: string
): CommandItem[] {
  return list.filter((command) => command.scope === 'drive' && command.driveId === driveId);
}

/**
 * Names of drives whose drive command collides with a personal trigger
 * (W2 / the personal-list shadow indicator). Falls back to the drive id when
 * the name is not known client-side.
 */
export function shadowedDriveNames(
  trigger: string,
  list: readonly CommandItem[],
  driveNameById: ReadonlyMap<string, string>
): string[] {
  return list
    .filter(
      (command) =>
        command.scope === 'drive' && command.driveId !== null && command.trigger === trigger
    )
    .map((command) => driveNameById.get(command.driveId as string) ?? (command.driveId as string));
}
