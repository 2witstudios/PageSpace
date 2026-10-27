import type { ToolExecutionContext } from '../core/types';

/**
 * Resolve the drive a tool should act on when the LLM omits `driveId`: the
 * agent's own in-turn focus (currentWorkingDrive, e.g. after create_page)
 * wins over the workspace the user was in when the turn started
 * (locationContext.currentDrive) — the drive-level mirror of
 * resolveDefaultPageId (page-context-defaults.ts).
 *
 * Only wire this into tools where "act on the workspace in view" is safe and
 * unambiguous. NOT for drive administration (rename_drive, update_drive_context,
 * set_home_page) and NOT for trash/restore, where an implicit target is a
 * footgun. Read tools that adopt it must echo the resolved drive back in their
 * result, so the model can tell "not there" from "looked in the wrong place".
 */
export function resolveDefaultDriveId(context: ToolExecutionContext | undefined): string | undefined {
  return context?.currentWorkingDrive?.id ?? context?.locationContext?.currentDrive?.id;
}

/**
 * Resolve an omitted `driveId` tool argument the same way across every drive
 * tool that supports the default, or throw the identical, tool-agnostic error.
 * Mirrors resolveOrThrowPageId so the two seams cannot drift in behavior or
 * wording.
 */
export function resolveOrThrowDriveId(
  driveIdArg: string | undefined,
  context: ToolExecutionContext | undefined,
): string {
  return resolveDriveScope(driveIdArg, context).driveId;
}

/** How a tool arrived at the drive it acted on, for echoing back to the model. */
export type DriveScopeSource = 'explicit' | 'current_location';

/**
 * Same resolution as `resolveOrThrowDriveId`, plus the label describing WHICH
 * branch produced the id. Read tools echo that label, because a defaulted scope
 * that searched the wrong workspace returns an empty result — and an empty
 * result reads as "it doesn't exist" unless the model can see where we looked.
 *
 * The label is produced HERE, next to the decision, rather than re-derived from
 * the argument at each call site: those two can drift the moment a tool resolves
 * its drive some other way, and a stale `'explicit'` is a lie the model can't
 * detect.
 */
export function resolveDriveScope(
  driveIdArg: string | undefined,
  context: ToolExecutionContext | undefined,
): { driveId: string; scopeSource: DriveScopeSource } {
  if (driveIdArg) return { driveId: driveIdArg, scopeSource: 'explicit' };
  const driveId = resolveDefaultDriveId(context);
  if (!driveId) {
    throw new Error(
      'driveId is required: no workspace is currently in view and none was provided. Use list_drives to choose one.',
    );
  }
  return { driveId, scopeSource: 'current_location' };
}
