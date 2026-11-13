import { identifyAvatarImage, sha256Hex, type AvatarImageType } from '@pagespace/lib/content-safety/avatar-gate';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { resolveScanConfigFromEnv, type ScanModeSetting } from '@pagespace/lib/content-safety/scan-mode';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { processorLogger } from '../logger';

/**
 * The avatar gate, as the processor runs it in `POST /api/avatar/upload`,
 * BEFORE the old avatar is deleted.
 *
 * 1. The bytes must be a real JPEG, PNG, GIF or WebP (magic bytes), in every mode.
 * 2. On-prem (scanning is always off there): the blocklist only, read here.
 * 3. Otherwise the web app runs the gate in ITS mode (`POST /api/internal/content-safety/avatar-gate`):
 *    blocklist, verdict cache, Hive scan, PR 4's outcome table, the review
 *    case, the urgent alert and, for a hash match, the global takedown with
 *    evidence preservation. Those executors (both buckets, the evidence bucket,
 *    the vendor key, the abuse inbox) already live in the web app; running the
 *    gate there keeps one implementation and one set of credentials, and the
 *    processor stays the choke point for the bytes. The web app's mode decides,
 *    so a processor left without CONTENT_SCAN_MODE cannot skip the scan.
 *
 * If the web app gives no answer (unreachable, timeout, error, not configured):
 * the blocklist is read here first, so a hash blocked meanwhile (a takedown in
 * flight blocks first) is always refused. Then the processor's own
 * CONTENT_SCAN_MODE decides: enforce refuses, anything else accepts (logged).
 */

export const AVATAR_GATE_PATH = '/api/internal/content-safety/avatar-gate';
/** Below the web account route's 60 s limit on the whole upload, so the processor answers before it gives up. */
const GATE_TIMEOUT_MS = 50_000;

export type AvatarUploadDecision =
  | { accept: true; contentType: AvatarImageType; extension: string; contentHash: string }
  | { accept: false; reason: 'not_an_image' | 'refused'; contentHash: string | null };

interface GateResponse {
  accept?: unknown;
}

/** The web gate's answer, or null when there was none. */
async function askWebGate(bytes: Uint8Array, userId: string): Promise<{ accept: boolean } | { why: string }> {
  const webUrl = process.env.WEB_APP_INTERNAL_URL;
  const secret = process.env.SERVICE_API_SECRET;
  if (!webUrl || !secret) return { why: 'WEB_APP_INTERNAL_URL or SERVICE_API_SECRET not set' };

  let response: Response;
  try {
    response = await fetch(new URL(AVATAR_GATE_PATH, webUrl).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-service-secret': secret,
        'x-service-user-id': userId,
      },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
  } catch (error) {
    return { why: error instanceof Error ? error.name : 'network' };
  }
  if (!response.ok) return { why: `status ${response.status}` };
  const body = (await response.json().catch(() => null)) as GateResponse | null;
  if (typeof body?.accept !== 'boolean') return { why: 'bad response' };
  return { accept: body.accept };
}

async function fallback(contentHash: string, mode: ScanModeSetting, why: string): Promise<boolean> {
  // Throws when the blocklist can't be read: the route refuses then.
  if (await isHashBlocked(contentHash)) return false;
  if (mode === 'enforce') {
    processorLogger.error('Avatar gate unavailable under enforce; the upload is refused', null, { why });
    return false;
  }
  processorLogger.error('Avatar gate unavailable; the upload is accepted after a blocklist check only', null, { why, mode });
  return true;
}

/** Decide one avatar upload. Throws only when the blocklist must be read and can't be (refuse then). */
export async function decideAvatarUpload(bytes: Uint8Array, userId: string): Promise<AvatarUploadDecision> {
  const image = identifyAvatarImage(bytes);
  if (!image) return { accept: false, reason: 'not_an_image', contentHash: null };
  const contentHash = sha256Hex(bytes);

  let accepted: boolean;
  if (isOnPrem()) {
    accepted = !(await isHashBlocked(contentHash));
  } else {
    const answer = await askWebGate(bytes, userId);
    accepted = 'accept' in answer ? answer.accept : await fallback(contentHash, resolveScanConfigFromEnv().mode, answer.why);
  }
  return accepted ? { accept: true, ...image, contentHash } : { accept: false, reason: 'refused', contentHash };
}
