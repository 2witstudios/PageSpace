import 'server-only';

import { createHash } from 'node:crypto';
import { audit } from '@pagespace/lib/audit/audit-log';
import type { BackfillDeps, BackfillItemOutcome, BackfillTarget, DryRunDeps, ListedObject } from '@pagespace/lib/content-safety/backfill';
import { claimBackfillCursor, saveBackfillCursor } from '@pagespace/lib/content-safety/backfill-store';
import { errorLabel, evaluatePublishAsset, type PublishGateDeps, type PublishGateEvaluation } from '@pagespace/lib/content-safety/publish-gate';
import type { ScanGateConfig } from '@pagespace/lib/content-safety/scan-mode';
import { findScanVerdicts } from '@pagespace/lib/content-safety/scan-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  deletePublishedAssetsForHash,
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
 *   off the web (`content.backfill.unpublished`). Nothing is blocked; the review
 *   case decides. Under shadow it stays up.
 *
 * Errors, unscanned types and unverified video stay up and are counted: they
 * were public before the gate, and a vendor outage must not take sites down.
 * A republish holds them under enforce.
 */

/** Largest avatar the processor accepts, plus slack. A bigger object under `avatars/` did not come from it. */
const MAX_AVATAR_READ_BYTES = 6 * 1024 * 1024;

const AVATAR_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface BackfillActions {
  removePublicAsset(contentHash: string): Promise<number>;
  removeAvatar(userId: string): Promise<void>;
  takedownAvatar(userId: string, reason: string): Promise<void>;
}

async function defaultRemoveAvatar(userId: string): Promise<void> {
  const { removeUserAvatar } = await import('./takedown-service');
  await removeUserAvatar(userId);
}

async function defaultTakedownAvatar(userId: string, reason: string): Promise<void> {
  const { executeTakedown } = await import('./takedown-service');
  const response = await executeTakedown({ action: 'avatar', userId, category: 'csam', reason }, null);
  if (response.failedStep) throw new Error(`Avatar takedown stopped at ${response.failedStep}`);
}

const defaultActions: BackfillActions = {
  removePublicAsset: deletePublishedAssetsForHash,
  removeAvatar: defaultRemoveAvatar,
  takedownAvatar: defaultTakedownAvatar,
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
  const gateDeps = options.gateDeps ?? ((overrides: Partial<PublishGateDeps>) => createPublishGateDeps(config, overrides));

  async function processAsset(target: Extract<BackfillTarget, { kind: 'asset' }>): Promise<BackfillItemOutcome> {
    const originalKey = target.derived ? `files/${target.contentHash}/original` : target.key;
    const evaluation = await evaluatePublishAsset(
      { contentHash: target.contentHash, originalKey, declaredContentType: null, fileId: null, userId: null, entryPoint: 'backfill' },
      gateDeps({
        readSource: (key, maxBytes) => (target.derived ? readPrivateSource(key, maxBytes) : readPublishedObjectBounded(key, maxBytes, READ_TIMEOUT_MS)),
      }),
    );
    let removed = evaluation.finding === 'hash_match' && evaluation.caseId !== null;
    if (evaluation.finding === 'blocked' || (evaluation.finding === 'flagged' && config.mode === 'enforce')) {
      await actions.removePublicAsset(target.contentHash);
      removed = true;
      if (evaluation.finding === 'flagged') {
        auditUnpublished({ kind: 'asset', contentHash: target.contentHash, mode: config.mode, finding: evaluation.finding, caseId: evaluation.caseId });
      }
    }
    return outcome(evaluation, removed);
  }

  async function processAvatar(target: Extract<BackfillTarget, { kind: 'avatar' }>): Promise<BackfillItemOutcome | null> {
    const read = await readS3ObjectBounded(getS3Client(), getS3Bucket(), target.key, MAX_AVATAR_READ_BYTES, READ_TIMEOUT_MS);
    if (!read) return null;
    const { bytes } = read;
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    let avatarTakenDown = false;
    const evaluation = await evaluatePublishAsset(
      { contentHash, originalKey: target.key, declaredContentType: AVATAR_TYPES[target.extension] ?? null, fileId: null, userId: target.userId, entryPoint: 'backfill' },
      gateDeps({
        readSource: async () => read,
        async takedownHashMatch({ contentHash: hash, lists }) {
          if (read.complete) {
            await stageBytesForTakedown(hash, bytes).catch((error: unknown) =>
              loggers.security.error('Backfill: could not stage a hash-matched avatar for preservation', undefined, { error: errorLabel(error) }),
            );
          }
          try {
            return await runHashMatchTakedown({ contentHash: hash, lists, source: 'the backfill scan of an avatar' });
          } finally {
            // The avatar comes down even if the global takedown stopped part-way (its case is resumable).
            await actions.takedownAvatar(target.userId, 'Hash match from the backfill scan of this avatar');
            avatarTakenDown = true;
          }
        },
      }),
    );
    let removed = avatarTakenDown;
    if (evaluation.finding === 'blocked' || (evaluation.finding === 'flagged' && config.mode === 'enforce')) {
      await actions.removeAvatar(target.userId);
      removed = true;
      if (evaluation.finding === 'flagged') {
        auditUnpublished({ kind: 'avatar', contentHash, mode: config.mode, finding: evaluation.finding, caseId: evaluation.caseId, userId: target.userId });
      }
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
