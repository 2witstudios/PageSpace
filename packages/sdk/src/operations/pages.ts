/**
 * Seed operation: `pages.read` (Phase 2 task 5 proof-of-pattern).
 *
 * Route-verified against `apps/web/src/app/api/pages/[pageId]/route.ts` GET
 * → `pageService.getPage` (docs/sdk/operations-inventory.md §2.3, parity with
 * MCP tool `get_page_details`). Response is a bare `PageWithDetails`
 * (`apps/web/src/services/api/page-service.ts:133,158`); dates serialize as
 * ISO strings over JSON. `requiredScope: 'drive'` — view access is granted
 * at the inherit/MEMBER level of the page's drive (ADR 0002 Decision 2), the
 * minimum a caller's grant must cover.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const pageTypeSchema = z.enum([
  'FOLDER',
  'DOCUMENT',
  'CHANNEL',
  'AI_CHAT',
  'CANVAS',
  'SHEET',
  'TASK_LIST',
  'CODE',
  'TERMINAL',
]);

const pageDataSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: pageTypeSchema,
  content: z.string().nullable(),
  contentMode: z.enum(['html', 'markdown']),
  parentId: z.string().nullable(),
  driveId: z.string(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number(),
  stateHash: z.string().nullable(),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  aiProvider: z.string().nullable(),
  aiModel: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  enabledTools: z.array(z.string()).nullable(),
  isPaginated: z.boolean().nullable(),
});

const messageWithUserSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  user: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
});

const pageWithDetailsSchema = pageDataSchema.extend({
  children: z.array(pageDataSchema),
  messages: z.array(messageWithUserSchema),
});

export const readPage = defineOperation({
  name: 'pages.read',
  method: 'GET',
  path: '/api/pages/:pageId',
  inputSchema: z.object({ pageId: z.string() }),
  outputSchema: pageWithDetailsSchema,
  requiredScope: 'drive',
  description: 'Get full page details (metadata, children, and chat messages) by id.',
});
