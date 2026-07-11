/**
 * Pages domain (Phase 3 task 2) — full pagespace-mcp `page.js` parity plus
 * content editing, which rides the shared `/api/mcp/documents` endpoint (see
 * `documents.ts`). Route-verified against `apps/web/src/app/api/**` on
 * `pu/cli-login`; the Phase 0 inventory (`docs/sdk/operations-inventory.md`
 * §2.2-2.6) is the parity contract, D9/D10 discrepancy resolutions applied
 * at the source (routes, not the old handler).
 *
 * Naming note: Phase 2's seed operation was named `pages.read` for
 * GET `/api/pages/:pageId` (bare page metadata) — that is actually the old
 * `get_page_details` tool, not `read_page`. Renamed here to `pages.details`
 * so `pages.read` (in `documents.ts`) can mean what the tool name says:
 * content read via `/api/mcp/documents`. Nothing downstream (Phase 4-6
 * haven't started) depends on the old name.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

export const pageTypeSchema = z.enum([
  'FOLDER',
  'DOCUMENT',
  'CHANNEL',
  'AI_CHAT',
  'CANVAS',
  'FILE',
  'SHEET',
  'TASK_LIST',
  'CODE',
  'MACHINE',
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

/**
 * `get_page_details` tool parity — GET `/api/pages/:pageId`
 * (`pages/[pageId]/route.ts` GET → `pageService.getPage`, PageWithDetails).
 * `requiredScope: 'drive'` — view access at the inherit/MEMBER level of the
 * page's drive (ADR 0002 Decision 2), the minimum a caller's grant must cover.
 */
export const getPageDetails = defineOperation({
  name: 'pages.details',
  method: 'GET',
  path: '/api/pages/:pageId',
  inputSchema: z.strictObject({ pageId: z.string() }),
  outputSchema: pageWithDetailsSchema,
  requiredScope: 'drive',
  description: 'Get full page details (metadata, children, and chat messages) by id.',
});

/**
 * `list_pages` tool parity — GET `/api/drives/:driveId/pages?ls=true[&parentId=][&recursive=true]`
 * (`drives/[driveId]/pages/route.ts:91`, ls-mode branch). `ls` is always sent
 * (defaulted, not caller-supplied) — the route's non-ls mode returns a full
 * page tree instead and is intentionally not exposed here (inventory §2.2:
 * "the SDK should expose both modes" is a nice-to-have, not tool parity).
 */
export const listPages = defineOperation({
  name: 'pages.list',
  method: 'GET',
  path: '/api/drives/:driveId/pages',
  inputSchema: z.strictObject({
    driveId: z.string(),
    parentId: z.string().optional(),
    recursive: z.boolean().optional(),
    ls: z.literal(true).default(true),
  }),
  outputSchema: z.object({
    mode: z.literal('ls'),
    driveName: z.string(),
    driveSlug: z.string(),
    location: z.string(),
    breadcrumb: z.array(z.object({ id: z.string(), title: z.string() })),
    pages: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        type: pageTypeSchema,
        hasChildren: z.boolean(),
        isTaskLinked: z.boolean(),
      }),
    ),
    count: z.number(),
    totalInDrive: z.number(),
  }),
  requiredScope: 'drive',
  description: 'List pages at a location in a drive (ls-style). Defaults to direct children of the drive root.',
});

const trashedPageNodeSchema: z.ZodType<Record<string, unknown>> = pageDataSchema.extend({
  get children() {
    return z.array(trashedPageNodeSchema);
  },
});

/**
 * `list_trash` tool parity — GET `/api/drives/:driveId/trash`
 * (`drives/[driveId]/trash/route.ts:17`). Owner/admin only — `requiredScope`
 * is the ADMIN floor, not the plain drive-member floor `pages.list` uses.
 * `driveSlug` is a tool-layer nicety the route never reads (inventory §2.2);
 * omitted here.
 */
export const listTrash = defineOperation({
  name: 'pages.listTrash',
  method: 'GET',
  path: '/api/drives/:driveId/trash',
  inputSchema: z.strictObject({ driveId: z.string() }),
  outputSchema: z.array(trashedPageNodeSchema),
  requiredScope: 'drive:admin',
  description: 'List all trashed pages (as a tree) in a drive. Owner/admin only.',
});

