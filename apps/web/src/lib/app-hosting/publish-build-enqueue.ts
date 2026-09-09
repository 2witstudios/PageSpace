import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';

/**
 * Enqueue a publish build on the processor's `app-build` pg-boss queue.
 *
 * Mirrors `apps/web/src/lib/erasure/enqueue.ts`: mint a short-lived service
 * token scoped to this one action, POST to the processor, return what the
 * processor durably queued.
 *
 * STREAMING, NOT BUFFERING: the tarball at `tarPath` (produced by
 * `env-snapshot.ts`, which already dropped its one in-memory copy to disk)
 * is sent as the raw request body via `createReadStream`, never re-read into
 * a `Buffer`/`Blob`/`FormData` — that would reintroduce the double-buffering
 * the interim snapshot mechanism was explicitly reworked to avoid. The
 * processor mirrors this: it pipes the incoming request stream straight to a
 * file under `APP_BUILD_SOURCE_ROOT` (`api/app-build.ts`), so the tarball is
 * never fully materialized in either process's memory at once — the SDK's
 * whole-file Buffer boundary in `env-snapshot.ts` is the only one left.
 *
 * The publishedAppId and tarball size travel as headers (not a multipart
 * field) precisely because a raw streamed body has no field boundaries.
 */

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export interface EnqueuePublishBuildParams {
  publishedAppId: string;
  /** Path to the tarball on local disk — see `env-snapshot.ts`. Never read into memory here. */
  tarPath: string;
  /** The authenticated caller minting the token (the publisher). */
  callerUserId: string;
}

export interface EnqueuePublishBuildResult {
  jobId: string;
  sourceRef: string;
}

export async function enqueuePublishBuild(params: EnqueuePublishBuildParams): Promise<EnqueuePublishBuildResult> {
  const { token } = await createUserServiceToken(params.callerUserId, ['app-hosting:publish'], '2m');
  const { size } = await stat(params.tarPath);

  const res = await fetch(`${PROCESSOR_URL}/api/app-hosting/build`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/gzip',
      'Content-Length': String(size),
      'X-Published-App-Id': params.publishedAppId,
    },
    // Node's fetch requires `duplex: 'half'` for a streaming request body.
    body: Readable.toWeb(createReadStream(params.tarPath)) as ReadableStream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Processor publish-build enqueue failed: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as { jobId?: string; sourceRef?: string };
  if (!json.jobId || !json.sourceRef) {
    throw new Error('Processor publish-build enqueue returned no jobId/sourceRef');
  }
  return { jobId: json.jobId, sourceRef: json.sourceRef };
}
