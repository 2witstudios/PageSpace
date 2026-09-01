/**
 * `uploadFile` — the whole direct-to-storage upload as one call.
 *
 * The upload is three legs and only two of them are PageSpace API calls:
 *
 *   uploads.presign  ->  PUT bytes to object storage  ->  uploads.complete
 *
 * The middle leg is a binary request to a foreign host, so it deliberately
 * does NOT go through the SDK transport (whose body is `string | undefined`
 * and whose response parser reads JSON or text). It is a plain `fetch` here,
 * which is why this module exists at all rather than the whole thing being a
 * single operation in the registry.
 *
 * Two server behaviours callers get wrong, both handled here:
 *
 *  - **The already-exists branch still has to complete.** Storage is a global
 *    content-addressed namespace, so when the caller already references these
 *    exact bytes the server skips the proof-of-possession PUT. It still
 *    reserved a slot, and `uploads.complete` is still what creates the page.
 *    Treating that branch as "nothing to do" silently produces no page.
 *  - **A reserved slot must be released.** Every path that fails after presign
 *    calls `uploads.cancel`, or the slot counts against the caller's
 *    concurrent-upload limit until the server's stale-slot sweep.
 */
import type { z } from 'zod';
import type { Operation } from '../registry/define.js';
import {
  cancelUpload,
  completeUpload,
  needsUpload,
  presignUpload,
  type UploadedFilePage,
} from '../operations/uploads.js';

/**
 * The single client capability this needs. Structural rather than the whole
 * `PageSpaceClient` so the function is trivially testable with a stub, and so
 * it works against a client built before `uploads` was wired into the facade.
 */
export interface OperationInvoker {
  invoke<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
    op: Operation<string, TInputSchema, TOutputSchema>,
    input: z.infer<TInputSchema>,
  ): Promise<z.infer<TOutputSchema>>;
}

/** Bytes in any of the shapes a caller is likely to already be holding. */
export type UploadBytes = Uint8Array | ArrayBuffer | Blob;

export interface UploadFileInput {
  readonly driveId: string;
  readonly bytes: UploadBytes;
  /** Original file name, used for the storage record and as the default page title. */
  readonly filename: string;
  /** Declared media type. Sent verbatim as the PUT's `Content-Type` — see `uploadBytes`. */
  readonly mimeType: string;
  /** Page title. Defaults to `filename`. */
  readonly title?: string;
  readonly parentId?: string | null;
  /** Drop the new page before or after `afterNodeId`. Omitted appends at the end. */
  readonly position?: 'before' | 'after' | null;
  readonly afterNodeId?: string | null;
}

export interface UploadFileOptions {
  /** Injected for tests and non-global-fetch runtimes. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

export interface UploadFileResult {
  readonly page: UploadedFilePage;
  readonly contentHash: string;
  /**
   * True when the server took the dedup fast path and no bytes were sent.
   * The page was still created.
   */
  readonly deduplicated: boolean;
}

/** Raised when object storage rejects the bytes. Carries the storage status, not a PageSpace one. */
export class StorageUploadError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Storage rejected the upload with status ${status}`);
    this.name = 'StorageUploadError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

async function toBytes(input: UploadBytes): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

/**
 * Lowercase-hex SHA-256, the content address the server canonicalizes and
 * binds to the reservation. Uses WebCrypto rather than a Node import so the
 * SDK stays dependency-free and runs unchanged in browsers, Node and Bun.
 */
export async function computeContentHash(input: UploadBytes): Promise<string> {
  const bytes = await toBytes(input);
  // `BufferSource` wants a plain ArrayBuffer; a Uint8Array view may be a slice
  // of a larger buffer, so hand over exactly this view's bytes.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Sends the bytes to the signed target.
 *
 * `Content-Type` must equal the `mimeType` declared at presign EXACTLY: the
 * signature covers it, so a mismatch (or a runtime helpfully substituting its
 * own) is rejected by storage rather than by PageSpace, and the resulting
 * error names neither the field nor the cause.
 */
async function uploadBytes(
  url: string,
  bytes: Uint8Array,
  mimeType: string,
  doFetch: typeof fetch,
): Promise<void> {
  const response = await doFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new StorageUploadError(response.status, body);
  }
}

/**
 * Upload a file into a drive and return the FILE page it became.
 *
 * Throws whatever the transport classifies for the two API legs — notably a
 * 409 from presign, which is the cross-tenant claim guard: the exact bytes
 * already exist in the global namespace but this caller has never referenced
 * them, so possession has to be proven by uploading the original file under a
 * caller that legitimately holds it. That is NOT the same as the dedup fast
 * path, which succeeds and is reported as `deduplicated: true`.
 */
export async function uploadFile(
  client: OperationInvoker,
  input: UploadFileInput,
  options: UploadFileOptions = {},
): Promise<UploadFileResult> {
  const doFetch = options.fetch ?? fetch.bind(globalThis);
  const bytes = await toBytes(input.bytes);
  const contentHash = await computeContentHash(bytes);

  const reservation = await client.invoke(presignUpload, {
    contentHash,
    driveId: input.driveId,
    filename: input.filename,
    mimeType: input.mimeType,
    fileSize: bytes.byteLength,
  });

  // From here on a slot is held, so every failure path releases it.
  try {
    if (needsUpload(reservation)) {
      await uploadBytes(reservation.url, bytes, input.mimeType, doFetch);
    }

    const completed = await client.invoke(completeUpload, {
      jobId: reservation.jobId,
      title: input.title ?? input.filename,
      parentId: input.parentId,
      position: input.position,
      afterNodeId: input.afterNodeId,
    });

    return { page: completed.page, contentHash, deduplicated: !needsUpload(reservation) };
  } catch (error) {
    // Best-effort: the upload already failed, and a failing cancel must not
    // replace the real cause with a bookkeeping error. A try/catch rather than
    // `.catch()` because an invoker that throws SYNCHRONOUSLY never returns a
    // promise to attach the handler to, and the release error would then be
    // what the caller sees instead of the upload error.
    try {
      await client.invoke(cancelUpload, { jobId: reservation.jobId });
    } catch {
      // discarded on purpose — `error` below is the cause worth reporting
    }
    throw error;
  }
}
