/**
 * `parseWriteDigestKey` — the plane-held HMAC key for pending-write digests
 * (G2 ruling 4), parsed from the credential plane's own environment
 * (`AGENT_ACCOUNTS_WRITE_DIGEST_KEY`, base64, at least 32 bytes).
 *
 * An unset or short key is a REFUSAL, never a default: a digest under an empty
 * or guessable key is exactly the offline dictionary oracle the ruling
 * removes, and a plane that invented its own key at boot would disagree with
 * its own replicas about every pending write. Pure.
 */
import { decodeBase64 } from '../decode-base64';
import type { WriteDigestKey } from './store-adapter';

export const WRITE_DIGEST_KEY_VAR = 'AGENT_ACCOUNTS_WRITE_DIGEST_KEY';

const MIN_KEY_BYTES = 32;

export type WriteDigestKeyVerdict =
  | { readonly ok: true; readonly key: WriteDigestKey }
  | { readonly ok: false; readonly reason: 'unset' | 'malformed' };

export function parseWriteDigestKey({ raw }: { readonly raw: string | undefined }): WriteDigestKeyVerdict {
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) return { ok: false, reason: 'unset' };
  const bytes = decodeBase64(trimmed);
  if (bytes === null || bytes.length < MIN_KEY_BYTES) return { ok: false, reason: 'malformed' };
  return { ok: true, key: bytes as WriteDigestKey };
}
