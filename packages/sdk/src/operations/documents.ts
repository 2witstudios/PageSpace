/**
 * Content editing (Phase 3 task 2) — the pagespace-mcp `document.js` +
 * `page.js` sheet-editing tools (`read_page`, `replace_lines`, `insert_lines`,
 * `delete_lines`, `edit_sheet_cells`), all five riding one wire endpoint:
 * POST `/api/mcp/documents` (`apps/web/src/app/api/mcp/documents/route.ts`),
 * dispatched by an `operation` field. Each is modeled as its own `Operation`
 * (same method/path, different input/output schema) because the response
 * shape is entirely different per `operation` value — mirrors the old
 * tool-per-operation split even though the wire endpoint is shared.
 *
 * #1760-62 fix (route-verified, `route.ts:230-232`): `read` and `replace`
 * (and, by the same code path, `insert`/`delete`) serialize page content via
 * `serializePageContentForAI`, not raw `page.content` — CODE pages and
 * markdown-mode pages keep their natural line structure, HTML documents are
 * normalized. Line numbers the SDK reports must agree with this corrected
 * line model, which is exactly what the route itself computes.
 *
 * All five operations are POST — already excluded from the client's
 * idempotent-retry path by `isIdempotentMethod` (method-based), so there is
 * no separate "non-idempotent" flag to thread through the registry.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

const DOCUMENTS_PATH = '/api/mcp/documents';

const fileMetadataSchema = z.object({
  mimeType: z.string().nullable(),
  fileSize: z.number().nullable(),
  originalFileName: z.string().nullable(),
  processingStatus: z.string().nullable(),
  extractionMethod: z.string().nullable().optional(),
  extractionMetadata: z.unknown().nullable().optional(),
});

const taskAssigneeSchema = z.object({
  userId: z.string().nullable(),
  agentPageId: z.string().nullable(),
  user: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  agentPage: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

const taskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
  assigneeId: z.string().nullable(),
  assigneeAgentId: z.string().nullable(),
  dueDate: z.string().nullable(),
  position: z.number(),
  completedAt: z.string().nullable(),
  pageId: z.string().nullable(),
  assignee: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable(),
  assigneeAgent: z.object({ id: z.string(), title: z.string().nullable(), type: z.string() }).nullable(),
  assignees: z.array(taskAssigneeSchema),
  hasContent: z.boolean(),
  subTaskCount: z.number(),
  subTaskCompletedCount: z.number(),
});

/**
 * Non-TASK_LIST, non-CHANNEL, non-in-progress-FILE pages (the generic text
 * path, `route.ts:521-559`). `pageType` is required-absent (`z.undefined()`)
 * so a TASK_LIST/CHANNEL/FILE-status response — which all set a literal
 * `pageType` string — can never silently parse (and strip its extra fields)
 * against this branch instead of its own.
 */
const genericReadResultSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string().nullable(),
  pageType: z.undefined(),
  totalLines: z.number(),
  numberedLines: z.array(z.string()),
  content: z.string(),
  fileMetadata: fileMetadataSchema.optional(),
  rangeStart: z.number().optional(),
  rangeEnd: z.number().optional(),
  rangeMessage: z.string().optional(),
});

/** CHANNEL pages (`route.ts:399-474`) — transcript lines address message index, not text lines. */
const channelReadResultSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string().nullable(),
  pageType: z.literal('CHANNEL'),
  totalLines: z.number(),
  numberedLines: z.array(z.string()),
  content: z.string(),
  messageCount: z.number(),
  totalMessages: z.number(),
  rangeStart: z.number().optional(),
  rangeEnd: z.number().optional(),
  rangeMessage: z.string().optional(),
});

/**
 * FILE pages not yet in `completed` status (`route.ts:480-518`) — one shape
 * covers all four `status` values; the fields that apply vary by status
 * (pending/processing: `error`+`suggestion`; failed: adds `processingError`;
 * visual: `message`+`fileMetadata` instead of `error`).
 */
const fileStatusReadResultSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string().nullable(),
  pageType: z.literal('FILE'),
  status: z.enum(['pending', 'processing', 'failed', 'visual']),
  error: z.string().optional(),
  suggestion: z.string().optional(),
  processingError: z.string().nullable().optional(),
  message: z.string().optional(),
  fileMetadata: z
    .object({
      mimeType: z.string().nullable(),
      fileSize: z.number().nullable(),
      originalFileName: z.string().nullable(),
      processingStatus: z.string().nullable(),
    })
    .optional(),
});

/** TASK_LIST pages (`route.ts:238-383`) — the coding-harness hot path; every extra field is load-bearing. */
const taskListReadResultSchema = z.object({
  pageId: z.string(),
  pageTitle: z.string().nullable(),
  pageType: z.literal('TASK_LIST'),
  taskListId: z.string(),
  parentTaskList: z.object({ pageId: z.string(), title: z.string().nullable(), taskListId: z.string() }).nullable(),
  totalLines: z.number(),
  numberedLines: z.array(z.string()),
  content: z.string(),
  tasks: z.array(taskItemSchema),
  availableStatuses: z.array(
    z.object({
      slug: z.string(),
      label: z.string(),
      group: z.string(),
      position: z.number(),
      color: z.string().nullable().optional(),
    }),
  ),
  progress: z.object({
    total: z.number(),
    percentage: z.number(),
    byGroup: z.record(z.string(), z.number()),
    bySlug: z.record(z.string(), z.number()),
  }),
});

const readResultSchema = z.union([
  taskListReadResultSchema,
  channelReadResultSchema,
  fileStatusReadResultSchema,
  genericReadResultSchema,
]);

