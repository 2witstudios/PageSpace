/**
 * env-snapshot — D1 (founder decision): "publish snapshots the env's
 * filesystem at publish time."
 *
 * INTERIM MECHANISM pending a real Sprite-filesystem-export primitive
 * (tracked as [Q-publish] on the task's Questions page). There is no
 * dedicated snapshot/export primitive for a Sprite's filesystem anywhere in
 * the codebase — what DOES exist is the same `ExecutableSandbox` surface
 * every sandbox tool already uses (`runCommand`, `readFileToBuffer`), so this
 * shells `tar` INSIDE the env's own Sprite and reads the resulting archive
 * back over the same channel every other sandbox operation uses.
 *
 * THE NAMED SEAM: `ExecutableSandbox.readFileToBuffer` (`sandbox-client/types.ts`)
 * is backed by `@fly/sprites`' `filesystem('/').readFile(path, encoding: null):
 * Promise<Buffer>` (`sandbox-client/sprites.ts`) — the SDK exposes NO streaming
 * download, only a whole-file read. That is the one unavoidable
 * memory-resident copy in this pipeline, bounded by the SDK itself, not a
 * choice made here. A real fix replaces this ENTIRE file with a streaming
 * export added directly to `ExecutableSandbox`/`SpritesSdk` — do not chase
 * "make this faster," replace the mechanism.
 *
 * HARD REQUIREMENT PAST THAT BOUNDARY: the single buffer above is written
 * straight to a local temp file and never touched again — it is not
 * duplicated into a `Blob`/`FormData`, not re-read into another buffer, and
 * not held onto by the caller. Everything downstream (the HTTP hand-off to
 * the processor in `publish-build-enqueue.ts`, and the processor's own
 * extraction in `api/app-build.ts`) streams from that file to disk-to-disk.
 * If you find yourself adding a second `Buffer` anywhere in this path, you
 * are reintroducing the double-buffering this rework removed.
 *
 * An env with a Sprite that is merely HIBERNATING (not "never had a session,"
 * `driveEnvs.sandboxId` is set) needs no special wake step here: a Sprite has
 * no explicit wake API, and every `ExecutableSandbox` operation — including
 * `runCommand`/`readFileToBuffer` — already wakes a cold Sprite on the first
 * request via the client's built-in cold-start retry (`withWakeRetry` /
 * `fsWithWakeRetry` in `sandbox-client/sprites.ts`, the same path
 * `git-tool-runners.ts` and every other sandbox caller rides). Refusing with
 * `no_live_sandbox` stays correct ONLY for an env that has never had a
 * session at all (`sandboxId IS NULL`) — that case has no Sprite to wake.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProductionSpritesSandboxClient } from '@/lib/sandbox/sprites-client';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

/** The Sprite SDK's read boundary is one whole-file Buffer — this caps that single read, not any local file. */
export const ENV_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;

export type SnapshotEnvFilesystemResult =
  | { ok: true; tarPath: string; cleanup: () => Promise<void> }
  | {
      ok: false;
      reason:
        | 'no_live_sandbox'
        | 'sandbox_not_found'
        | 'tar_failed'
        | 'stat_failed'
        | 'too_large'
        | 'read_failed'
        | 'onprem_unsupported';
      detail?: string;
    };

/**
 * Tar up an env's workspace and land the archive on THIS PROCESS'S local
 * disk, returning a path (never the bytes) plus a cleanup callback the
 * caller MUST invoke once the upload in `publish-build-enqueue.ts` finishes
 * or fails.
 *
 * `sandboxId` is read by the caller from `drive_envs` — this function does
 * not touch the database, only the Sprite the caller already resolved.
 *
 * SIZE IS CHECKED BEFORE THE ONE UNAVOIDABLE BUFFER READ (see the module
 * docblock's named seam): a `stat` runs inside the Sprite via the same exec
 * channel as the tar itself, and an over-cap archive is refused there,
 * BEFORE `readFileToBuffer` ever runs. The whole-file buffer this SDK forces
 * is acceptable only because nothing over the cap ever reaches it.
 *
 * The tar path is unique PER CALL (`randomUUID()`), never a fixed name —
 * two publishes racing the same env (a re-publish fired twice, or a retry
 * overlapping the original) must not read or delete each other's archive.
 * The in-Sprite tarball is removed in a `finally` regardless of outcome, so
 * a failed or aborted publish never leaves it behind in the user's
 * environment.
 */
