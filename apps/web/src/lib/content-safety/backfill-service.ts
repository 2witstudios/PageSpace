import 'server-only';

import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { audit } from '@pagespace/lib/audit/audit-log';
import type { BackfillDeps, BackfillItemOutcome, BackfillTarget, DryRunDeps, ListedObject } from '@pagespace/lib/content-safety/backfill';
import { claimBackfillCursor, saveBackfillCursor } from '@pagespace/lib/content-safety/backfill-store';
import { errorLabel, evaluatePublishAsset, type PublishGateDeps, type PublishGateEvaluation } from '@pagespace/lib/content-safety/publish-gate';
import type { ScanGateConfig } from '@pagespace/lib/content-safety/scan-mode';
import { findBlockCaseId } from '@pagespace/lib/content-safety/blocklist';
import { findOpenReviewCaseId, findScanVerdicts } from '@pagespace/lib/content-safety/scan-store';
import { holdKeyFor } from '@pagespace/lib/content-safety/takedown';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  isPublishConfigured,
  listPublishedAssetsPage,
  readPublishedObjectBounded,
} from '@/lib/canvas/published-storage';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { listS3Page, readS3ObjectBounded } from '@/lib/storage/s3-objects';
import { READ_TIMEOUT_MS, createPublishGateDeps, readPrivateSource, runHashMatchTakedown, stageBytesForTakedown } from './publish-gate-service';

/**
 * The backfill's real dependencies (the walk itself is
 * `@pagespace/lib/content-safety/backfill`).
 *
 * Each object goes through the publish gate, exactly as a publish would:
 *
 * - **A public asset** (`assets/<hash>`) is scanned as the bytes being served.
 *   A derived copy (`assets/cache/<hash>/…`, a thumbnail) is gated as its
 *   original (`files/<hash>/original`), like the publish gate does.
 * - **An avatar** is read from the uploads bucket and keyed by the SHA-256 of
 *   its bytes.
 *
 * What is done with a finding, beyond what the gate already does (verdict,
 * review case, alert, and for a hash match the global takedown):
 *
 * - **blocked** (a blocklisted hash still being served): its public copy is
 *   removed, in every mode.
 * - **hash_match** on an avatar: the bytes are staged for preservation before
 *   the global takedown, and the avatar is then removed through an `avatar`
 *   takedown case. (For an asset, the global takedown removes the public copy.)
 * - **classifier flag** under enforce: the public copy, or the avatar, is taken
 *   off the web (`content.backfill.unpublished`), after a verified private copy
 *   is kept under the review case (`content-hold/<case>/<hash>`): it may be the
 *   only copy, and the case needs it. Nothing is blocked; the review case
 *   decides. Under shadow it stays up.
 * - An avatar is re-read before any of that is done to it: the user may have
 *   uploaded a new one while the scan ran, and that one was gated at upload.
 *
 * Errors, unscanned types and unverified video stay up and are counted: they
 * were public before the gate, and a vendor outage must not take sites down.
 * A republish holds them under enforce.
 */

/** Largest avatar the processor accepts, plus slack. A bigger object under `avatars/` did not come from it. */
const MAX_AVATAR_READ_BYTES = 6 * 1024 * 1024;

const AVATAR_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface BackfillActions {
  /**
   * Take the public copies of a hash off the web, keeping a verified private copy first (the global
   * takedown's own `takePublicOffline`), under the case's hold key. Never a bare delete: whatever the finding,
   * the public copy can be the only one left (its private original deleted since it was published).
   */
  takePublicOffline(contentHash: string, caseId: string): Promise<void>;
  /**
   * Keep an avatar's bytes in the private bucket at the case's hold key (`content-hold/<case>/<hash>`) and verify
   * the copy, before a classifier flag removes the avatar: the review case needs something to look at. Throws
   * when the copy cannot be made or verified; nothing is removed then.
   */
  holdAvatarBytes(caseKey: string, contentHash: string, bytes: Uint8Array): Promise<void>;
  removeAvatar(userId: string): Promise<void>;
  /** Stop showing an avatar without deleting it (clear the profile image), for when its bytes can't be preserved yet. */
  hideAvatar(userId: string): Promise<void>;
  /**
   * Run an avatar takedown case. True once the case is actioned (the avatar is gone); false when it stopped
   * without deleting it: CSAM waiting for evidence storage, or another run of the case under way.
   */
  takedownAvatar(userId: string, reason: string): Promise<boolean>;
  /** The case that blocked a hash, if any. */
  findBlockCaseId(contentHash: string): Promise<string | null>;
  /** The case under review (`reported`) for a hash, if any: a flag decided from a stored verdict carries no case ID. */
  findReviewCaseId(contentHash: string): Promise<string | null>;
}

