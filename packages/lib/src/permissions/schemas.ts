import { z } from 'zod';
import { isCuid } from '@paralleldrive/cuid2';

/**
 * Permission mutation input schemas
 *
 * Pure, synchronous validation - no I/O.
 * Validates structure/format only.
 * Business rules live in function bodies.
 */

/**
 * Schema for CUID2 identifiers used throughout the database.
 * Uses the official isCuid validator from @paralleldrive/cuid2.
 */
export const IdSchema = z.string().refine(isCuid, {
  message: 'Invalid ID format (expected CUID2)',
});

export const PermissionFlagsSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canDelete: z.boolean(),
});

export type PermissionFlags = z.infer<typeof PermissionFlagsSchema>;

export const GrantInputSchema = z.object({
  pageId: IdSchema,
  targetUserId: IdSchema,
  permissions: PermissionFlagsSchema,
});

export type GrantInput = z.infer<typeof GrantInputSchema>;

export const RevokeInputSchema = z.object({
  pageId: IdSchema,
  targetUserId: IdSchema,
});

export type RevokeInput = z.infer<typeof RevokeInputSchema>;
