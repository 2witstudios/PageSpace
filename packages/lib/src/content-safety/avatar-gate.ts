/**
 * Avatar gate — decides whether an uploaded profile picture may replace the
 * user's current one. User avatars are served without auth, with a one-year
 * immutable cache header, so this is a public surface like the publish bucket.
 *
 * The processor runs it in `POST /api/avatar/upload` BEFORE the old avatar is
 * deleted, so a refused upload never destroys the current avatar.
 *
 * Order:
 *   1. The bytes must be a real JPEG, PNG, GIF or WebP (magic bytes; the
 *      declared type and file name decide nothing). Refused in every mode.
 *   2. The publish gate (publish-gate.ts) on the same bytes, in memory:
 *      blocklist, a fresh verdict, then the scan, with PR 4's outcome table.
 *      A hash match runs the global takedown and is refused in every mode; a
 *      classifier flag or a scan error is refused under enforce and accepted
 *      (recorded, case opened) in shadow.
 *
 * The verdict is recorded under the SHA-256 of the bytes, like any other file.
 * The reason for a refusal is never returned to the uploader: callers show
 * `AVATAR_NOT_AN_IMAGE_MESSAGE` or `AVATAR_REJECTED_MESSAGE`.
 */

import { createHash } from 'node:crypto';
import { evaluatePublishAsset, type GateFinding, type PublishGateDeps } from './publish-gate';
import { sniffContentType } from './scan-policy';

/** Avatar types, by what the bytes are, and the extension the object is stored under (which sets its served type). */
export const AVATAR_IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
} as const;

export type AvatarImageType = keyof typeof AVATAR_IMAGE_TYPES;

/** Shown when the bytes are not an image we accept. Says nothing about scanning. */
export const AVATAR_NOT_AN_IMAGE_MESSAGE = 'Please upload a JPEG, PNG, GIF or WebP image.';

/** Shown for every other refusal (blocked, flagged, couldn't be checked). Never says which. */
export const AVATAR_REJECTED_MESSAGE = "This image can't be used as a profile picture. Please try a different image.";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What the bytes are, when they are an image we accept as an avatar. Null for anything else. */
export function identifyAvatarImage(bytes: Uint8Array): { contentType: AvatarImageType; extension: string } | null {
  const sniffed = sniffContentType(bytes, { complete: true });
  if (sniffed && sniffed in AVATAR_IMAGE_TYPES) {
    const contentType = sniffed as AvatarImageType;
    return { contentType, extension: AVATAR_IMAGE_TYPES[contentType] };
  }
  return null;
}

export type AvatarRejectionReason = 'not_an_image' | 'blocked' | 'held';

export type AvatarGateResult =
  | { accept: true; contentType: AvatarImageType; extension: string; contentHash: string; finding: GateFinding }
  | { accept: false; reason: AvatarRejectionReason; contentHash: string; finding: GateFinding | null };

export interface AvatarRejectionEvent {
  userId: string;
  contentHash: string;
  reason: AvatarRejectionReason;
  finding: GateFinding | null;
  mode: string;
}

export interface AvatarGateDeps extends Omit<PublishGateDeps, 'readSource'> {
  /** Record the refusal (audit `content.avatar.rejected`). Never fails the decision. */
  auditRejected(event: AvatarRejectionEvent): void;
}

/**
 * Gate one avatar upload. Throws only when the blocklist cannot be read: the
 * caller must refuse the upload then ("couldn't check" is never "allowed").
 */
export async function gateAvatarUpload(input: { bytes: Uint8Array; userId: string }, deps: AvatarGateDeps): Promise<AvatarGateResult> {
  const contentHash = sha256Hex(input.bytes);
  const reject = (reason: AvatarRejectionReason, finding: GateFinding | null): AvatarGateResult => {
    try {
      deps.auditRejected({ userId: input.userId, contentHash, reason, finding, mode: deps.config.mode });
    } catch {
      // An audit failure must not turn a refusal into an acceptance, or the other way round.
    }
    return { accept: false, reason, contentHash, finding };
  };

  const image = identifyAvatarImage(input.bytes);
  if (!image) return reject('not_an_image', null);

  const { bytes } = input;
  const evaluation = await evaluatePublishAsset(
    {
      contentHash,
      originalKey: `avatar-upload/${contentHash}`,
      declaredContentType: image.contentType,
      fileId: null,
      userId: input.userId,
      entryPoint: 'user_avatar',
    },
    {
      ...deps,
      // The bytes are already in memory: the gate sniffs and scans exactly what will be stored.
      readSource: async (_key, maxBytes) => ({ bytes, complete: bytes.length <= maxBytes }),
    },
  );
  if (!evaluation.promote) return reject(evaluation.reason, evaluation.finding);
  return { accept: true, contentType: image.contentType, extension: image.extension, contentHash, finding: evaluation.finding };
}
