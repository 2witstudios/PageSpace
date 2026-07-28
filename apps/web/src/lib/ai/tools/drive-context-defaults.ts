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
  const driveId = driveIdArg ?? resolveDefaultDriveId(context);
  if (!driveId) {
    throw new Error(
      'driveId is required: no workspace is currently in view and none was provided. Use list_drives to choose one.',
    );
  }
  return driveId;
}
