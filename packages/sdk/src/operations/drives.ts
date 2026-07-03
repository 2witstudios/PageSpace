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
  inputSchema: z.object({
    includeTrash: z.boolean().optional(),
    tokenScopable: z.boolean().optional(),
  }),
  outputSchema: z.array(driveSchema),
  description: 'List drives the caller can access.',
});
