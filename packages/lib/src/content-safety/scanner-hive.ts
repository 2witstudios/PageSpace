/**
 * Hive CSAM Detection (combined API) adapter for the scanner port.
 *
 * One synchronous call per file runs Hive's hash matching (Thorn's Safer lists)
 * and, when nothing matches, its CSAM classifier. Written against Hive's public
 * docs (docs.thehive.ai, "CSAM Detection - Combined API"); every point the docs
 * do not settle is an assumption listed in `.pu-reports/pu-cs-publish-gate.md`
 * and marked ASSUMPTION below.
 *
 * The bytes are sent as a multipart upload, never as a URL to our storage.
 * Nothing here logs the bytes, a URL or the response body: a failure is reported
 * by its kind and, for HTTP, the status code only.
 */

import { z } from 'zod';
import type { ContentScanner, ScanResult } from './scanner';

export const HIVE_PROVIDER = 'hive';

/** ASSUMPTION: the sync endpoint accepts the `media` form field (the docs show it on the async endpoint only). */
export const HIVE_SYNC_ENDPOINT = 'https://api.thehive.ai/api/v2/task/sync';

/** Thorn's test lists. The docs say matches against them "can be ignored"; staging can opt in to exercise the pipeline. */
const TEST_HASH_SETS = new Set(['test', 'test-se']);

/** Hive's supported upload types for this API (images: jpg, png, gif, webp; video: mp4, mov). */
export const HIVE_SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
]);

export interface HiveMappingOptions {
  /** A `csam` classifier score at or above this flags the file, even if Hive did not list `csam` in its reasons. */
  flagThreshold: number;
  /** Treat matches against Thorn's test lists as real (staging only). */
  includeTestSets?: boolean;
}

const score = z.number().finite();

const hiveResponseSchema = z.object({
  status: z
    .array(
      z.object({
        status: z.object({ code: z.union([z.number(), z.string()]), message: z.string().optional() }),
        response: z
          .object({
            output: z.object({
              file: z.object({
                fileType: z.string().optional(),
                reasons: z.array(z.string()).default([]),
                classifierPrediction: z
                  .object({
                    csam_classifier: z.object({ csam: score, pornography: score.optional(), other: score.optional() }),
                  })
                  .nullable()
                  .optional(),
              }),
              hashes: z
                .array(
                  z.object({
                    hashType: z.string().optional(),
                    matchTypes: z.array(z.string()).default([]),
                    reasons: z.array(z.string()).default([]),
                    sources: z.array(z.object({ hashSet: z.string() })).default([]),
                  }),
                )
                .default([]),
            }),
          })
          .optional(),
      }),
    )
    .min(1),
});

const isSuccessCode = (code: number | string) => String(code) === '200' || String(code) === '0';

/**
 * Map one HTTP response from Hive to a scan result. Pure: the whole vendor
 * contract lives here, so it is tested against fixtures shaped like the docs.
 */
export function mapHiveResponse(httpStatus: number, body: unknown, options: HiveMappingOptions): ScanResult {
  const provider = HIVE_PROVIDER;
  if (httpStatus < 200 || httpStatus >= 300) return { kind: 'error', provider, reason: 'http_status', detail: String(httpStatus) };

  const parsed = hiveResponseSchema.safeParse(body);
  if (!parsed.success) return { kind: 'error', provider, reason: 'bad_response' };

  const [entry] = parsed.data.status;
  if (!isSuccessCode(entry.status.code) || !entry.response) {
    return { kind: 'error', provider, reason: 'vendor_status', detail: String(entry.status.code) };
  }
  const { file, hashes } = entry.response.output;

  // Hash matches first: a match is decisive and the classifier does not run after one.
  const counted = hashes
    .map((hash) => ({
      ...hash,
      sources: hash.sources.filter((source) => options.includeTestSets || !TEST_HASH_SETS.has(source.hashSet)),
    }))
    .filter((hash) => hash.sources.length > 0 && (hash.reasons.includes('matched') || hash.matchTypes.length > 0));
  if (counted.length > 0) {
    return {
      kind: 'hash_match',
      provider,
      lists: [...new Set(counted.flatMap((hash) => hash.sources.map((source) => source.hashSet)))],
      matchTypes: [...new Set(counted.flatMap((hash) => hash.matchTypes))],
    };
  }
  // ASSUMPTION: a file-level "matched" with no listed real source can only be a test-list match.
  // With test lists excluded it is ignored; anything else is unexplained, so it is an error, not clean.
  if (file.reasons.includes('matched') && !hashes.some((hash) => hash.sources.some((s) => TEST_HASH_SETS.has(s.hashSet)))) {
    return { kind: 'error', provider, reason: 'bad_response', detail: 'match_without_source' };
  }

  const prediction = file.classifierPrediction?.csam_classifier;
  if (prediction) {
    const scores: Record<string, number> = { csam: prediction.csam };
    if (prediction.pornography !== undefined) scores.pornography = prediction.pornography;
    if (prediction.other !== undefined) scores.other = prediction.other;
    if (file.reasons.includes('csam') || prediction.csam >= options.flagThreshold) {
      return { kind: 'classifier_flag', provider, category: 'csam', score: prediction.csam, scores };
    }
    return { kind: 'clean', provider, scores };
  }

  if (file.reasons.includes('csam')) {
    return { kind: 'classifier_flag', provider, category: 'csam', score: 1 };
  }
  // ASSUMPTION: a null prediction with no match means the hash pass ran and the classifier did not
  // (too small after de-letterboxing, or video, where the docs show no classifier output). That is
  // reported as clean with no scores; the verdict row records `classifier: false`.
  return { kind: 'clean', provider };
}

export interface HiveScannerConfig extends HiveMappingOptions {
  apiKey: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export function createHiveScanner(config: HiveScannerConfig): ContentScanner {
  const endpoint = config.endpoint ?? HIVE_SYNC_ENDPOINT;
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    provider: HIVE_PROVIDER,
    async scan(input, options) {
      if (!HIVE_SUPPORTED_TYPES.has(input.contentType)) {
        return { kind: 'unsupported_type', provider: HIVE_PROVIDER, contentType: input.contentType };
      }
      const form = new FormData();
      // The file name is a placeholder: the real name never leaves our side.
      const bytes = new Uint8Array(input.bytes);
      form.append('media', new Blob([bytes], { type: input.contentType }), input.mediaKind);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Token ${config.apiKey}`, Accept: 'application/json' },
          body: form,
          signal: options?.signal,
        });
      } catch {
        return { kind: 'error', provider: HIVE_PROVIDER, reason: options?.signal?.aborted ? 'timeout' : 'network' };
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        if (response.ok) return { kind: 'error', provider: HIVE_PROVIDER, reason: 'bad_response' };
      }
      return mapHiveResponse(response.status, body, config);
    },
  };
}