async function defaultRemoveAvatar(userId: string): Promise<void> {
  const { removeUserAvatar } = await import('./takedown-service');
  await removeUserAvatar(userId);
}

async function defaultTakedownAvatar(userId: string, reason: string): Promise<boolean> {
  const { executeTakedown } = await import('./takedown-service');
  const response = await executeTakedown({ action: 'avatar', userId, category: 'csam', reason }, null);
  if (response.failedStep) throw new Error(`Avatar takedown stopped at ${response.failedStep}`);
  if (response.inProgress || response.status !== 'actioned') {
    loggers.security.error('Backfill: the avatar takedown did not delete the avatar; it is hidden and retried', undefined, {
      caseId: response.caseId ?? null,
      status: response.status ?? null,
      inProgress: response.inProgress ?? false,
    });
    return false;
  }
  return true;
}

async function defaultHideAvatar(userId: string): Promise<void> {
  const { hideUserAvatar } = await import('./takedown-service');
  await hideUserAvatar(userId);
}

async function defaultTakePublicOffline(contentHash: string, caseId: string): Promise<void> {
  const { createTakedownStorage } = await import('./takedown-storage');
  await createTakedownStorage().takePublicOffline(contentHash, caseId);
}

async function defaultHoldAvatarBytes(caseKey: string, contentHash: string, bytes: Uint8Array): Promise<void> {
  const key = holdKeyFor(caseKey, contentHash);
  await getS3Client().send(new PutObjectCommand({ Bucket: getS3Bucket(), Key: key, Body: bytes, ContentType: 'application/octet-stream' }));
  const copy = await readS3ObjectBounded(getS3Client(), getS3Bucket(), key, MAX_AVATAR_READ_BYTES, READ_TIMEOUT_MS);
  if (!copy?.complete || createHash('sha256').update(copy.bytes).digest('hex') !== contentHash) {
    throw new Error('The private hold copy of the avatar could not be verified; the avatar was left in place');
  }
}

/** Hold key namespace for a public copy with no case to hold it under (an old or hand-made block, a lost case). */
const UNCASED_HOLD = 'backfill-uncased';

const defaultActions: BackfillActions = {
  takePublicOffline: defaultTakePublicOffline,
  holdAvatarBytes: defaultHoldAvatarBytes,
  removeAvatar: defaultRemoveAvatar,
  hideAvatar: defaultHideAvatar,
  takedownAvatar: defaultTakedownAvatar,
  findBlockCaseId,
  findReviewCaseId: findOpenReviewCaseId,
};

function auditUnpublished(details: { kind: 'asset' | 'avatar'; contentHash: string; mode: string; finding: string; caseId: string | null; userId?: string }): void {
  audit({
    eventType: 'content.backfill.unpublished',
    resourceType: details.kind === 'asset' ? 'file' : 'avatar',
    resourceId: details.contentHash,
    details: { kind: details.kind, mode: details.mode, finding: details.finding, caseId: details.caseId, ...(details.userId ? { userId: details.userId } : {}) },
    riskScore: 0.8,
  });
}

function outcome(evaluation: PublishGateEvaluation, removed: boolean): BackfillItemOutcome {
  return { finding: evaluation.finding, scanned: evaluation.scanned, removed };
}

