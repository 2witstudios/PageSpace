/** Request bodies for /api/orgs routes, validated at the boundary. */
import { z } from 'zod/v4';
import { ORG_SLUG_PATTERN } from './org-slug';

const orgName = z.string().trim().min(1).max(100);
// Lowercase letters, digits and inner hyphens; it becomes part of org URLs.
const orgSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ORG_SLUG_PATTERN, 'Use 1-48 lowercase letters, digits or hyphens');
// ORG-1: no avatar here. An org avatar is an image uploaded to POST /api/orgs/[orgId]/avatar and
// served by PageSpace, never a URL. Strict, so a client still sending `avatarUrl` is refused, not ignored.
export const orgCreateSchema = z.strictObject({
  name: orgName,
  slug: orgSlug,
});

export const orgUpdateSchema = z
  .strictObject({ name: orgName.optional(), slug: orgSlug.optional() })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

// The Owner role is never granted by invite or role change; only by transfer.
export const invitableRole = z.enum(['ADMIN', 'MEMBER']);

export const memberRoleUpdateSchema = z.object({ role: invitableRole });

export const inviteCreateSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: invitableRole.default('MEMBER'),
});

export const inviteAcceptSchema = z.object({ token: z.string().min(1).max(256) });

export const transferOwnershipSchema = z.object({ toUserId: z.string().min(1) });

export const orgDeleteSchema = z.object({
  drives: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ driveId: z.string().min(1), action: z.literal('transfer'), toUserId: z.string().min(1) }),
        z.object({ driveId: z.string().min(1), action: z.literal('trash') }),
      ]),
    )
    .max(5000)
    .default([]),
});

// SEC-1: the domain is normalized and judged in lib (normalizeDomain); this only bounds the input.
export const domainAddSchema = z.object({ domain: z.string().trim().min(1).max(253) });

export const domainVerifySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('dns') }),
  z.object({ method: z.literal('email'), mailbox: z.enum(['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster']) }),
]);

export const domainProofConfirmSchema = z.object({ token: z.string().min(1).max(256) });

// [D-OW-27] The address an Admin types to clear a departed member's suppression; never stored or echoed.
export const suppressionClearSchema = z.object({ email: z.string().trim().pipe(z.email().max(254)) });
