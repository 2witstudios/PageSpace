import { identifyAvatarImage, sha256Hex, type AvatarImageType } from '@pagespace/lib/content-safety/avatar-gate';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { resolveScanConfigFromEnv, type ScanModeSetting } from '@pagespace/lib/content-safety/scan-mode';
import { processorLogger } from '../logger';

/**
 * The avatar gate, as the processor runs it in `POST /api/avatar/upload`,
 * BEFORE the old avatar is deleted.
 *
 * 1. The bytes must be a real JPEG, PNG, GIF or WebP (magic bytes), in every mode.
 * 2. With scanning off (always, on-prem): the blocklist only, read here.
 * 3. Otherwise the web app runs the gate (`POST /api/internal/content-safety/avatar-gate`):
 *    blocklist, verdict cache, Hive scan, PR 4's outcome table, the review
 *    case, the urgent alert and, for a hash match, the global takedown with
 *    evidence preservation. Those executors (both buckets, the evidence bucket,
 *    the vendor key, the abuse inbox) already live in the web app; running the
 *    gate there keeps one implementation and one set of credentials, and the
 *    processor stays the choke point for the bytes.
 *
 * If the web app can't be asked: refused under enforce (fails closed),
 * accepted with an error log under shadow.
 */

export const AVATAR_GATE_PATH = '/api/internal/content-safety/avatar-gate';
const GATE_TIMEOUT_MS = 30_000;

export type AvatarUploadDecision =
  | { accept: true; contentType: AvatarImageType; extension: string; contentHash: string }
  | { accept: false; reason: 'not_an_image' | 'refused'; contentHash: string | null };

interface GateResponse {
  accept?: unknown;
}

async function askWebGate(bytes: Uint8Array, userId: string, mode: ScanModeSetting): Promise<boolean> {
  const webUrl = process.env.WEB_APP_INTERNAL_URL;
  const secret = process.env.SERVICE_API_SECRET;
  const unreachable = (why: string): boolean => {
    if (mode === 'enforce') {
      processorLogger.error('Avatar gate unavailable under enforce; the upload is refused', null, { why });
      return false;
    }
    processorLogger.error('Avatar gate unavailable under shadow; the upload is accepted unscanned', null, { why });
    return true;
  };
  if (!webUrl || !secret) return unreachable('WEB_APP_INTERNAL_URL or SERVICE_API_SECRET not set');

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
    return unreachable(error instanceof Error ? error.name : 'network');
  }
  if (!response.ok) return unreachable(`status ${response.status}`);
  const body = (await response.json().catch(() => null)) as GateResponse | null;
  if (typeof body?.accept !== 'boolean') return unreachable('bad response');
  return body.accept;
}

/** Decide one avatar upload. Throws only when scanning is off and the blocklist can't be read (refuse then). */
export async function decideAvatarUpload(bytes: Uint8Array, userId: string): Promise<AvatarUploadDecision> {
  const image = identifyAvatarImage(bytes);
  if (!image) return { accept: false, reason: 'not_an_image', contentHash: null };
  const contentHash = sha256Hex(bytes);

  const { mode } = resolveScanConfigFromEnv();
  const accepted = mode === 'off' ? !(await isHashBlocked(contentHash)) : await askWebGate(bytes, userId, mode);
  return accepted ? { accept: true, ...image, contentHash } : { accept: false, reason: 'refused', contentHash };
}