/**
 * `create_page` tool parity — POST `/api/pages` (`pages/route.ts:32`).
 * D9 resolution: the type enum is the full creatable set (route accepts
 * FILE, CODE, and admin-gated MACHINE beyond the old tool's narrower list;
 * `packages/lib/src/content/page-types.config.ts:306-308`).
 */
export const createPage = defineOperation({
  name: 'pages.create',
  method: 'POST',
  path: '/api/pages',
  inputSchema: z.strictObject({
    driveId: z.string().min(1),
    title: z.string().min(1),
    type: pageTypeSchema,
    parentId: z.string().nullable().optional(),
    content: z.string().optional(),
    contentMode: z.enum(['html', 'markdown']).optional(),
    systemPrompt: z.string().optional(),
    enabledTools: z.array(z.string()).optional(),
    aiProvider: z.string().optional(),
    aiModel: z.string().optional(),
  }),
  outputSchema: pageDataSchema,
  requiredScope: 'drive',
  description: 'Create a new page in a drive.',
});

/**
 * `rename_page` tool parity — PATCH `/api/pages/:pageId` (`pages/[pageId]/route.ts:62`),
 * sending only `title`. The route accepts a broader update surface
 * (`content`, `aiProvider`, `aiModel`, `parentId`, `isPaginated`, `isPrivate`,
 * `expectedRevision`, `changeGroupId`) that this operation intentionally
 * does not expose — that is a general "update page" capability the old tool
 * set never had, out of scope for tool parity here.
 */
export const renamePage = defineOperation({
  name: 'pages.rename',
  method: 'PATCH',
  path: '/api/pages/:pageId',
  inputSchema: z.strictObject({ pageId: z.string(), title: z.string() }),
  outputSchema: pageDataSchema,
  requiredScope: 'drive',
  description: 'Rename an existing page.',
});

/**
 * `move_page` tool parity — PATCH `/api/pages/reorder` (`pages/reorder/route.ts:20`).
 * D-note: the wire body is `{pageId, newParentId, newPosition}`; the old
 * tool's `position` field is renamed here to match the route's
 * `reorderSchema` exactly (`newParentId` is required, pass `null` for root).
 * Scoped tokens need OWNER/ADMIN on the drive — `requiredScope: 'drive:admin'`.
 */
export const movePage = defineOperation({
  name: 'pages.move',
  method: 'PATCH',
  path: '/api/pages/reorder',
  inputSchema: z.strictObject({
    pageId: z.string(),
    newParentId: z.string().nullable(),
    newPosition: z.number().finite(),
  }),
  outputSchema: z.object({ message: z.string() }),
  requiredScope: 'drive:admin',
  description: 'Move or reorder a page within its drive.',
});

/**
 * `trash_page` tool parity — DELETE `/api/pages/:pageId` (`pages/[pageId]/route.ts:235`).
 * D10 resolution: `trash_children` is REQUIRED (not optional) — the route's
 * own default when the field is omitted is `true`, which silently diverges
 * from the old tool's `withChildren=false` default. Fail closed: the SDK
 * must always send its own explicit value, never rely on the server default.
 */
export const trashPage = defineOperation({
  name: 'pages.trash',
  method: 'DELETE',
  path: '/api/pages/:pageId',
  inputSchema: z.strictObject({ pageId: z.string(), trash_children: z.boolean() }),
  outputSchema: z.object({ message: z.string() }),
  requiredScope: 'drive',
  description: 'Move a page to trash (soft delete).',
});

/**
 * `restore_page` tool parity — POST `/api/pages/:pageId/restore`
 * (`pages/[pageId]/restore/route.ts:86`). Requires the same delete/manage
 * permission as trashing.
 */
export const restorePage = defineOperation({
  name: 'pages.restore',
  method: 'POST',
  path: '/api/pages/:pageId/restore',
  inputSchema: z.strictObject({ pageId: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  requiredScope: 'drive',
  description: 'Restore a trashed page back to its original location.',
});
