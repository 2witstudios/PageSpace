/**
 * Seed operation: `drives.list` (Phase 2 task 5 proof-of-pattern).
 *
 * Route-verified against `apps/web/src/app/api/drives/route.ts` GET
 * (docs/sdk/operations-inventory.md §2.1, parity with MCP tool `list_drives`).
 * Response is a bare array of `DriveWithAccess`
 * (`packages/lib/src/services/drive-service.ts:20`); dates serialize as ISO
 * strings over JSON.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const driveSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string(),
  kind: z.enum(['STANDARD', 'HOME']),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  drivePrompt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isOwned: z.boolean(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
  lastAccessedAt: z.string().nullable(),
  homePageId: z.string().nullable(),
});

export const listDrives = defineOperation({
  name: 'drives.list',
  method: 'GET',
  path: '/api/drives',
  inputSchema: z
    .object({
      includeTrash: z.boolean().optional(),
      tokenScopable: z.boolean().optional(),
    })
    .strict(),
  outputSchema: z.array(driveSchema),
  description: 'List drives the caller can access.',
});

export const createDrive = defineOperation({
  name: 'drives.create',
  method: 'POST',
  path: '/api/drives',
  inputSchema: z.object({ name: z.string().min(1, 'Missing name') }).strict(),
  outputSchema: driveSchema,
  requiredScope: 'account',
  description:
    'Create a new drive (workspace). Scoped MCP tokens cannot create drives (route-enforced 403) — this always requires an account-level grant.',
});

/**
 * Raw `drives` table row (`packages/db/src/schema/core.ts`), route-verified
 * against `apps/web/src/app/api/drives/[driveId]/route.ts` PATCH →
 * `updateDrive` (`drives.$inferSelect`). Deliberately distinct from
 * `driveSchema`: this endpoint never synthesizes `isOwned`/`role`/
 * `lastAccessedAt` the way list/create do.
 */
const driveRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string(),
  kind: z.enum(['STANDARD', 'HOME']),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  drivePrompt: z.string().nullable(),
  publishSubdomain: z.string().nullable(),
  homePageId: z.string().nullable(),
  publishDefaultOgImageUrl: z.string().nullable(),
});

export const renameDrive = defineOperation({
  name: 'drives.rename',
  method: 'PATCH',
  path: '/api/drives/:driveId',
  inputSchema: z.object({ driveId: z.string(), name: z.string() }).strict(),
  outputSchema: driveRowSchema,
  requiredScope: 'drive:admin',
  description: "Rename a drive. Requires owner/admin authority; a drive's Home drive cannot be renamed.",
});

export const updateDriveContext = defineOperation({
  name: 'drives.updateContext',
  method: 'PATCH',
  path: '/api/drives/:driveId',
  inputSchema: z.object({ driveId: z.string(), drivePrompt: z.string().max(10000) }).strict(),
  outputSchema: driveRowSchema,
  requiredScope: 'drive:admin',
  description:
    "Update a drive's AI context prompt. This prompt is loaded into every AI call within the drive, so it directly inflates the token cost of every request there — keep it concise. Requires owner/admin authority.",
});

export const trashDrive = defineOperation({
  name: 'drives.trash',
  method: 'DELETE',
  path: '/api/drives/:driveId',
  inputSchema: z.object({ driveId: z.string(), confirmDriveName: z.string() }).strict(),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive:admin',
  description:
    'Move a drive and all its pages to trash. DELETE is never auto-retried (non-idempotent, per isIdempotentMethod). `confirmDriveName` is a client-side-only guardrail (inventory D11) — the route has no such field and will trash on a bare DELETE — so callers MUST call `assertDriveNameConfirmed(drive.name, confirmDriveName)` before invoking this operation. Requires owner/admin authority; Home drives cannot be trashed.',
});

export const restoreDrive = defineOperation({
  name: 'drives.restore',
  method: 'POST',
  path: '/api/drives/:driveId/restore',
  inputSchema: z.object({ driveId: z.string() }).strict(),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive',
  description:
    'Restore a trashed drive and its pages back to active. OWNER only — an explicit ADMIN-scoped grant is insufficient; only an inherit-scoped principal (acting with its owner\'s authority) can succeed here, so the minimum pre-flightable scope is plain drive access.',
});

export interface ConfirmMismatch {
  readonly actualName: string;
  readonly confirmName: string;
}

export type Result<TValue, TError> = { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

/**
 * D11: `trash_drive`'s `confirmDriveName` guardrail is client-side only —
 * the route (`apps/web/src/app/api/drives/[driveId]/route.ts` DELETE) has no
 * such field and trashes unconditionally. Every caller of `trashDrive`
 * (CLI, MCP adapter) MUST run this first and fail closed on a mismatch.
 * Pure, total, case- and whitespace-sensitive (no fuzzy matching).
 */
export function assertDriveNameConfirmed(actualName: string, confirmName: string): Result<void, ConfirmMismatch> {
  if (actualName === confirmName) {
    return { ok: true, value: undefined };
  }
  return { ok: false, error: { actualName, confirmName } };
}
