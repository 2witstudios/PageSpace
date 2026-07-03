/**
 * Activity feed operations (Phase 3 task 9, part 2/2 — old handler's
 * activity feed, actually served by `apps/web/src/app/api/activities/route.ts`,
 * not `conversation.js`). Old MCP tool: `get_activity`. Channel-messaging
 * operations from the same old handler file belong to `channels.ts`.
 *
 * DISCREPANCY (Phase 0 inventory D1, binding — routes are the contract, never
 * a handler-side workaround): `tools.js` describes `get_activity` as POSTing
 * a JSON body with a `types[]` filter to `/api/activities`; the route exports
 * **GET only** and has no `types` param (`activities/route.ts:39,14-26`) — the
 * old tool 405s on every call. This operation implements the route's real
 * contract: GET with query params `context` ('user' default, no driveId
 * required)/`driveId`/`pageId`/`startDate`/`endDate`/`actorId`/`operation`/
 * `resourceType`/`limit` (1-100, default 50)/`offset` (>=0, default 0).
 * `operation` + `resourceType` are the route's real nearest equivalents to
 * the dropped `types` filter.
 *
 * Output is the bare `activity_logs` row (`packages/db/src/schema/monitoring.ts`)
 * plus a denormalized `user` relation, route-serialized as-is (Date -> ISO
 * string) — including internal hash-chain and GDPR Art 30 processing fields
 * the route does not strip. No `z.any()`: `previousValues`/`newValues`/
 * `metadata` are `z.record(z.string(), z.unknown())` — genuinely arbitrary
 * per-operation payloads, same idiom as `tasks.ts`'s task `metadata` field.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** Same strict ISO 8601 pattern as `calendar.ts`'s `isoDatetimeSchema` — the route's `z.coerce.date()` accepts it verbatim. */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const isoDatetimeSchema = z.string().refine(
  (value) => ISO_8601_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime()),
  {
    message:
      'Must be a strict ISO 8601 date or datetime string (e.g. "2026-02-19", "2026-02-19T19:00:00", or "2026-02-19T19:00:00Z")',
  },
);

/** `activityResourceEnum` (`packages/db/src/schema/monitoring.ts`). */
const activityResourceTypeSchema = z.enum([
  'page',
  'drive',
  'permission',
  'agent',
  'user',
  'member',
  'role',
  'file',
  'token',
  'device',
  'message',
  'conversation',
]);

const activityActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

/** Bare `activity_logs` row (route: `db.query.activityLogs.findMany` with no `columns` restriction — every column crosses the wire). */
const activityLogEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  userId: z.string().nullable(),
  actorEmail: z.string(),
  actorDisplayName: z.string().nullable(),
  isAiGenerated: z.boolean(),
  aiProvider: z.string().nullable(),
  aiModel: z.string().nullable(),
  aiConversationId: z.string().nullable(),
  operation: z.string(),
  resourceType: activityResourceTypeSchema,
  resourceId: z.string(),
  resourceTitle: z.string().nullable(),
  driveId: z.string().nullable(),
  pageId: z.string().nullable(),
  contentSnapshot: z.string().nullable(),
  contentFormat: z.enum(['text', 'html', 'json', 'tiptap']).nullable(),
  contentRef: z.string().nullable(),
  contentSize: z.number().nullable(),
  rollbackFromActivityId: z.string().nullable(),
  rollbackSourceOperation: z.string().nullable(),
  rollbackSourceTimestamp: z.string().nullable(),
  rollbackSourceTitle: z.string().nullable(),
  updatedFields: z.array(z.string()).nullable(),
  previousValues: z.record(z.string(), z.unknown()).nullable(),
  newValues: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  streamId: z.string().nullable(),
  streamSeq: z.number().nullable(),
  changeGroupId: z.string().nullable(),
  changeGroupType: z.enum(['user', 'ai', 'automation', 'system']).nullable(),
  stateHashBefore: z.string().nullable(),
  stateHashAfter: z.string().nullable(),
  dataCategory: z.string().nullable(),
  legalBasis: z.string().nullable(),
  retentionPolicy: z.string().nullable(),
  recipients: z.array(z.string()).nullable(),
  isArchived: z.boolean(),
  chainSeq: z.number(),
  previousLogHash: z.string().nullable(),
  logHash: z.string().nullable(),
  chainSeed: z.string().nullable(),
  // Nullable: `userId` is `onDelete: 'set null'` — a deleted actor's rows survive for audit-trail preservation.
  user: activityActorSchema.nullable(),
});

const getActivityOutputSchema = z.object({
  activities: z.array(activityLogEntrySchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// activity.get — GET /api/activities (D1)
// ---------------------------------------------------------------------------

export const getActivity = defineOperation({
  name: 'activity.get',
  method: 'GET',
  path: '/api/activities',
  inputSchema: z.object({
    context: z.enum(['user', 'drive', 'page']).optional(),
    driveId: z.string().optional(),
    pageId: z.string().optional(),
    startDate: isoDatetimeSchema.optional(),
    endDate: isoDatetimeSchema.optional(),
    // actorId is ignored by the route in 'user' context (already scoped to the caller).
    actorId: z.string().optional(),
    operation: z.string().optional(),
    resourceType: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  outputSchema: getActivityOutputSchema,
  // No fixed driveId path param — `context: 'user'` (the default) scopes to
  // whatever drives the caller's own principal/token can already reach, same
  // rationale as `search.multiDrive` and `agents.listMultiDrive`.
  description:
    "Fetch the activity feed (D1: GET, not the old tool's POST — that 405s on every call). `context` selects scope: \"user\" (default, the caller's own activity, optionally driveId-filtered), \"drive\" (requires driveId), or \"page\" (requires pageId). `operation`/`resourceType` are the route's real filters — there is no `types[]` filter.",
});