/**
 * `read_page` tool parity — POST `/api/mcp/documents` `{operation:'read', pageId, startLine?, endLine?}`
 * (`mcp/documents/route.ts:85`, see module docs for the #1760-62 line-model fix).
 * Output is a discriminated union on `pageType` (TASK_LIST/CHANNEL/FILE-status
 * vs. the generic text path, which has no `pageType` at all) rather than
 * optional-soup — per this domain's spec, a skipped variant here is a parity
 * gap, not a schema nicety.
 */
export const readDocument = defineOperation({
  name: 'pages.read',
  method: 'POST',
  path: DOCUMENTS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('read').default('read'),
    pageId: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
    .refine((v) => v.startLine === undefined || v.endLine === undefined || v.endLine >= v.startLine, {
      message: 'endLine must be >= startLine',
      path: ['endLine'],
    }),
  outputSchema: readResultSchema,
  requiredScope: 'drive',
  description: 'Read a page (or a line/message range of it). Response shape varies by page type.',
});

/**
 * `replace_lines` tool parity — POST `/api/mcp/documents` `{operation:'replace', pageId, startLine, endLine?, content}`
 * (`mcp/documents/route.ts:562-624`). 1-based, `endLine >= startLine` when
 * both given (zod-refined, fail closed rather than trusting the route's own
 * 400 on out-of-order ranges). Out-of-range lines → 400; revision conflict →
 * 409/428 — both surface as typed errors via the transport's generic
 * non-2xx classification, no special-casing needed here.
 */
export const replaceLines = defineOperation({
  name: 'pages.replaceLines',
  method: 'POST',
  path: DOCUMENTS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('replace').default('replace'),
    pageId: z.string(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1).optional(),
    content: z.string(),
  })
    .refine((v) => v.endLine === undefined || v.endLine >= v.startLine, {
      message: 'endLine must be >= startLine',
      path: ['endLine'],
    }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    totalLines: z.number(),
    numberedLines: z.array(z.string()),
    operation: z.literal('replace'),
    affectedLines: z.string(),
  }),
  requiredScope: 'drive',
  description: 'Replace line(s) startLine..endLine with new content.',
});

/**
 * `insert_lines` tool parity — POST `/api/mcp/documents` `{operation:'insert', pageId, startLine, content}`
 * (`mcp/documents/route.ts:626-684`). No `endLine` — insertion is a single
 * point, existing lines at/after `startLine` shift down.
 */
export const insertLines = defineOperation({
  name: 'pages.insertLines',
  method: 'POST',
  path: DOCUMENTS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('insert').default('insert'),
    pageId: z.string(),
    startLine: z.number().int().min(1),
    content: z.string(),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    totalLines: z.number(),
    numberedLines: z.array(z.string()),
    operation: z.literal('insert'),
    insertedAt: z.number(),
  }),
  requiredScope: 'drive',
  description: 'Insert content before startLine, shifting existing lines down.',
});

/**
 * `delete_lines` tool parity — POST `/api/mcp/documents` `{operation:'delete', pageId, startLine, endLine?}`
 * (`mcp/documents/route.ts:686-747`). Same 1-based, `endLine >= startLine` refinement as replace.
 */
export const deleteLines = defineOperation({
  name: 'pages.deleteLines',
  method: 'POST',
  path: DOCUMENTS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('delete').default('delete'),
    pageId: z.string(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1).optional(),
  })
    .refine((v) => v.endLine === undefined || v.endLine >= v.startLine, {
      message: 'endLine must be >= startLine',
      path: ['endLine'],
    }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    totalLines: z.number(),
    numberedLines: z.array(z.string()),
    operation: z.literal('delete'),
    deletedLines: z.string(),
  }),
  requiredScope: 'drive',
  description: 'Delete line(s) startLine..endLine.',
});

/** Mirrors `packages/lib/src/sheets/address.ts` `isValidCellAddress` — one or more letters, then digits, case-insensitive. */
const cellAddressPattern = /^[A-Za-z]+[0-9]+$/;

/**
 * `edit_sheet_cells` tool parity — POST `/api/mcp/documents` `{operation:'edit-cells', pageId, cells}`
 * (`mcp/documents/route.ts:749-840`). Cell addresses are validated client-side
 * (fail closed, same posture as the D11 `confirmDriveName` guard) against the
 * same A1 pattern the route enforces server-side, so malformed input never
 * reaches the network.
 */
export const editSheetCells = defineOperation({
  name: 'pages.editCells',
  method: 'POST',
  path: DOCUMENTS_PATH,
  inputSchema: z.strictObject({
    operation: z.literal('edit-cells').default('edit-cells'),
    pageId: z.string(),
    cells: z
      .array(
        z.object({
          address: z.string().trim().regex(cellAddressPattern, 'Invalid A1-style cell address'),
          value: z.string(),
        }),
      )
      .min(1),
  }),
  outputSchema: z.object({
    pageId: z.string(),
    pageTitle: z.string().nullable(),
    cellsUpdated: z.number(),
    operation: z.literal('edit-cells'),
    stats: z.object({
      valuesSet: z.number(),
      formulasSet: z.number(),
      cellsCleared: z.number(),
      sheetDimensions: z.object({ rows: z.number(), columns: z.number() }),
    }),
    updatedCells: z.array(
      z.object({
        address: z.string(),
        type: z.enum(['cleared', 'formula', 'value']),
      }),
    ),
  }),
  requiredScope: 'drive',
  description: 'Edit cells in a SHEET page using A1-style addressing. Supports formulas.',
});
