import { Router, type Router as RouterType, type Request } from 'express';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { queueManager } from '../server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getPoolForWorker } from '../db';
import { getDirectorySize } from './app-build-size';

const execFileAsync = promisify(execFile);

/**
 * Publish-build endpoint (Publish surface task, drive Environments epic).
 *
 * The web app snapshots an environment's Sprite filesystem into a tarball
 * (see `apps/web/src/lib/app-hosting/env-snapshot.ts`) and streams it here as
 * a RAW request body (not multipart — see `publish-build-enqueue.ts` for
 * why). This endpoint pipes that stream straight to a file under
 * `APP_BUILD_SOURCE_ROOT` — never buffering it in process memory — extracts
 * it, then enqueues the durable `app-build` pg-boss job the same way
 * `api/erasure.ts` enqueues `account-erasure`.
 *
 * `sourceRef` is `<publishedAppId>/<timestamp>`, never the tarball's own name
 * or any client-supplied string: `materializeBuildSource`
 * (`workers/app-build-runner.ts`) trusts this value to stay inside the build
 * root, so it must be server-derived, not client input.
 *
 * AUTHORIZATION IS SCOPE-ONLY, NOT RESOURCE-BOUND — worth being honest about
 * rather than implying a stronger guarantee than exists. The token is scoped
 * to `app-hosting:publish` and stamped with the calling user's id
 * (`createUserServiceToken` in `publish-build-enqueue.ts`), but there is no
 * `requireResourceBinding`-style check tying the token to THIS
 * `publishedAppId` — the shared resource-binding middleware
 * (`middleware/resource-binding.ts`) only understands `file`/`page`
 * bindings today, and adding a `published_app` binding type is a larger,
 * cross-cutting change to that middleware and to `createUserServiceToken`'s
 * signature, out of scope for this route. What DOES happen: the web app
 * verifies the caller is a drive OWNER/ADMIN for the env being published
 * before it ever mints this token (the route that calls
 * `enqueuePublishBuild`), and this handler independently re-verifies below
 * that `publishedAppId` actually exists in `published_apps` — a minimal,
 * real check against a garbage or stale id, not a substitute for real
 * resource binding. The token is short-lived (2 minutes) and userId-scoped,
 * which bounds the blast radius of the missing binding to "an already-
 * authenticated caller could name a DIFFERENT valid published app's id
 * within that window," not an unauthenticated one.
 *
 * STREAMING IS LOAD-BEARING, not an optimization: `express.json()` (mounted
 * globally in `server.ts`) only consumes `application/json` bodies, so `req`
 * arrives here as an un-consumed readable stream for our `application/gzip`
 * content type — do NOT add `express.raw()`/multer/any body-parsing
 * middleware ahead of this route, or you buffer the whole tarball in memory
 * before this handler even runs, which is exactly the failure mode this file
 * was reworked to remove. `MAX_UPLOAD_BYTES` is enforced by counting bytes
 * as they stream past, aborting mid-stream, rather than checking a
 * fully-buffered length.
 *
 * INTERIM: see `env-snapshot.ts`'s docblock for the full reasoning and the
 * named seam (`ExecutableSandbox`'s missing streaming download) where a real
 * snapshot primitive replaces this whole tar-over-HTTP mechanism.
 */

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // interim cap — see env-snapshot.ts's matching ENV_SNAPSHOT_MAX_BYTES.

const router: RouterType = Router();

function resolveBuildSourceRoot(): string {
  return process.env.APP_BUILD_SOURCE_ROOT ?? '';
}

/** Post-extraction ceiling — independent of the pre-upload compressed-tarball cap, since a crafted archive can compress small and expand huge. */
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

const EXTRACT_TIMEOUT_MS = 120_000;

/**
 * Thrown when the extracted tree exceeds `MAX_EXTRACTED_BYTES` — a distinct
 * type rather than a string the catch block has to pattern-match, so the
 * status-code mapping below can't drift out of sync with the message text.
 */
class ExtractionCeilingExceededError extends Error {
  constructor(public readonly extractedBytes: number, public readonly maxBytes: number) {
    super(`extracted snapshot is ${extractedBytes} bytes, exceeding the ${maxBytes}-byte post-extraction interim cap`);
    this.name = 'ExtractionCeilingExceededError';
  }
}

async function publishedAppExists(publishedAppId: string): Promise<boolean> {
  const client = await getPoolForWorker().connect();
  try {
    const result = await client.query('SELECT 1 FROM published_apps WHERE id = $1 LIMIT 1', [publishedAppId]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

/** The pre-decompression compressed-upload cap in `streamRequestToFile` was exceeded — maps to 413, distinct from `ExtractionCeilingExceededError`'s 507. */
class UploadCapExceededError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`snapshot exceeds the ${maxBytes}-byte interim cap`);
    this.name = 'UploadCapExceededError';
  }
}

/** Streams `req` to `destPath`, aborting (and deleting the partial file) past `maxBytes`. */
async function streamRequestToFile(req: Request, destPath: string, maxBytes: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let received = 0;
    const ws = createWriteStream(destPath);

    const fail = (err: Error) => {
      req.unpipe(ws);
      ws.destroy();
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        fail(new UploadCapExceededError(maxBytes));
      }
    });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', resolve);

    req.pipe(ws);
  });
}

