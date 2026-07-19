/**
 * `pagespace drives list|create|rename|update-context|trash|restore` (Phase 5 task 1).
 * Thin projections over the `drives.*` SDK operations — argv parsing and
 * result rendering are pure; `ctx.sdk` is the only I/O edge each handler
 * touches directly (destructive `trash` also reads `ctx.isTTY`/`ctx.prompt`
 * via the shared confirmation gate).
 *
 * `drives trash` requires typing the drive's own name to confirm (matching
 * `assertDriveNameConfirmed`'s client-side guardrail — the route itself
 * trashes unconditionally, per inventory D11) rather than a plain yes/no,
 * since trashing a drive takes every page in it down too. `--yes` skips the
 * name prompt entirely and confirms with the drive's actual (already-known)
 * name.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import { assertDriveNameConfirmed } from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type DriveSummary = Awaited<ReturnType<PageSpaceClient['drives']['list']>>[number];
/** `create` and `rename`/`trash` return different (but overlapping) drive shapes — only id/name are rendered. */
interface DriveIdentity {
  readonly id: string;
  readonly name: string;
}

/** Pure: no I/O. */
export function renderDrivesList(drives: readonly DriveSummary[]): string {
  if (drives.length === 0) {
    return 'No drives.\n';
  }
  return drives.map((drive) => `${drive.id}  ${drive.name}  [${drive.kind}] (${drive.role})\n`).join('');
}

/** Pure: no I/O. */
export function renderDrive(drive: DriveIdentity): string {
  return `${drive.id}  ${drive.name}\n`;
}

export const drivesListHandler: CommandHandler = async (ctx, intent) => {
  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.list({ includeTrash: intent.flags.all || undefined }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(renderDrivesList(result.value));
  }
  return EXIT_SUCCESS;
};

export const drivesCreateHandler: CommandHandler = async (ctx, intent) => {
  const [name] = intent.args;
  if (!name) {
    ctx.stderr.write('Usage: pagespace drives create <name>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.create({ name }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Created drive ${renderDrive(result.value)}`);
  }
  return EXIT_SUCCESS;
};

export const drivesRenameHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, name] = intent.args;
  if (!driveId || !name || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace drives rename <driveId> <name>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.rename({ driveId, name }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Renamed drive to ${renderDrive(result.value)}`);
  }
  return EXIT_SUCCESS;
};

export const drivesUpdateContextHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, drivePrompt] = intent.args;
  if (!driveId || drivePrompt === undefined || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace drives update-context <driveId> <drivePrompt>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.updateContext({ driveId, drivePrompt }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Updated AI context for drive ${driveId}.\n`);
  }
  return EXIT_SUCCESS;
};

export const drivesSetHomePageHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, pageIdOrClear] = intent.args;
  if (!driveId || !pageIdOrClear || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace drives set-home-page <driveId> <pageId|--clear>\n');
    return EXIT_USAGE_ERROR;
  }

  const homePageId = pageIdOrClear === '--clear' ? null : pageIdOrClear;
  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.setHomePage({ driveId, homePageId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else if (homePageId === null) {
    ctx.stdout.write(`Cleared home page for drive ${driveId}.\n`);
  } else {
    ctx.stdout.write(`Set home page for drive ${driveId} to ${homePageId}.\n`);
  }
  return EXIT_SUCCESS;
};

export const drivesTrashHandler: CommandHandler = async (ctx, intent) => {
  const [driveId] = intent.args;
  if (!driveId) {
    ctx.stderr.write('Usage: pagespace drives trash <driveId> [--yes]\n');
    return EXIT_USAGE_ERROR;
  }

  const found = await callSdk(ctx.stderr, () => ctx.sdk.drives.list({}));
  if (!found.ok) return EXIT_RUNTIME_ERROR;

  const drive = found.value.find((candidate) => candidate.id === driveId);
  if (!drive) {
    ctx.stderr.write(`Drive not found or not accessible: ${driveId}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const confirmation = await confirmDestructive(
    `Type the drive name "${drive.name}" to confirm trashing it (all its pages will be trashed too): `,
    {
      isTTY: ctx.isTTY,
      yes: intent.flags.yes,
      prompt: ctx.prompt,
      isAffirmative: (answer) => assertDriveNameConfirmed(drive.name, answer.trim()).ok,
    },
  );
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.trash({ driveId, confirmDriveName: drive.name }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Trashed drive ${drive.name} (${driveId}).\n`);
  }
  return EXIT_SUCCESS;
};

export const drivesRestoreHandler: CommandHandler = async (ctx, intent) => {
  const [driveId] = intent.args;
  if (!driveId) {
    ctx.stderr.write('Usage: pagespace drives restore <driveId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.drives.restore({ driveId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Restored drive ${driveId}.\n`);
  }
  return EXIT_SUCCESS;
};
