/** Request bodies for /api/orgs routes, validated at the boundary. */
import { z } from 'zod/v4';

const orgName = z.string().trim().min(1).max(100);
// Lowercase letters, digits and inner hyphens; it becomes part of org URLs.
const orgSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, 'Use 1-48 lowercase letters, digits or hyphens');
// https only: the avatar is rendered as an image source, so no javascript:, data: or plain http.
const avatarUrl = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(2048).nullable();

export const orgCreateSchema = z.object({
  name: orgName,
  slug: orgSlug,
  avatarUrl: avatarUrl.optional(),
});

export const orgUpdateSchema = z
  .object({ name: orgName.optional(), slug: orgSlug.optional(), avatarUrl: avatarUrl.optional() })
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
