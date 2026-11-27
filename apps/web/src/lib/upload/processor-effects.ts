import { createUploadServiceToken, createPageServiceToken } from '@pagespace/lib/services/validated-service-token';
import { toContentHash } from '@/lib/presigned-url';
import { readBytesWithCap } from '@/lib/http/read-body-with-cap';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

/** Wall-clock bound on moving one original to or from the processor (up to the 250 MB copy cap). */
const ORIGINAL_TRANSFER_TIMEOUT_MS = 120_000;

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
}: {
  actor: AccessActor;
  driveId: string;
  parentId: string | null;
  pageId: string;
  contentHash: string;
  buffer: Buffer;
  originalName: string;
}): Promise<void> {
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
    signal: AbortSignal.timeout(ORIGINAL_TRANSFER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; reason?: string };
    throw new Error(err.reason || err.error || `Processor store failed with status ${res.status}`);
  }
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
}: {
  actor: AccessActor;
  pageId: string;
  /** The page's `filePath`: the content hash, or a legacy `files/{hash}/original`. */
  filePath: string;
  maxBytes: number;
}): Promise<{ success: true; bytes: Uint8Array } | { success: false; error: string }> {
  const contentHash = toContentHash(filePath);
  const tooLarge = (bytes?: number) => ({
    success: false as const,
    error: `The file is ${bytes === undefined ? 'larger than' : `${bytes} bytes, over`} the ${maxBytes}-byte limit for one copy. It was not copied partially.`,
  });
  try {
    const { token } = await createPageServiceToken(actor, pageId, ['files:read'], '5m');
    const res = await fetch(`${PROCESSOR_URL}/cache/${encodeURIComponent(contentHash)}/original`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ORIGINAL_TRANSFER_TIMEOUT_MS),
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
    return {
      success: false,
      error: `Reading the file failed (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}