export async function snapshotEnvFilesystem(sandboxId: string | null): Promise<SnapshotEnvFilesystemResult> {
  // Fly Sprites is an external integration — gated on `isOnPrem()`, never
  // `!isCloud()` (CLAUDE.md's deployment-mode guard rule), so a tenant
  // deployment (dedicated-image cloud, not self-hosted) is unaffected. An
  // on-prem deployment must never reach a Fly Sprites client regardless of
  // whether `sandboxId` happens to be set; self-hosted environments use a
  // local bridge instead (deferred, per the Drive Environments epic), never
  // this Sprite-backed publish path.
  if (isOnPrem()) return { ok: false, reason: 'onprem_unsupported' };
  if (!sandboxId) return { ok: false, reason: 'no_live_sandbox' };

  const client = await createProductionSpritesSandboxClient();
  const sandbox = await client.get({ sandboxId });
  if (!sandbox) return { ok: false, reason: 'sandbox_not_found' };

  const remoteTarPath = `/tmp/pgs-publish-snapshot-${randomUUID()}.tar.gz`;

  try {
    // A hibernating Sprite wakes on this exec automatically — see the docblock.
    const tarResult = await sandbox.runCommand({
      cmd: 'tar',
      args: ['czf', remoteTarPath, '-C', SANDBOX_ROOT, '.'],
      timeoutMs: 120_000,
      maxBytes: 64 * 1024,
    });
    if (tarResult.exitCode !== 0) {
      // A Sprite that dies mid-tar (killed, evicted, network partition) surfaces
      // here as a non-zero exit or a thrown exec error (caught below) — both map
      // to a typed refusal the route can turn into a 502, never a bare 500.
      return { ok: false, reason: 'tar_failed', detail: tarResult.stderr.slice(0, 2000) };
    }

    const statResult = await sandbox.runCommand({
      cmd: 'stat',
      args: ['-c', '%s', remoteTarPath],
      timeoutMs: 30_000,
      maxBytes: 1024,
    });
    if (statResult.exitCode !== 0) {
      return { ok: false, reason: 'stat_failed', detail: statResult.stderr.slice(0, 2000) };
    }
    const remoteSize = Number.parseInt(statResult.stdout.trim(), 10);
    if (!Number.isFinite(remoteSize)) {
      return { ok: false, reason: 'stat_failed', detail: `unparseable stat output: ${statResult.stdout.slice(0, 200)}` };
    }
    if (remoteSize > ENV_SNAPSHOT_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        detail: `snapshot is ${remoteSize} bytes, exceeding the ${ENV_SNAPSHOT_MAX_BYTES}-byte interim cap`,
      };
    }

    // The one unavoidable whole-file Buffer (see docblock's named seam) — only
    // reached now that the pre-check above has bounded its size. It is written
    // to disk immediately below and the reference is dropped — nothing after
    // this point may hold the tarball in memory again.
    const buffer = await sandbox.readFileToBuffer({ path: remoteTarPath });
    if (!buffer || buffer.length === 0) {
      return { ok: false, reason: 'read_failed' };
    }
    if (buffer.length > ENV_SNAPSHOT_MAX_BYTES) {
      // Defense in depth: the stat above is the primary guard, this catches a
      // Sprite that grew the file between the two calls.
      return {
        ok: false,
        reason: 'too_large',
        detail: `snapshot is ${buffer.length} bytes, exceeding the ${ENV_SNAPSHOT_MAX_BYTES}-byte interim cap`,
      };
    }

    const dir = await mkdtemp(join(tmpdir(), 'pgs-publish-snapshot-'));
    const localTarPath = join(dir, 'snapshot.tar.gz');

    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(localTarPath);
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end(buffer);
    });

    return {
      ok: true,
      tarPath: localTarPath,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'tar_failed',
      detail: error instanceof Error ? error.message : 'unknown error snapshotting the sandbox',
    };
  } finally {
    // Best-effort: the in-Sprite tarball must never be left behind, whether
    // this call succeeded, refused on size, or the Sprite died mid-flight.
    await sandbox
      .runCommand({ cmd: 'rm', args: ['-f', remoteTarPath], timeoutMs: 10_000, maxBytes: 1024 })
      .catch(() => {});
  }
}