router.post('/build', async (req, res) => {
  const auth = req.auth;
  if (!auth?.userId) {
    return res.status(401).json({ error: 'Service authentication required' });
  }

  const publishedAppId = req.header('X-Published-App-Id');
  if (typeof publishedAppId !== 'string' || !publishedAppId) {
    return res.status(400).json({ error: 'X-Published-App-Id header is required' });
  }
  // publishedAppId is a cuid2 (validated shape only — the actual row check
  // already happened in the web app before it minted this request's token,
  // scoped to that app). Reject anything that could escape the build root via
  // path segments before it ever reaches path.join.
  if (!/^[a-z0-9]+$/i.test(publishedAppId)) {
    return res.status(400).json({ error: 'publishedAppId has an invalid shape' });
  }

  // Minimal, real check standing in for full resource binding (see the
  // docblock above) — a garbage or stale id refuses here rather than
  // extracting a tarball for an app that does not exist.
  const exists = await publishedAppExists(publishedAppId);
  if (!exists) {
    return res.status(404).json({ error: 'Unknown publishedAppId' });
  }

  const root = resolveBuildSourceRoot();
  if (root.length === 0) {
    return res.status(503).json({ error: 'This processor is not configured as an app build host' });
  }

  const sourceRef = `${publishedAppId}/${Date.now()}`;
  const resolvedRoot = path.resolve(root);
  const destDir = path.resolve(resolvedRoot, sourceRef);
  const tarPath = path.join(resolvedRoot, `.upload-${publishedAppId}-${Date.now()}.tar.gz`);

  try {
    await mkdir(destDir, { recursive: true });
    await streamRequestToFile(req, tarPath, MAX_UPLOAD_BYTES);
    // --no-same-owner/--no-same-permissions: this archive came from a user's
    // Sprite, not a trusted build artifact — extracting with the uid/perms it
    // was packed with would let it plant setuid bits or files owned by
    // whatever uid happened to run `tar` inside the Sprite. `timeout` bounds a
    // decompression-bomb-shaped archive that would otherwise hang this
    // handler indefinitely.
    await execFileAsync(
      'tar',
      ['--no-same-owner', '--no-same-permissions', '-xzf', tarPath, '-C', destDir],
      { timeout: EXTRACT_TIMEOUT_MS },
    );

    // Independent of the pre-upload compressed-size cap: a crafted archive
    // can compress small and expand huge, so the extracted tree gets its own
    // ceiling before anything is enqueued.
    //
    // RESIDUAL RISK, documented rather than silently accepted: this check
    // runs only AFTER `tar` finishes, so a decompression-bomb-shaped archive
    // can still spend up to `EXTRACT_TIMEOUT_MS` decompressing before this
    // line ever executes — the ceiling stops it from being ENQUEUED and from
    // occupying disk past this point, it does not stop the CPU/disk spent
    // getting here. That exposure is bounded by the extraction timeout above,
    // not eliminated; a streaming extractor that enforces the ceiling
    // mid-decompression would close it, and is out of scope for this interim
    // tar-over-HTTP mechanism (see this file's own docblock).
    const extractedBytes = await getDirectorySize(destDir);
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      throw new ExtractionCeilingExceededError(extractedBytes, MAX_EXTRACTED_BYTES);
    }

    // `singletonKey` dedups a QUEUED job against another queued one for the
    // same app (queue-manager.ts's own documented invariant) — it does NOT
    // protect against an ACTIVE build, and it must not: a `singletonSeconds`
    // window here would make pg-boss treat ANY enqueue with this key inside
    // the window as a duplicate, active build or not, which turns an ordinary
    // publish → wait for it to finish → publish again a minute later into a
    // rejected/500 request long after the build has actually completed. The
    // ACTIVE-build guard belongs where the app's real state lives — the
    // status-transactional CAS in `.../envs/[envId]/app/route.ts` (`status`
    // flips to `building` only if it wasn't already `building`/`deploying`) —
    // not in a time-boxed queue key that knows nothing about the row.
    const jobId = await queueManager.addJob(
      'app-build',
      { publishedAppId, sourceRef },
      { singletonKey: `app-build:${publishedAppId}` },
    );

    return res.json({ success: true, jobId, sourceRef });
  } catch (error) {
    loggers.processor.error('[app-build] snapshot extract/enqueue failed', {
      publishedAppId,
      error: error instanceof Error ? error.message : String(error),
    });
    // The extracted tree is always deleted on failure, ceiling-exceeded
    // included — a refused publish must never leave a multi-GB tree on disk.
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : 'Failed to extract snapshot and enqueue build';
    // 507 (Insufficient Storage) for a post-extraction bomb, 413 for the
    // pre-upload compressed-size cap — two distinct failures, so a client can
    // tell which one it hit instead of both collapsing into the same code.
    const status = error instanceof ExtractionCeilingExceededError ? 507 : error instanceof UploadCapExceededError ? 413 : 500;
    return res.status(status).json({ error: message });
  } finally {
    await rm(tarPath, { force: true }).catch(() => {});
  }
});

export const appBuildRouter: RouterType = router;
