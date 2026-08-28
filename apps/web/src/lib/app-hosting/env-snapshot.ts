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
import { createProductionSpritesSandboxClient } from '@/lib/sandbox/sprites-client';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

const SNAPSHOT_TAR_PATH = '/tmp/pgs-publish-snapshot.tar.gz';

/** The Sprite SDK's read boundary is one whole-file Buffer — this caps that single read, not any local file. */
export const ENV_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;

export type SnapshotEnvFilesystemResult =
  | { ok: true; tarPath: string; cleanup: () => Promise<void> }
  | { ok: false; reason: 'no_live_sandbox' | 'sandbox_not_found' | 'tar_failed' | 'read_failed'; detail?: string };

/**
 * Tar up an env's workspace and land the archive on THIS PROCESS'S local
 * disk, returning a path (never the bytes) plus a cleanup callback the
 * caller MUST invoke once the upload in `publish-build-enqueue.ts` finishes
 * or fails.
 *
 * `sandboxId` is read by the caller from `drive_envs` — this function does
 * not touch the database, only the Sprite the caller already resolved.
 */
export async function snapshotEnvFilesystem(sandboxId: string | null): Promise<SnapshotEnvFilesystemResult> {
  if (!sandboxId) return { ok: false, reason: 'no_live_sandbox' };

  const client = await createProductionSpritesSandboxClient();
  const sandbox = await client.get({ sandboxId });
  if (!sandbox) return { ok: false, reason: 'sandbox_not_found' };

  // A hibernating Sprite wakes on this exec automatically — see the docblock.
  const tarResult = await sandbox.runCommand({
    cmd: 'tar',
    args: ['czf', SNAPSHOT_TAR_PATH, '-C', SANDBOX_ROOT, '.'],
    timeoutMs: 120_000,
    maxBytes: 64 * 1024,
  });
  if (tarResult.exitCode !== 0) {
    return { ok: false, reason: 'tar_failed', detail: tarResult.stderr.slice(0, 2000) };
  }

  // The one unavoidable whole-file Buffer (see docblock's named seam). It is
  // written to disk immediately below and the reference is dropped —
  // nothing after this point may hold the tarball in memory again.
  const buffer = await sandbox.readFileToBuffer({ path: SNAPSHOT_TAR_PATH });
  if (!buffer || buffer.length === 0) {
    return { ok: false, reason: 'read_failed' };
  }
  if (buffer.length > ENV_SNAPSHOT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'read_failed',
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
}
