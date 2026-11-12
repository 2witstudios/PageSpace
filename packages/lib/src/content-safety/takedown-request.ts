/**
 * The request and response shapes for a content takedown — one definition,
 * validated by the admin route that receives it and again by the web route
 * that executes it.
 */

import { z } from 'zod';
import type { ContentCaseStatus } from '@pagespace/db/schema/content-safety';
import type { TakedownHaltReason } from './takedown-plan';

const reason = z.string().trim().min(1, 'A reason is required').max(1000);
const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid ID');
const contentHash = z.string().trim().regex(/^[0-9a-fA-F]{64}$/, 'Invalid content hash');
const category = z.enum(['csam', 'malware', 'illegal_other', 'policy']);

export const takedownRequestSchema = z.discriminatedUnion('action', [
  // Purge a hash for every tenant. Never `policy`.
  z
    .object({
      action: z.literal('global'),
      contentHash,
      category: z.enum(['csam', 'malware', 'illegal_other']),
      reason,
      skipPreservation: z.boolean().optional(),
      skipPreservationReason: z.string().trim().min(1).max(1000).optional(),
      suspendUploader: z.boolean().optional(),
    })
    .refine((value) => !value.skipPreservation || Boolean(value.skipPreservationReason), {
      message: 'A reason is required to skip preservation',
      path: ['skipPreservationReason'],
    })
    .refine((value) => !(value.skipPreservation && value.category === 'csam'), {
      message: 'Preservation cannot be skipped for CSAM',
      path: ['skipPreservation'],
    }),
  // Scoped: one page off the web; other tenants' identical bytes untouched.
  z.object({ action: z.literal('unpublish_page'), pageId: id, category, reason }),
  // Scoped: every published site of a drive parked and held.
  z.object({ action: z.literal('park_drive'), driveId: id, category, reason }),
  // Lift the hold ONE drive-parking case placed. The drive stays parked while any other hold remains.
  z.object({ action: z.literal('restore_drive'), caseId: id, reason }),
  z.object({ action: z.literal('avatar'), userId: id, category, reason }),
  // Used by the suspend action's "also unpublish this user's published sites".
  z.object({ action: z.literal('park_user_sites'), userId: id, reason }),
  z.object({ action: z.literal('restore_user_sites'), userId: id }),
  // Continue a case that stopped part-way.
  z.object({ action: z.literal('resume'), caseId: id }),
  // Pass over storage again for a finished global takedown.
  z.object({ action: z.literal('resweep'), caseId: id }),
]);

export type TakedownRequest = z.infer<typeof takedownRequestSchema>;

/** What every takedown action answers with. IDs and counts only. */
export interface TakedownResponse {
  action: TakedownRequest['action'];
  caseId?: string;
  status?: ContentCaseStatus;
  failedStep?: string;
  error?: string;
  haltReason?: TakedownHaltReason;
  /** Another run of the case was already under way, so this request changed nothing. Ask again once it is done. */
  inProgress?: boolean;
  /** `park_user_sites`: what was parked and what was left for an admin to decide. */
  parkedDriveIds?: string[];
  skippedDrives?: Array<{ driveId: string; reason: string }>;
  restoredDriveIds?: string[];
  /** `restore_*`: drives whose hold was lifted but which another hold still keeps parked. */
  stillHeldDriveIds?: string[];
}