export function createBackfillDeps(
  config: ScanGateConfig,
  options: { actions?: Partial<BackfillActions>; gateDeps?: (overrides: Partial<PublishGateDeps>) => PublishGateDeps } = {},
): BackfillDeps {
  const actions = { ...defaultActions, ...options.actions };

  /** The review case a flagged copy is held under: the gate's, else the one open for the hash, else the uncased namespace. */
  async function flaggedHoldKey(contentHash: string, caseId: string | null): Promise<string> {
    const key = caseId ?? (await actions.findReviewCaseId(contentHash));
    if (key) return key;
    loggers.security.error('Backfill: a flagged copy has no review case; it is held under content-hold/backfill-uncased/', undefined, { contentHash });
    return UNCASED_HOLD;
  }
  const gateDeps = options.gateDeps ?? ((overrides: Partial<PublishGateDeps>) => createPublishGateDeps(config, overrides));

  async function processAsset(target: Extract<BackfillTarget, { kind: 'asset' }>): Promise<BackfillItemOutcome> {
    const originalKey = target.derived ? `files/${target.contentHash}/original` : target.key;
    let takedown: 'done' | 'needs_public_hold' | 'no_case' | null = null;
    let takedownCaseId: string | null = null;
    const evaluation = await evaluatePublishAsset(
      { contentHash: target.contentHash, originalKey, declaredContentType: null, fileId: null, userId: null, entryPoint: 'backfill' },
      gateDeps({
        readSource: (key, maxBytes) => (target.derived ? readPrivateSource(key, maxBytes) : readPublishedObjectBounded(key, maxBytes, READ_TIMEOUT_MS)),
        async takedownHashMatch({ contentHash, lists }) {
          takedown = 'no_case';
          const result = await runHashMatchTakedown({ contentHash, lists, source: 'the backfill scan' });
          takedownCaseId = result.caseId ?? null;
          takedown = !takedownCaseId ? 'no_case' : result.failedStep ? 'needs_public_hold' : 'done';
          return { caseId: result.caseId };
        },
      }),
    );

    let removed = false;
    if (evaluation.finding === 'hash_match') {
      if (takedown === 'done') {
        removed = true;
      } else if (takedown === 'needs_public_hold' && takedownCaseId) {
        // The takedown stopped part-way, possibly before its own unpublish step. Take the public copy down
        // the same way that step does: a verified private hold under the case first, then the delete.
        await actions.takePublicOffline(target.contentHash, takedownCaseId);
        removed = true;
      } else {
        // No case to hold the copy under (the takedown threw): nothing is deleted, and the walk retries the item.
        throw new Error('Hash-match takedown did not open its case');
      }
    }
    if (evaluation.finding === 'blocked') {
      // A blocklisted hash still served: off the web, keeping a private copy under its case (it may be the only one).
      const blockCaseId = await actions.findBlockCaseId(target.contentHash);
      if (!blockCaseId) {
        // No case will ever preserve or clean this hold: someone must open one (a global takedown of the hash).
        loggers.security.error('Backfill: a blocked hash with no case was still public; it is held under content-hold/backfill-uncased/ and needs a case', undefined, { contentHash: target.contentHash });
      }
      await actions.takePublicOffline(target.contentHash, blockCaseId ?? UNCASED_HOLD);
      removed = true;
    }
    if (evaluation.finding === 'flagged' && config.mode === 'enforce') {
      // Not a block, so nothing is deleted for good: the public copy is kept privately under the review case
      // first (it can be the only copy left), then taken off the web. The review case decides.
      await actions.takePublicOffline(target.contentHash, await flaggedHoldKey(target.contentHash, evaluation.caseId));
      removed = true;
      auditUnpublished({ kind: 'asset', contentHash: target.contentHash, mode: config.mode, finding: evaluation.finding, caseId: evaluation.caseId });
    }
    return outcome(evaluation, removed);
  }

  async function processAvatar(target: Extract<BackfillTarget, { kind: 'avatar' }>): Promise<BackfillItemOutcome | null> {
    const read = await readS3ObjectBounded(getS3Client(), getS3Bucket(), target.key, MAX_AVATAR_READ_BYTES, READ_TIMEOUT_MS);
    // Gone since the listing.
    if (!read) return null;
    // Larger than any avatar the processor accepts: unchecked, so counted as an error (readiness blocks on it).
    if (!read.complete) return { finding: 'error', scanned: false, removed: false };
    const { bytes } = read;
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    let avatarTakenDown = false;
    let avatarHidden = false;
    // The scan awaits the vendor, and the user can upload a new avatar meanwhile; the processor replaces the
    // whole avatars/<userId>/ prefix. Every removal below is of the user's avatar, not of these bytes, so each
    // first checks the bytes scanned are still the ones stored. A replacement was gated at upload.
    let replaced = false;
    const avatarStep: { failure: { error: unknown } | null } = { failure: null };
    const stillCurrent = async (): Promise<boolean> => {
      if (replaced) return false;
      const now = await readS3ObjectBounded(getS3Client(), getS3Bucket(), target.key, MAX_AVATAR_READ_BYTES, READ_TIMEOUT_MS);
      replaced = !now || !now.complete || createHash('sha256').update(now.bytes).digest('hex') !== contentHash;
      if (replaced) loggers.security.info('Backfill: the avatar was replaced while it was scanned; the new one is left alone', {});
      return !replaced;
    };
    const stage = async (hash: string): Promise<boolean> => {
      try {
        await stageBytesForTakedown(hash, bytes);
        return true;
      } catch (error) {
        loggers.security.error('Backfill: could not stage an avatar for preservation; it is not deleted', undefined, { error: errorLabel(error) });
        return false;
      }
    };
    // Replaced after a failed staging: the upload already deleted the stored avatar, so the bytes read here are the
    // only copy left. Try again before giving up on them; nothing else can preserve them later.
    const stageLastCopy = async (hash: string): Promise<void> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await stage(hash)) return;
      }
      loggers.security.error('Backfill: a blocked or hash-matched avatar was replaced and its bytes could not be preserved', undefined, { contentHash: hash });
    };
    const evaluation = await evaluatePublishAsset(
      { contentHash, originalKey: target.key, declaredContentType: AVATAR_TYPES[target.extension] ?? null, fileId: null, userId: target.userId, entryPoint: 'backfill' },
      gateDeps({
        readSource: async () => read,
        async takedownHashMatch({ contentHash: hash, lists }) {
          const staged = await stage(hash);
          let globalCaseId: string | null = null;
          try {
            // Block, case and alert run either way: the global takedown never touches avatars/ objects.
            const result = await runHashMatchTakedown({ contentHash: hash, lists, source: 'the backfill scan of an avatar' });
            globalCaseId = result.caseId ?? null;
            return result;
          } finally {
            // The gate swallows a throw from here (it logs a failed takedown), so a failure to take the avatar
            // down is carried out and thrown below: the walk stops before the item and retries it.
            try {
              if (!(await stillCurrent())) {
                // Replaced: these bytes are no longer served, and the block above keeps them from coming back. No
                // avatar case opens (there is nothing left to delete), so the global case is the only record: name
                // the uploader beside it for staff.
                loggers.security.error('Backfill: a hash-matched avatar was replaced before it could be taken down; its uploader is not on the case', undefined, {
                  caseId: globalCaseId,
                  userId: target.userId,
                });
                if (!staged) await stageLastCopy(hash);
              } else if (staged) {
                // The avatar comes down even if the global takedown stopped part-way (its case is resumable).
                if (await actions.takedownAvatar(target.userId, 'Hash match from the backfill scan of this avatar')) {
                  avatarTakenDown = true;
                } else {
                  // Not deleted (CSAM waiting for evidence storage, or a run already under way): stop showing it.
                  await actions.hideAvatar(target.userId);
                  avatarHidden = true;
                }
              } else {
                // The avatar is the only copy: it stops being shown, and is deleted once a later pass can stage it
                // (the hash is then blocked, and the blocked path below stages before it deletes).
                await actions.hideAvatar(target.userId);
                avatarHidden = true;
              }
            } catch (error) {
              avatarStep.failure = { error };
            }
          }
        },
      }),
    );
    if (avatarStep.failure) throw avatarStep.failure.error;
    if (evaluation.finding === 'blocked') {
      // A blocklisted avatar: its bytes go to the hash's private, blocked key before the avatar is deleted.
      const staged = await stage(contentHash);
      if (!(await stillCurrent())) {
        // Replaced since the read: nothing of the scanned avatar is left to take down.
        if (!staged) await stageLastCopy(contentHash);
      } else if (staged) {
        await actions.removeAvatar(target.userId);
        avatarTakenDown = true;
      } else {
        await actions.hideAvatar(target.userId);
        avatarHidden = true;
      }
    }
    // Hidden is not removed: the avatar's URL still answers from storage. Stop before this object so the next
    // tick (10 minutes) retries; by then the hash is blocked, and the blocked path stages before it deletes.
    if (avatarHidden && !avatarTakenDown) throw new Error('Avatar hidden but not yet deleted: it could not be staged for preservation, or its takedown did not finish');
    let removed = avatarTakenDown;
    if (evaluation.finding === 'flagged' && config.mode === 'enforce' && (await stillCurrent())) {
      // The removal deletes the only copy: keep the scanned bytes privately under the review case first. If that
      // fails, this throws and the avatar stays until a later tick can keep them.
      await actions.holdAvatarBytes(await flaggedHoldKey(contentHash, evaluation.caseId), contentHash, bytes);
      await actions.removeAvatar(target.userId);
      removed = true;
      auditUnpublished({ kind: 'avatar', contentHash, mode: config.mode, finding: evaluation.finding, caseId: evaluation.caseId, userId: target.userId });
    }
    return outcome(evaluation, removed);
  }

  return {
    claim: claimBackfillCursor,
    save: (cursor, saveOptions) => saveBackfillCursor(cursor, saveOptions),
    list: listBackfillPage,
    process: (target) => (target.kind === 'asset' ? processAsset(target) : processAvatar(target)),
    now: () => new Date(),
  };
}

/** A page of the phase's prefix. With no publish bucket there are no public assets to walk. */
export function listBackfillPage(
  phase: 'assets' | 'avatars',
  startAfter: string | null,
  maxKeys: number,
): Promise<{ objects: ListedObject[]; truncated: boolean }> {
  if (phase === 'assets') {
    return isPublishConfigured() ? listPublishedAssetsPage(startAfter, maxKeys) : Promise.resolve({ objects: [], truncated: false });
  }
  return listS3Page(getS3Client(), getS3Bucket(), 'avatars/', startAfter, maxKeys);
}

export function createDryRunDeps(): DryRunDeps {
  return { list: listBackfillPage, findVerdicts: findScanVerdicts, now: () => new Date() };
}
