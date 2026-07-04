/**
 * Roles & permissions operations (Phase 3 task 7).
 *
 * Route-verified against `apps/web/src/app/api/drives/[driveId]/roles/route.ts`
 * (GET/POST) and `.../roles/[roleId]/route.ts` (GET/PATCH/DELETE)
 * (docs/sdk/operations-inventory.md §2.12, parity with MCP tools
 * `list_drive_roles`, `get_drive_role`, `create_drive_role`,
 * `update_drive_role`, `delete_drive_role`, `set_role_page_permissions`,
 * `set_role_drive_wide_permissions`, `remove_role_page_permissions`).
 *
 * IMPORTANT — the inventory's §2.12 rows (D-register era) describe the PATCH
 * route's page-permission field as a wholesale `permissions` map replace.
 * That is stale: fix #1765 added `permissionsPatch`, a read-merge-write
 * per-page patch — pages not named in the patch are untouched, and a `null`
 * entry prunes that page's override (falls back to driveWidePermissions)
 * instead of persisting an explicit all-false deny. The CURRENT route
 * (`roles/[roleId]/route.ts` PATCH, read above) accepts EITHER `permissions`
 * (wholesale replace) OR `permissionsPatch` (merge), rejecting both being
 * sent together. This SDK deliberately narrows to `permissionsPatch` for
 * every per-page mutation (`roles.setPagePermissions`, `roles.removePagePermissions`)
 * and never exposes the wholesale `permissions` field at all — a single-page
 * SDK call must never be able to wipe another page's grant. `roles.update`
 * only ever replaces `driveWidePermissions` (a single object, not a map, so
 * a wholesale replace there is safe).
 *
 * Transport note: `buildRequest` (Phase 2 task 3) serializes an operation's
 * non-path-param input fields as the JSON body verbatim — it has no
 * per-operation transform step. Since the wire body for page-permission ops
 * nests the target pageId as a *dynamic object key* inside `permissionsPatch`
 * (`{ permissionsPatch: { [pageId]: {...} } }`), the registry operations
 * below take `permissionsPatch`/`driveWidePermissions` as already-shaped
 * input fields. `buildSetRolePagePermissionsInput`, `buildRemoveRolePagePermissionsInput`,
 * and `buildSetRoleDriveWidePermissionsInput` are the pure ergonomic builders
 * (this phase's "resource module methods") that bridge the old MCP tools'
 * flat single-page arguments (`driveId, roleId, pageId, canView, canEdit,
 * canShare`) into that shape — CLI/MCP call sites use the builder, never
 * hand-construct the patch object.
 */
import { z } from 'zod';
import type { PagePerm } from '@pagespace/lib/permissions/membership-queries';
import { defineOperation } from '../registry/define.js';

/**
 * Structurally checked against the canonical `PagePerm` lattice
 * (`packages/lib/src/permissions/membership-queries.ts`) via `satisfies` —
 * the SDK must not restate the view/edit/share triple by hand and drift.
 * All three flags are always required (never optional): the route treats an
 * omitted flag on write as an explicit `false`, so a partial triple would
 * silently grant less than the caller intended — fail closed instead.
 */
const pagePermSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
}) satisfies z.ZodType<PagePerm>;

