/**
 * Collaborators operation: `collaborators.list` (Phase 3 task 1, drives &
 * members domain).
 *
 * Route-verified against `apps/web/src/app/api/connections/route.ts` GET,
 * parity with MCP tool `list_collaborators`
 * (docs/sdk/operations-inventory.md §2.15). Response is `{connections}`, not
 * a bare array — the old handler's `Array.isArray(response) ? response : []`
 * fallback masked this; the SDK fails closed on the bare-array shape instead
 * of silently accepting it. `status` defaults server-side to `ACCEPTED` when
 * omitted (`connections/route.ts:26`).
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const connectionStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'BLOCKED']);

const connectionUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

const connectionSchema = z.object({
  id: z.string(),
  status: connectionStatusSchema,
  requestedAt: z.string(),
  acceptedAt: z.string().nullable(),
  requestMessage: z.string().nullable(),
  user1Id: z.string(),
  user2Id: z.string(),
  requestedBy: z.string(),
  user: connectionUserSchema,
  isRequester: z.boolean(),
});

export const listCollaborators = defineOperation({
  name: 'collaborators.list',
  method: 'GET',
  path: '/api/connections',
  inputSchema: z.object({ status: connectionStatusSchema.optional() }).strict(),
  outputSchema: z.object({ connections: z.array(connectionSchema) }),
  description: "List the caller's connections (collaborators). Defaults to ACCEPTED status server-side when omitted.",
});
