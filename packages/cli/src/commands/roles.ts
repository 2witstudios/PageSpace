/**
 * `pagespace roles list|get|create|update|delete|set-page-permissions|
 * set-drive-wide-permissions|remove-page-permissions`. Thin projections over
 * the `roles.*` SDK operations — argv parsing and result rendering are pure;
 * `ctx.sdk` is the only I/O edge each handler touches directly (`delete` and
 * `remove-page-permissions` also read `ctx.isTTY`/`ctx.prompt` via the shared
 * confirmation gate, same as `drives trash`/`tasks delete`).
 *
 * Permission triples (view/edit/share) are always passed as three explicit
 * `--view/--edit/--share true|false` flags, all-or-nothing — the underlying
 * schema requires every flag on a permission write (an omitted flag is
 * treated as an explicit `false` server-side, so a partial triple would
 * silently grant less than the caller intended; see
 * `packages/sdk/src/operations/roles.ts`'s `pagePermSchema` doc comment).
 *
 * `create`'s `permissions` field is always sent as `{}` — the route requires
 * the field to be present even though this CLI defers per-page grants to
 * `roles set-page-permissions` afterward (matches the in-app AI tool at
 * `apps/web/src/lib/ai/tools/role-management-tools.ts`).
 *
 * `update` never touches per-page permissions (the SDK operation deliberately
 * excludes the wholesale `permissions` field — see that operation's doc
 * comment) — only name/description/color/isDefault/driveWidePermissions.
 * Per-page grants always go through `set-page-permissions`/
 * `remove-page-permissions`, which use the SDK's own ergonomic builders
 * (`buildSetRolePagePermissionsInput`, `buildRemoveRolePagePermissionsInput`,
 * `buildSetRoleDriveWidePermissionsInput`) rather than hand-constructing the
 * `permissionsPatch` shape.
 *
 * `update`'s nullable string fields (`description`/`color`) distinguish
 * "leave unchanged" (flag omitted) from "clear to null" (`--clear-description`/
 * `--clear-color`, mutually exclusive with the corresponding value flag) —
 * see `resolveNullableField` — since a value flag alone can never express
 * `null` over argv.
 */
import type { PageSpaceClient } from '@pagespace/sdk';
import {
  buildRemoveRolePagePermissionsInput,
  buildSetRoleDriveWidePermissionsInput,
  buildSetRolePagePermissionsInput,
} from '@pagespace/sdk';
import { confirmationFailureMessage, confirmDestructive } from '../confirm.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { callSdk } from './sdk-error.js';

type RoleEnvelope = Awaited<ReturnType<PageSpaceClient['roles']['get']>>;
type Role = RoleEnvelope['role'];

/** Pure: no I/O. */
export function renderRole(role: Role): string {
  return `${role.id}  ${role.name}  [${role.color ?? 'no-color'}]${role.isDefault ? '  (default)' : ''}\n`;
}

/** Pure: no I/O. */
export function renderRolesList(roles: readonly Role[]): string {
  if (roles.length === 0) return 'No roles.\n';
  return roles.map((role) => renderRole(role)).join('');
}

/** Pure: no I/O. Adds drive-wide permissions and per-page override count beyond `renderRole`'s one-liner. */
function renderRoleDetail(role: Role): string {
  const driveWide = role.driveWidePermissions
    ? `view=${role.driveWidePermissions.canView} edit=${role.driveWidePermissions.canEdit} share=${role.driveWidePermissions.canShare}`
    : 'none';
  const overrideCount = Object.keys(role.permissions).length;
  return `${renderRole(role)}  drive-wide permissions: ${driveWide}\n  per-page overrides: ${overrideCount}\n`;
}

// ---------------------------------------------------------------------------
// Local argv helpers (private to this file, following the no-shared-flag-
// utility convention already used in agents.ts/tasks.ts).
// ---------------------------------------------------------------------------

interface ScanFlagsSpec {
  readonly valueFlags: readonly string[];
  readonly booleanFlags: readonly string[];
}

type ScanFlagsResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string>; readonly booleans: ReadonlySet<string>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Consumes any of `spec`'s value- or presence-taking tokens, passing everything else through in `rest`. */
function scanFlags(args: readonly string[], spec: ScanFlagsSpec): ScanFlagsResult {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (spec.valueFlags.includes(token)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${token} requires a value.` };
      values.set(token, value);
      i += 2;
      continue;
    }
    if (spec.booleanFlags.includes(token)) {
      booleans.add(token);
      i += 1;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, values, booleans, rest };
}

type PermTripleResult =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'present'; readonly canView: boolean; readonly canEdit: boolean; readonly canShare: boolean };

/**
 * Pure: no I/O. All three of `viewFlag`/`editFlag`/`shareFlag` must be given
 * together (`'omitted'` if none given, `'error'` if 1-2 given or any value
 * isn't exactly "true"/"false") — never a partial triple, per this module's
 * doc comment.
 */
function parsePermTriple(values: ReadonlyMap<string, string>, viewFlag: string, editFlag: string, shareFlag: string): PermTripleResult {
  const view = values.get(viewFlag);
  const edit = values.get(editFlag);
  const share = values.get(shareFlag);
  const givenCount = [view, edit, share].filter((value) => value !== undefined).length;

  if (givenCount === 0) return { kind: 'omitted' };
  if (givenCount < 3) {
    const missing = [
      view === undefined ? viewFlag : null,
      edit === undefined ? editFlag : null,
      share === undefined ? shareFlag : null,
    ].filter((flag): flag is string => flag !== null);
    return { kind: 'error', message: `Flags ${viewFlag}/${editFlag}/${shareFlag} must all be given together (missing: ${missing.join(', ')}).` };
  }

  for (const [flag, value] of [
    [viewFlag, view],
    [editFlag, edit],
    [shareFlag, share],
  ] as const) {
    if (value !== 'true' && value !== 'false') {
      return { kind: 'error', message: `Invalid value for ${flag}: "${value}". Expected "true" or "false".` };
    }
  }

  return { kind: 'present', canView: view === 'true', canEdit: edit === 'true', canShare: share === 'true' };
}

// ---------------------------------------------------------------------------
// roles list -> roles.list
// ---------------------------------------------------------------------------

export const rolesListHandler: CommandHandler = async (ctx, intent) => {
  const [driveId] = intent.args;
  if (!driveId || intent.args.length > 1) {
    ctx.stderr.write('Usage: pagespace roles list <driveId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.roles.list({ driveId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(renderRolesList(result.value.roles));
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles get -> roles.get
// ---------------------------------------------------------------------------

export const rolesGetHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, roleId] = intent.args;
  if (!driveId || !roleId || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace roles get <driveId> <roleId>\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.roles.get({ driveId, roleId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(renderRoleDetail(result.value.role));
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles create -> roles.create
// ---------------------------------------------------------------------------

const CREATE_USAGE =
  'Usage: pagespace roles create <driveId> <name> [--description <text>] [--color <hex>] [--is-default true|false] [--drive-wide-view true|false --drive-wide-edit true|false --drive-wide-share true|false]\n';

export const rolesCreateHandler: CommandHandler = async (ctx, intent) => {
  const scanned = scanFlags(intent.args, {
    valueFlags: ['--description', '--color', '--is-default', '--drive-wide-view', '--drive-wide-edit', '--drive-wide-share'],
    booleanFlags: [],
  });
  if (!scanned.ok) {
    ctx.stderr.write(`${scanned.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [driveId, name, ...extra] = scanned.rest;
  if (!driveId || !name || extra.length > 0) {
    ctx.stderr.write(CREATE_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const driveWide = parsePermTriple(scanned.values, '--drive-wide-view', '--drive-wide-edit', '--drive-wide-share');
  if (driveWide.kind === 'error') {
    ctx.stderr.write(`${driveWide.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const isDefaultRaw = scanned.values.get('--is-default');
  if (isDefaultRaw !== undefined && isDefaultRaw !== 'true' && isDefaultRaw !== 'false') {
    ctx.stderr.write(`Invalid value for --is-default: "${isDefaultRaw}". Expected "true" or "false".\n`);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.roles.create({
      driveId,
      name,
      description: scanned.values.get('--description'),
      color: scanned.values.get('--color'),
      isDefault: isDefaultRaw === undefined ? undefined : isDefaultRaw === 'true',
      permissions: {},
      driveWidePermissions:
        driveWide.kind === 'present'
          ? { canView: driveWide.canView, canEdit: driveWide.canEdit, canShare: driveWide.canShare }
          : undefined,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Created role ${renderRole(result.value.role)}`);
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles update -> roles.update
// ---------------------------------------------------------------------------

const UPDATE_USAGE =
  'Usage: pagespace roles update <driveId> <roleId> [--name <text>] [--description <text>|--clear-description] [--color <hex>|--clear-color] [--is-default true|false] [--drive-wide-view/--drive-wide-edit/--drive-wide-share true|false | --clear-drive-wide]\n';

/** Pure: no I/O. Resolves a nullable string field from its value flag and clear flag — mutually exclusive; `undefined` means "leave unchanged". */
function resolveNullableField(
  values: ReadonlyMap<string, string>,
  booleans: ReadonlySet<string>,
  valueFlag: string,
  clearFlag: string,
): { readonly ok: true; readonly value: string | null | undefined } | { readonly ok: false; readonly message: string } {
  const value = values.get(valueFlag);
  const clear = booleans.has(clearFlag);
  if (clear && value !== undefined) {
    return { ok: false, message: `Flags ${valueFlag} and ${clearFlag} are mutually exclusive.` };
  }
  return { ok: true, value: clear ? null : value };
}

export const rolesUpdateHandler: CommandHandler = async (ctx, intent) => {
  const scanned = scanFlags(intent.args, {
    valueFlags: ['--name', '--description', '--color', '--is-default', '--drive-wide-view', '--drive-wide-edit', '--drive-wide-share'],
    booleanFlags: ['--clear-drive-wide', '--clear-description', '--clear-color'],
  });
  if (!scanned.ok) {
    ctx.stderr.write(`${scanned.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [driveId, roleId, ...extra] = scanned.rest;
  if (!driveId || !roleId || extra.length > 0) {
    ctx.stderr.write(UPDATE_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const description = resolveNullableField(scanned.values, scanned.booleans, '--description', '--clear-description');
  if (!description.ok) {
    ctx.stderr.write(`${description.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const color = resolveNullableField(scanned.values, scanned.booleans, '--color', '--clear-color');
  if (!color.ok) {
    ctx.stderr.write(`${color.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const driveWide = parsePermTriple(scanned.values, '--drive-wide-view', '--drive-wide-edit', '--drive-wide-share');
  if (driveWide.kind === 'error') {
    ctx.stderr.write(`${driveWide.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  const clearDriveWide = scanned.booleans.has('--clear-drive-wide');
  if (clearDriveWide && driveWide.kind === 'present') {
    ctx.stderr.write('Flags --clear-drive-wide and --drive-wide-view/--drive-wide-edit/--drive-wide-share are mutually exclusive.\n');
    return EXIT_USAGE_ERROR;
  }

  const isDefaultRaw = scanned.values.get('--is-default');
  if (isDefaultRaw !== undefined && isDefaultRaw !== 'true' && isDefaultRaw !== 'false') {
    ctx.stderr.write(`Invalid value for --is-default: "${isDefaultRaw}". Expected "true" or "false".\n`);
    return EXIT_USAGE_ERROR;
  }

  const driveWidePermissions = clearDriveWide
    ? null
    : driveWide.kind === 'present'
      ? { canView: driveWide.canView, canEdit: driveWide.canEdit, canShare: driveWide.canShare }
      : undefined;

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.roles.update({
      driveId,
      roleId,
      name: scanned.values.get('--name'),
      description: description.value,
      color: color.value,
      isDefault: isDefaultRaw === undefined ? undefined : isDefaultRaw === 'true',
      driveWidePermissions,
    }),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Updated role ${roleId}.\n`);
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles delete -> roles.delete (destructive)
// ---------------------------------------------------------------------------

export const rolesDeleteHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, roleId] = intent.args;
  if (!driveId || !roleId || intent.args.length > 2) {
    ctx.stderr.write('Usage: pagespace roles delete <driveId> <roleId> [--yes]\n');
    return EXIT_USAGE_ERROR;
  }

  const confirmation = await confirmDestructive(`Delete role ${roleId}? [y/N] `, {
    isTTY: ctx.isTTY,
    yes: intent.flags.yes,
    prompt: ctx.prompt,
  });
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.roles.delete({ driveId, roleId }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Deleted role ${roleId}.\n`);
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles set-page-permissions -> roles.setPagePermissions
// ---------------------------------------------------------------------------

const SET_PAGE_PERMISSIONS_USAGE =
  'Usage: pagespace roles set-page-permissions <driveId> <roleId> <pageId> --view true|false --edit true|false --share true|false\n';

export const rolesSetPagePermissionsHandler: CommandHandler = async (ctx, intent) => {
  const scanned = scanFlags(intent.args, { valueFlags: ['--view', '--edit', '--share'], booleanFlags: [] });
  if (!scanned.ok) {
    ctx.stderr.write(`${scanned.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [driveId, roleId, pageId, ...extra] = scanned.rest;
  if (!driveId || !roleId || !pageId || extra.length > 0) {
    ctx.stderr.write(SET_PAGE_PERMISSIONS_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const triple = parsePermTriple(scanned.values, '--view', '--edit', '--share');
  if (triple.kind === 'error') {
    ctx.stderr.write(`${triple.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (triple.kind === 'omitted') {
    ctx.stderr.write(SET_PAGE_PERMISSIONS_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.roles.setPagePermissions(
      buildSetRolePagePermissionsInput({
        driveId,
        roleId,
        pageId,
        canView: triple.canView,
        canEdit: triple.canEdit,
        canShare: triple.canShare,
      }),
    ),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Set page permissions for role ${roleId} on page ${pageId}.\n`);
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles set-drive-wide-permissions -> roles.setDriveWidePermissions
// ---------------------------------------------------------------------------

const SET_DRIVE_WIDE_PERMISSIONS_USAGE =
  'Usage: pagespace roles set-drive-wide-permissions <driveId> <roleId> --view true|false --edit true|false --share true|false\n';

export const rolesSetDriveWidePermissionsHandler: CommandHandler = async (ctx, intent) => {
  const scanned = scanFlags(intent.args, { valueFlags: ['--view', '--edit', '--share'], booleanFlags: [] });
  if (!scanned.ok) {
    ctx.stderr.write(`${scanned.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const [driveId, roleId, ...extra] = scanned.rest;
  if (!driveId || !roleId || extra.length > 0) {
    ctx.stderr.write(SET_DRIVE_WIDE_PERMISSIONS_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const triple = parsePermTriple(scanned.values, '--view', '--edit', '--share');
  if (triple.kind === 'error') {
    ctx.stderr.write(`${triple.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (triple.kind === 'omitted') {
    ctx.stderr.write(SET_DRIVE_WIDE_PERMISSIONS_USAGE);
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.roles.setDriveWidePermissions(
      buildSetRoleDriveWidePermissionsInput({
        driveId,
        roleId,
        canView: triple.canView,
        canEdit: triple.canEdit,
        canShare: triple.canShare,
      }),
    ),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Set drive-wide permissions for role ${roleId}.\n`);
  }
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// roles remove-page-permissions -> roles.removePagePermissions (destructive)
// ---------------------------------------------------------------------------

export const rolesRemovePagePermissionsHandler: CommandHandler = async (ctx, intent) => {
  const [driveId, roleId, pageId] = intent.args;
  if (!driveId || !roleId || !pageId || intent.args.length > 3) {
    ctx.stderr.write('Usage: pagespace roles remove-page-permissions <driveId> <roleId> <pageId> [--yes]\n');
    return EXIT_USAGE_ERROR;
  }

  const confirmation = await confirmDestructive(`Remove permission override for page ${pageId} on role ${roleId}? [y/N] `, {
    isTTY: ctx.isTTY,
    yes: intent.flags.yes,
    prompt: ctx.prompt,
  });
  if (!confirmation.ok) {
    ctx.stderr.write(`${confirmationFailureMessage(confirmation)}\n`);
    return EXIT_RUNTIME_ERROR;
  }

  const result = await callSdk(ctx.stderr, () =>
    ctx.sdk.roles.removePagePermissions(buildRemoveRolePagePermissionsInput({ driveId, roleId, pageId })),
  );
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
  } else {
    ctx.stdout.write(`Removed page permission override for role ${roleId} on page ${pageId}.\n`);
  }
  return EXIT_SUCCESS;
};
