/**
 * Uploads domain — the three JSON legs of PageSpace's direct-to-storage
 * upload, route-verified against `apps/web/src/app/api/upload/{presign,complete,cancel}/route.ts`.
 *
 * WHY THESE ARE THREE OPERATIONS AND NOT ONE: the middle leg of an upload is a
 * binary `PUT` to object storage on a foreign host, which is not a PageSpace
 * API call and cannot travel through this SDK's transport at all — its
 * `RequestDescriptor.body` is `string | undefined` and `parseResponse` reads
 * JSON or text. So the registry models only the two ends plus the failure
 * release, and `uploads/upload-file.ts` composes them around a raw `fetch`.
 *
 * Auth note: both ends declare `{ allow: ['session','mcp'], requireCSRF: true }`
 * server-side, but the origin and CSRF checks are gated on `isSessionAuth`
 * (`apps/web/src/lib/auth/index.ts`), so a Bearer token never reaches them —
 * `requireCSRF` does not lock machine callers out. A drive-scoped token is its
 * own drive member: both routes authorize it through
 * `getAppDriveAccessLevel(tokenId, driveId).canEdit`, the TOKEN's role rather
 * than the owning user's access.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/**
 * The page row `uploads.complete` returns. Narrower than the server's full
 * row on purpose: the columns a caller needs to render or address the new
 * FILE page, plus the file-specific metadata that makes the upload verifiable
 * (`contentHash`, `processingStatus`). Extra server columns are stripped by
 * zod rather than pinned here, so a new column on `pages` is not a breaking
 * change for this operation.
 */
const uploadedFilePageSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: z.literal('FILE'),
  driveId: z.string(),
  parentId: z.string().nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isTrashed: z.boolean(),
  /** `real` column — a number, and null on non-file pages. */
  fileSize: z.number().nullable(),
  mimeType: z.string().nullable(),
  originalFileName: z.string().nullable(),
  contentHash: z.string().nullable(),
  /** `pending` at creation; the processor advances it (`completed`, `visual`, `failed`). */
  processingStatus: z.string().nullable(),
});

export type UploadedFilePage = z.infer<typeof uploadedFilePageSchema>;

/**
 * Presign's two mutually exclusive successes.
 *
 * `alreadyExists` is NOT a failure and NOT a no-op: storage is a global
 * content-addressed namespace, so when the caller already references these
 * exact bytes the server skips the proof-of-possession PUT — but it still
 * reserves a slot and still expects `uploads.complete`, which is what creates
 * the page. Treating this branch as "nothing to do" silently skips page
 * creation, which is why the two shapes are modelled explicitly instead of as
 * one schema with an optional `url`.
 *
 * The third outcome — bytes that exist globally but which this caller has
 * never referenced — is not in this union at all. That is the cross-tenant
 * claim guard and arrives as a 409, classified by the transport as an
 * `HttpError` before any of this is parsed.
 */
const presignFastPathSchema = z.object({
  alreadyExists: z.literal(true),
  jobId: z.string(),
  key: z.string(),
});

const presignPutTargetSchema = z.object({
  /** Time-limited signed PUT target. The signature covers `Content-Type` and `Content-Length`. */
  url: z.string(),
  jobId: z.string(),
  key: z.string(),
  expiresAt: z.string(),
});

const presignResultSchema = z.union([presignFastPathSchema, presignPutTargetSchema]);

export type PresignFastPath = z.infer<typeof presignFastPathSchema>;
export type PresignPutTarget = z.infer<typeof presignPutTargetSchema>;
export type PresignResult = z.infer<typeof presignResultSchema>;

/** Narrows presign's union to the branch that still needs bytes sent. */
export function needsUpload(result: PresignResult): result is PresignPutTarget {
  return 'url' in result;
}

/**
 * Reserve an upload slot and, unless the bytes are already ours, a signed PUT
 * target — POST `/api/upload/presign`.
 *
 * `contentHash` is the lowercase-hex SHA-256 of the exact bytes to be sent;
 * the server canonicalizes and then binds it, along with `driveId`,
 * `fileSize` and `mimeType`, to the returned `jobId`. `uploads.complete` reads
 * those four from that reservation and ignores whatever a later request claims,
 * so a verified `jobId` cannot be replayed against a different drive or file.
 */
export const presignUpload = defineOperation({
  name: 'uploads.presign',
  method: 'POST',
  path: '/api/upload/presign',
  inputSchema: z.strictObject({
    /** Lowercase-hex SHA-256 of the bytes. Must match what is actually PUT. */
    contentHash: z.string(),
    driveId: z.string(),
    filename: z.string(),
    /** Declared media type. Must be sent verbatim as the PUT's `Content-Type`. */
    mimeType: z.string(),
    fileSize: z.number(),
  }),
  outputSchema: presignResultSchema,
  requiredScope: 'drive',
  description:
    'Reserve an upload slot for a file and get a signed PUT target, or the already-exists fast path when the caller already references these bytes.',
});

/**
 * Turn a reserved slot into a FILE page — POST `/api/upload/complete`.
 *
 * This is the call that creates the page, on BOTH presign branches. The server
 * re-checks that the object is actually present in storage first, so calling
 * this without having sent the bytes fails rather than leaving a page pointing
 * at nothing.
 */
export const completeUpload = defineOperation({
  name: 'uploads.complete',
  method: 'POST',
  path: '/api/upload/complete',
  inputSchema: z.strictObject({
    /** From `uploads.presign`. Carries the server-trusted hash, drive, size and MIME type. */
    jobId: z.string(),
    title: z.string(),
    parentId: z.string().nullish(),
    /** Drop the new page before or after `afterNodeId`. Omitted appends at the end. */
    position: z.enum(['before', 'after']).nullish(),
    afterNodeId: z.string().nullish(),
  }),
  outputSchema: z.object({
    success: z.literal(true),
    page: uploadedFilePageSchema,
  }),
  requiredScope: 'drive',
  description: 'Finalize a presigned upload, creating the FILE page for the stored object.',
});

/**
 * Release a reserved slot after a failed upload — POST `/api/upload/cancel`.
 *
 * Not destructive in the `--yes` sense: it discards a reservation, never a
 * stored file or a page. Skipping it merely leaks the slot against the
 * caller's concurrent-upload limit until the server's stale-slot sweep, so
 * every abandoned presign should call it.
 */
export const cancelUpload = defineOperation({
  name: 'uploads.cancel',
  method: 'POST',
  path: '/api/upload/cancel',
  inputSchema: z.strictObject({ jobId: z.string() }),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive',
  description: 'Release an upload slot reserved by a presign whose upload will not complete.',
});
