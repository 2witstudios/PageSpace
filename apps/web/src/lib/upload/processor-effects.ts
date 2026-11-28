import {
  createUploadServiceToken,
  createPageServiceToken,
  createSystemFileDeleteToken,
} from '@pagespace/lib/services/validated-service-token';
import { toContentHash } from '@/lib/presigned-url';
import { readBytesWithCap } from '@/lib/http/read-body-with-cap';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/** Wall-clock bound on moving one original to or from the processor (up to the 250 MB copy cap). */
const ORIGINAL_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * A transfer's timeout: its own bound, clipped to the caller's `deadlineAt` (the
 * whole tool call's budget). Null when the deadline has already passed.
 */
function transferTimeoutMs(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) return ORIGINAL_TRANSFER_TIMEOUT_MS;
  const left = deadlineAt - Date.now();
  return left > 0 ? Math.min(ORIGINAL_TRANSFER_TIMEOUT_MS, left) : null;
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const TIMED_OUT = 'The transfer did not finish in time and was stopped.';

export async function enqueueProcessorJob(
  actor: AccessActor,
  driveId: string,
  pageId: string,
): Promise<void> {
  const { token } = await createUploadServiceToken({ actor, driveId, pageId });
  // /pull runs the zero-trust pull-verify pipeline (re-hash + Magika gate) rather
  // than /by-page, which trusts the page's declared mimeType.
  const res = await fetch(`${PROCESSOR_URL}/api/ingest/pull/${pageId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Processor ingest failed with status ${res.status}`);
  }
}

/**
 * Store the original bytes of a FILE page the server is about to create, through
 * the processor (`POST /api/originals/:pageId`), so they get the same at-rest
 * treatment (`FILE_ENCRYPTION_ENABLED`) as every processor-written original.
 *
 * The token is the upload token: bound to the NEW page id (no row yet) and
 * minted only after an edit check on `parentId` (or the drive), so this store
 * re-proves the caller may write there. Throws on any refusal — the caller has
 * written no rows yet and must not.
 */
export async function storeOriginalViaProcessor({
  actor,
  driveId,
  parentId,
  pageId,
  contentHash,
  buffer,
  originalName,
  deadlineAt,
}: {
  actor: AccessActor;
  driveId: string;
  parentId: string | null;
  pageId: string;
  contentHash: string;
  buffer: Buffer;
  originalName: string;
  deadlineAt?: number;
}): Promise<{ stored: boolean }> {
  const timeoutMs = transferTimeoutMs(deadlineAt);
  if (timeoutMs === null) throw new Error(TIMED_OUT);
  const { token } = await createUploadServiceToken({
    actor,
    driveId,
    pageId,
    ...(parentId ? { parentId } : {}),
    scopes: ['files:write'],
  });
  const res = await fetch(`${PROCESSOR_URL}/api/originals/${encodeURIComponent(pageId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Content-Hash': contentHash,
      'X-Original-Name': encodeURIComponent(originalName),
    },
    body: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => {
    throw isTimeout(error) ? new Error(TIMED_OUT) : error;
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; reason?: string };
    throw new Error(err.reason || err.error || `Processor store failed with status ${res.status}`);
  }
  // `stored: false` = the bytes were already there under this hash (someone's).
  const body = await res.json().catch(() => ({})) as { stored?: boolean };
  return { stored: body.stored === true };
}

/**
 * Delete an original that was stored for a FILE page whose rows then failed to
 * commit, so it is not left in storage with no row to reap or bill it.
 *
 * Through the processor's `DELETE /api/files/:hash` with a system file-bound
 * token — the orphan reaper's own path — which refuses (409) while anything
 * still references the hash or a takedown holds it. Throws on any refusal, for
 * the caller to log; it never decides on its own that bytes are unowned.
 */
export async function reclaimOrphanedOriginal(contentHash: string): Promise<void> {
  const { token } = await createSystemFileDeleteToken({ contentHash, expiresIn: '30s' });
  const res = await fetch(`${PROCESSOR_URL}/api/files/${encodeURIComponent(contentHash)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Processor refused to reclaim ${contentHash} (status ${res.status})`);
}

/**
 * Read a FILE page's ORIGINAL bytes from the processor (`/cache/:hash/original`),
 * where decryption and authorization happen in one place.
 *
 * The caller checks `canActorViewPage` first; the page-bound `files:read` token
 * then makes the processor check it again against the page's file links. Refuses
 * rather than truncates above `maxBytes`, checking the declared length before the
 * body is read and the received length after. Never throws: every failure is a
 * sentence for the agent.
 */
export async function fetchOriginalFromProcessor({
  actor,
  pageId,
  filePath,
  maxBytes,
  deadlineAt,
}: {
  actor: AccessActor;
  pageId: string;
  /** The page's `filePath`: the content hash, or a legacy `files/{hash}/original`. */
  filePath: string;
  maxBytes: number;
  deadlineAt?: number;
}): Promise<{ success: true; bytes: Uint8Array } | { success: false; error: string; reason?: 'over_limit' }> {
  const contentHash = toContentHash(filePath);
  // Tagged, so a caller that capped below the real limit can say what happened.
  const tooLarge = (bytes?: number) => ({
    success: false as const,
    reason: 'over_limit' as const,
    error: `The file is ${bytes === undefined ? 'larger than' : `${bytes} bytes, over`} the ${maxBytes}-byte limit for one copy. It was not copied partially.`,
  });
  const timeoutMs = transferTimeoutMs(deadlineAt);
  if (timeoutMs === null) return { success: false, error: `${TIMED_OUT} The file was not copied.` };
  try {
    const { token } = await createPageServiceToken(actor, pageId, ['files:read'], '5m');
    const res = await fetch(`${PROCESSOR_URL}/cache/${encodeURIComponent(contentHash)}/original`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 410) return { success: false, error: 'This file has been removed, so it cannot be copied.' };
    if (res.status === 403) return { success: false, error: 'Access to this file was denied.' };
    if (res.status === 404) return { success: false, error: 'The stored file could not be found.' };
    if (!res.ok) return { success: false, error: `Reading the file failed (processor returned ${res.status}).` };

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return tooLarge(declared);
    }
    // Stops reading the moment the cap is passed, so a body with no declared
    // length is never buffered whole before the check.
    const bytes = await readBytesWithCap(res, maxBytes);
    if (bytes === null) return tooLarge();
    return { success: true, bytes };
  } catch (error) {
    if (isTimeout(error)) return { success: false, error: `Reading the file did not finish in time and was stopped. The file was not copied.` };
    return {
      success: false,
      error: `Reading the file failed (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}
