import 'server-only';

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { audit } from '@pagespace/lib/audit/audit-log';
import { sendContentSafetyAlert } from '@pagespace/lib/content-safety/alerts';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import {
  errorLabel,
  gatePublishAsset,
  type PublishGateDeps,
  type PublishGateInput,
  type PublishGateResult,
  type ScanAuditEvent,
  type SourceRead,
} from '@pagespace/lib/content-safety/publish-gate';
import { resolveScanConfigFromEnv, type ScanGateConfig } from '@pagespace/lib/content-safety/scan-mode';
import { findScanVerdict, openScanReviewCase, recordScanVerdict } from '@pagespace/lib/content-safety/scan-store';
import { createHiveScanner } from '@pagespace/lib/content-safety/scanner-hive';
import type { ContentScanner } from '@pagespace/lib/content-safety/scanner';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { isS3NotFound } from '@/lib/storage/s3-objects';

/**
 * The publish gate with its real dependencies: the blocklist and verdict
 * tables, the private uploads bucket, Hive, PR 2's global takedown, the review
 * queue and the abuse inbox. The decisions are in `@pagespace/lib/content-safety/publish-gate`.
 *
 * Scan input is the BYTES, read from the private bucket and sent as a multipart
 * upload, rather than a presigned URL:
 *   - no capability URL to a private object ever leaves our infrastructure, so
 *     there is nothing for the vendor (or its logs) to replay;
 *   - we sniff the same bytes we send, so the declared type cannot steer the scan;
 *   - the read is bounded by `CONTENT_SCAN_MAX_BYTES` (HEAD first): a larger file
 *     is never buffered, and an image or video over the bound is a scan error.
 * Assets are gated at most four at a time per publish (asset-pipeline), and a
 * type published unscanned is remembered for the verdict TTL, so it is not re-read on every republish.
 */

/** Bytes read from a file over the size bound: enough to recognise its type. */
const SNIFF_BYTES = 4096;

/** A read of the original that takes longer than this is abandoned (the asset is held as unreadable). */
const READ_TIMEOUT_MS = 30_000;

const RISK: Record<ScanAuditEvent['eventType'], number> = {
  'content.scan.clean': 0,
  'content.scan.unscanned': 0.1,
  'content.scan.error': 0.3,
  'content.scan.flagged': 0.8,
  'content.scan.hash_match': 1,
};

const reported = new Set<string>();

/** Log each configuration problem once per process: every publish would otherwise repeat it. */
function reportMisconfiguration(config: ScanGateConfig, problem: string): void {
  const key = `${config.mode}:${problem}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (problem === 'missing_key' && config.mode === 'enforce') {
    loggers.security.error(
      'Content scanning is set to enforce but HIVE_API_KEY is not set: no file will be copied to the public bucket until it is',
      undefined,
      { mode: config.mode },
    );
  } else if (problem === 'missing_key') {
    loggers.security.warn('Content scanning is in shadow mode but HIVE_API_KEY is not set: files are published unscanned', { mode: config.mode });
  } else {
    loggers.security.error('CONTENT_SCAN_MODE is not off, shadow or enforce; treating it as enforce', undefined, { mode: config.mode });
  }
}

async function readBody(body: unknown): Promise<Uint8Array> {
  const whole = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (whole && typeof whole.transformToByteArray === 'function') return whole.transformToByteArray();
  return new Uint8Array(0);
}

/** The original's bytes when they fit under `maxBytes`, else its first bytes. Null on not-found. */
export async function readPrivateSource(key: string, maxBytes: number): Promise<SourceRead | null> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  let size: number;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    size = head.ContentLength ?? 0;
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
  const head = { size };
  const tooLarge = head.size > maxBytes;
  try {
    const result = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(tooLarge ? { Range: `bytes=0-${SNIFF_BYTES - 1}` } : {}) }),
      { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) },
    );
    const bytes = await readBody(result.Body);
    // The object may have been replaced between the HEAD and the GET.
    if (bytes.length > maxBytes) return { bytes: bytes.subarray(0, SNIFF_BYTES), complete: false };
    return { bytes, complete: !tooLarge };
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
}

function buildScanner(config: ScanGateConfig): ContentScanner | null {
  const apiKey = process.env.HIVE_API_KEY?.trim();
  if (!config.scannerConfigured || !apiKey) return null;
  return createHiveScanner({ apiKey, flagThreshold: config.flagThreshold, includeTestSets: config.includeTestSets });
}

export function createPublishGateDeps(config: ScanGateConfig = resolveScanConfigFromEnv()): PublishGateDeps {
  return {
    config,
    scanner: buildScanner(config),
    isBlocked: isHashBlocked,
    findVerdict: findScanVerdict,
    readSource: readPrivateSource,
    recordVerdict: (record) => recordScanVerdict(record),
    async takedownHashMatch({ contentHash, lists }) {
      // A known-CSAM match is acted on in every mode: the system (no admin) runs PR 2's global takedown,
      // which writes the block first, preserves the bytes, removes every copy and alerts.
      // Loaded lazily: the takedown service reaches back into the publish code (unpublish → publish-page),
      // which imports this gate.
      const { executeTakedown } = await import('./takedown-service');
      const response = await executeTakedown(
        {
          action: 'global',
          contentHash,
          category: 'csam',
          reason: `Hash match from the publish scan (lists: ${lists.join(', ').slice(0, 200) || 'unspecified'})`,
        },
        null,
      );
      if (response.failedStep) {
        loggers.security.error('Publish gate: the hash-match takedown stopped part-way; resume the case', undefined, {
          caseId: response.caseId ?? null,
          failedStep: response.failedStep,
        });
      }
      return { caseId: response.caseId };
    },
    openReviewCase: (input) => openScanReviewCase(input),
    alert: sendContentSafetyAlert,
    audit(event) {
      audit({
        eventType: event.eventType,
        userId: event.userId ?? undefined,
        resourceType: 'file',
        resourceId: event.contentHash,
        details: event.details,
        riskScore: RISK[event.eventType],
      });
    },
    reportMisconfiguration: (problem) => reportMisconfiguration(config, problem),
    logError(message, context) {
      loggers.security.error(message, undefined, context);
    },
    now: () => new Date(),
  };
}

/**
 * Decide whether one asset may be promoted. A gate that cannot read the
 * blocklist (or fails in any unexpected way) holds the asset: "couldn't check"
 * never reads as "allowed".
 */
export async function gateAssetForPublish(input: PublishGateInput, deps: PublishGateDeps = createPublishGateDeps()): Promise<PublishGateResult> {
  try {
    return await gatePublishAsset(input, deps);
  } catch (error) {
    // The name and code only: a failed query's message carries the content hash as a parameter.
    loggers.security.error('Publish gate failed; the asset is held', undefined, {
      fileId: input.fileId,
      entryPoint: input.entryPoint,
      error: errorLabel(error),
    });
    return { promote: false, reason: 'held' };
  }
}