/** `DriveRole` (`packages/lib/src/services/drive-role-service.ts`), Date fields ISO-serialized over JSON. */
const driveRoleSchema = z.object({
  id: z.string(),
  driveId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  isDefault: z.boolean(),
  permissions: z.record(z.string(), pagePermSchema),
  driveWidePermissions: pagePermSchema.nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const roleEnvelopeSchema = z.object({ role: driveRoleSchema });

export const listDriveRoles = defineOperation({
  name: 'roles.list',
  method: 'GET',
  path: '/api/drives/:driveId/roles',
  inputSchema: z.object({ driveId: z.string() }).strict(),
  outputSchema: z.object({ roles: z.array(driveRoleSchema) }),
  requiredScope: 'drive',
  description: 'List all custom roles defined in a drive. Requires drive membership (owner or member).',
});

export const getDriveRole = defineOperation({
  name: 'roles.get',
  method: 'GET',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z.object({ driveId: z.string(), roleId: z.string() }).strict(),
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive',
  description: 'Get a single drive role with its full permission configuration. Requires drive membership.',
});

export const createDriveRole = defineOperation({
  name: 'roles.create',
  method: 'POST',
  path: '/api/drives/:driveId/roles',
  inputSchema: z
    .object({
      driveId: z.string(),
      name: z.string().min(1).max(50),
      description: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      isDefault: z.boolean().optional(),
      permissions: z.record(z.string(), pagePermSchema),
      driveWidePermissions: pagePermSchema.nullable().optional(),
    })
    .strict(),
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive:admin',
  description:
    'Create a new custom role in a drive. Requires owner or admin authority. The route requires `permissions` to be present (an empty map is valid) even though this operation only manages drive-wide/whole-map creation — use roles.setPagePermissions afterward for read-merge-write per-page grants.',
});

export const updateDriveRole = defineOperation({
  name: 'roles.update',
  method: 'PATCH',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z
    .object({
      driveId: z.string(),
      roleId: z.string(),
      name: z.string().min(1).max(50).optional(),
      description: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      isDefault: z.boolean().optional(),
      driveWidePermissions: pagePermSchema.nullable().optional(),
    })
    .strict(), // wholesale `permissions` deliberately excluded — see module doc; use roles.setPagePermissions/roles.removePagePermissions
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive:admin',
  description:
    "Update a role's name, description, color, default flag, or drive-wide baseline permissions. Requires owner or admin authority. Per-page permissions are never touched here — use roles.setPagePermissions or roles.removePagePermissions, which patch a single page without disturbing others.",
});

export const deleteDriveRole = defineOperation({
  name: 'roles.delete',
  method: 'DELETE',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z.object({ driveId: z.string(), roleId: z.string() }).strict(),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive:admin',
  destructive: true,
  description:
    'Delete a custom role from a drive, permanently discarding its permission grants. Requires owner or admin authority. Irreversible — the CLI requires --yes.',
});

export const setRolePagePermissions = defineOperation({
  name: 'roles.setPagePermissions',
  method: 'PATCH',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z
    .object({
      driveId: z.string(),
      roleId: z.string(),
      /** Read-merge-write: pages not named here are untouched. Every entry must be a full triple — this op only sets, never prunes (see roles.removePagePermissions). */
      permissionsPatch: z.record(z.string(), pagePermSchema),
    })
    .strict(),
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive:admin',
  description:
    "Grant or update a role's permissions on one or more specific pages via a server-side read-merge-write patch — other pages' grants are untouched. Requires owner or admin authority.",
});

export const setRoleDriveWidePermissions = defineOperation({
  name: 'roles.setDriveWidePermissions',
  method: 'PATCH',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z
    .object({
      driveId: z.string(),
      roleId: z.string(),
      driveWidePermissions: pagePermSchema,
    })
    .strict(),
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive:admin',
  description:
    "Set the drive-wide baseline permissions for a role (applies to all pages unless overridden per-page). Single-object replace — no merge needed. Requires owner or admin authority.",
});

export const removeRolePagePermissions = defineOperation({
  name: 'roles.removePagePermissions',
  method: 'PATCH',
  path: '/api/drives/:driveId/roles/:roleId',
  inputSchema: z
    .object({
      driveId: z.string(),
      roleId: z.string(),
      /** Every entry must be `null` (prune) — this op only removes, never sets (see roles.setPagePermissions). */
      permissionsPatch: z.record(z.string(), z.null()),
    })
    .strict(),
  outputSchema: roleEnvelopeSchema,
  requiredScope: 'drive:admin',
  destructive: true,
  description:
    "Remove a role's per-page permission entry for one or more specific pages via a server-side patch, so the role falls back to its drive-wide permissions there. Other pages' grants are preserved. Server-side effect is idempotent, but the CLI still requires --yes since a grant is discarded. Requires owner or admin authority.",
});

// ---------------------------------------------------------------------------
// Ergonomic single-page builders (pure) — bridge the old MCP tools' flat
// `{driveId, roleId, pageId, canView, canEdit, canShare}` argument shape into
// the `permissionsPatch` input the registry operations above require. See
// module doc for why buildRequest cannot do this transform generically.
// ---------------------------------------------------------------------------

export interface SetRolePagePermissionsArgs {
  readonly driveId: string;
  readonly roleId: string;
  readonly pageId: string;
  readonly canView: boolean;
  readonly canEdit: boolean;
  readonly canShare: boolean;
}

export function buildSetRolePagePermissionsInput(
  args: SetRolePagePermissionsArgs,
): { driveId: string; roleId: string; permissionsPatch: Record<string, PagePerm> } {
  const { driveId, roleId, pageId, canView, canEdit, canShare } = args;
  return { driveId, roleId, permissionsPatch: { [pageId]: { canView, canEdit, canShare } } };
}

export interface RemoveRolePagePermissionsArgs {
  readonly driveId: string;
  readonly roleId: string;
  readonly pageId: string;
}

export function buildRemoveRolePagePermissionsInput(
  args: RemoveRolePagePermissionsArgs,
): { driveId: string; roleId: string; permissionsPatch: Record<string, null> } {
  const { driveId, roleId, pageId } = args;
  return { driveId, roleId, permissionsPatch: { [pageId]: null } };
}

export interface SetRoleDriveWidePermissionsArgs {
  readonly driveId: string;
  readonly roleId: string;
  readonly canView: boolean;
  readonly canEdit: boolean;
  readonly canShare: boolean;
}

export function buildSetRoleDriveWidePermissionsInput(
  args: SetRoleDriveWidePermissionsArgs,
): { driveId: string; roleId: string; driveWidePermissions: PagePerm } {
  const { driveId, roleId, canView, canEdit, canShare } = args;
  return { driveId, roleId, driveWidePermissions: { canView, canEdit, canShare } };
}
