import { z } from 'zod';

/**
 * Permission mutation input schemas
 *
 * Pure, synchronous validation - no I/O.
 * Validates structure/format only.
 * Business rules live in function bodies.
 */

export const UuidSchema = z.string().uuid();

export const PermissionFlagsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
});

export type PermissionFlags = z.infer<typeof PermissionFlagsSchema>;

export const GrantInputSchema = z.object({
  pageId: UuidSchema,
  targetUserId: UuidSchema,
  permissions: PermissionFlagsSchema,
});

export type GrantInput = z.infer<typeof GrantInputSchema>;

export const RevokeInputSchema = z.object({
  pageId: UuidSchema,
  targetUserId: UuidSchema,
});

export type RevokeInput = z.infer<typeof RevokeInputSchema>;
