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
import { isPermissionDeniedError } from '../errors.js';
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
  /**
   * Page title. Defaults to `filename`.
   *
   * CAVEAT, and it is a server-side one: `/complete` writes this value into
   * `originalFileName` and `fileMetadata.originalName` as well as the title,
   * and `/presign` does not retain `filename` in the reservation. So a title
   * that DIFFERS from the filename replaces the recorded original name —
   * there is nowhere else it survives. Preserving both requires the
   * completion contract to carry the filename separately; until it does,
   * pass a divergent title only when losing the original name is acceptable.
   */
  readonly title?: string;
  readonly parentId?: string | null;
  /** Drop the new page before or after `afterNodeId`. Omitted appends at the end. */
  readonly position?: 'before' | 'after' | null;
  readonly afterNodeId?: string | null;
}

export interface UploadFileOptions {
  /** Injected for tests and non-global-fetch runtimes. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Permit sending file bytes to a plaintext `http://` storage target on a
   * non-loopback host.
   *
   * Off by default: the bytes are the file itself, so a cleartext PUT exposes
   * the whole payload to anything on the path. Loopback is already exempt
   * (local MinIO and friends), so this is only needed by a deployment whose
   * object storage is reached over http at an internal HOSTNAME — e.g. a
   * self-hosted `http://minio:9000`. Such a deployment is making a considered
   * choice about its own network, which is exactly the kind of decision that
   * should be explicit rather than defaulted.
   */
  readonly allowInsecureStorageUrl?: boolean;
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

/**
 * The reservation made by presign was gone by the time complete ran.
 *
 * Exists because the server's own message for this — "Invalid or expired
 * jobId" — names only one of its two causes, and the other is the one a
 * headless caller is far more likely to hit. The reservation's metadata lives
 * in an IN-PROCESS map on the web server, so presign and complete must reach
 * the SAME replica; against a multi-replica deployment this fails
 * intermittently and at random, and a caller reading "expired" will go looking
 * for a slow upload or a clock problem that is not there.
 */
export class UploadSlotLostError extends Error {
  /**
   * Declared as a field rather than relying on `Error.cause`: the repo targets
   * es2020, whose `Error` has no `cause`. `NetworkError` in `errors.ts` does
   * the same for the same reason.
   */
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      'The upload reservation was no longer valid when finalizing. Either it expired (reservations last 10 minutes), ' +
        'or the presign and complete requests reached different server replicas — reservation state is held per-process, ' +
        'so both calls must land on the same one.',
    );
    this.name = 'UploadSlotLostError';
    this.cause = cause;
  }
}

/** The server's wording for a reservation it cannot find, from either end. */
function isMissingReservation(error: unknown): boolean {
  return isPermissionDeniedError(error) && /invalid or expired jobid/i.test(error.message);
}

/** Refused before any bytes leave the process. */
export class InsecureStorageTargetError extends Error {
  constructor(url: string) {
    super(
      `Refusing to upload file bytes over an insecure connection to ${url}. ` +
        'Pass `allowInsecureStorageUrl: true` if this deployment reaches its object storage over http on a trusted network.',
    );
    this.name = 'InsecureStorageTargetError';
  }
}

/**
 * Hosts where plaintext http is not a real exposure — the bytes never leave
 * the machine. `URL.hostname` KEEPS the brackets on an IPv6 literal
 * (`http://[::1]:9000` -> `[::1]`), so the bracketed form is what must be
 * listed; the bare form is kept alongside it for any runtime that differs.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The presign URL is issued by the caller's own PageSpace server, so this is
 * defence in depth rather than distrust: a server misconfigured with a
 * cleartext S3 endpoint would otherwise silently downgrade every upload, and
 * the failure would be invisible precisely because the upload still succeeds.
 */
export function assertSecureStorageUrl(rawUrl: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InsecureStorageTargetError(rawUrl);
  }
  if (parsed.protocol === 'https:') return;
  if (allowInsecure) return;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname)) return;
  throw new InsecureStorageTargetError(`${parsed.protocol}//${parsed.host}`);
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
  allowInsecure: boolean,
): Promise<void> {
  assertSecureStorageUrl(url, allowInsecure);
  const response = await doFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: bytes as unknown as BodyInit,
    // A presigned PUT is a single terminal request. A redirect would forward
    // the file bytes — and the signed headers — to a host the signature was
    // never issued for, so treat one as a failure rather than following it.
    redirect: 'error',
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
      await uploadBytes(reservation.url, bytes, input.mimeType, doFetch, options.allowInsecureStorageUrl ?? false);
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
    if (isMissingReservation(error)) {
      // Rethrown below through the same slot-release path as any other
      // failure: releasing a reservation the server already lost is a no-op,
      // not a second error.
      // eslint-disable-next-line no-ex-assign -- deliberately replacing the cause-obscuring server message
      error = new UploadSlotLostError(error);
    }
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
