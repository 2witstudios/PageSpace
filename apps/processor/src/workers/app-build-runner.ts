/**
 * app-build-runner — the two Node-only seams the published-app build pipeline
 * leaves to its host: running Docker, and turning a source ref into a directory.
 *
 * They live HERE rather than in `@pagespace/lib` because `child_process` and `fs`
 * must not appear anywhere in that package — it is bundled into the Next.js app,
 * where importing either is at best dead weight and at worst a build failure. The
 * library defines the interfaces; the processor, which is a plain Node service,
 * supplies them.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  BuilderProcessResult,
  BuilderRunOptions,
  BuilderRunner,
} from '@pagespace/lib/services/app-hosting/image-builder';
import type { MaterializedSource } from '@pagespace/lib/services/app-hosting/build-job';

/** Bound on captured output per stream. Docker builds are chatty; memory is not free. */
const MAX_CAPTURED_BYTES = 256 * 1024;

/**
 * Run a command with an ARGUMENT ARRAY and no shell.
 *
 * `shell: false` (spawn's default, restated here because it is load-bearing) is
 * what makes it safe for a user-influenced value — a source ref, an image tag — to
 * reach this function at all. Through a shell, a ref containing `;` or a backtick
 * would be a command-injection primitive running as the processor.
 *
 * A timeout KILLS the process and resolves with `code: null` rather than rejecting,
 * so callers see the same "did this succeed" shape for a hang as for a failure. The
 * kill is `SIGKILL`, not `SIGTERM`: a wedged BuildKit build is exactly the case
 * where a polite signal is ignored and the worker slot stays held.
 */
export function createBuilderRunner(): BuilderRunner {
  return {
    run(command: string, args: string[], options: BuilderRunOptions = {}) {
      return new Promise<BuilderProcessResult>((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd, shell: false });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const capture = (current: string, chunk: Buffer): string =>
          current.length >= MAX_CAPTURED_BYTES
            ? current
            : (current + chunk.toString('utf8')).slice(0, MAX_CAPTURED_BYTES);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = capture(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = capture(stderr, chunk);
        });

        const timer =
          options.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                child.kill('SIGKILL');
              }, options.timeoutMs);

        const finish = (result: BuilderProcessResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          resolve(result);
        };

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          // The binary is missing or not executable — the builder-probe path.
          reject(error);
        });
        child.on('close', (code) => finish({ code, stdout, stderr }));

        // A process that exits before reading its stdin makes the write fail with
        // EPIPE, and an unhandled 'error' on a stream takes the WHOLE PROCESSOR
        // down — a wedged `docker login` would kill every other worker with it.
        // The close/error handlers above already carry the real outcome, so this
        // one only has to stop the throw.
        child.stdin?.on('error', () => {});
        // The deploy token travels here, never in argv (see `registryLogin`).
        child.stdin?.end(options.stdin ?? undefined);
      });
    },
  };
}

/**
 * Where build contexts live. Unset means this processor is not a build host, and
 * every build refuses rather than guessing a directory.
 */
export function resolveBuildSourceRoot(): string {
  return process.env.APP_BUILD_SOURCE_ROOT ?? '';
}

/**
 * Resolve a source ref to a build context on disk.
 *
 * THE REF IS UNTRUSTED. It is confined to `APP_BUILD_SOURCE_ROOT` by resolving it
 * and then requiring the result to still be inside that root — which is the check
 * that stops `../../etc` or an absolute path from turning "build this workspace"
 * into "build the host's filesystem, with a Dockerfile that can read all of it".
 * `path.resolve` alone does not do this; it happily escapes.
 *
 * `cleanup` is a no-op because nothing is copied: the context is the directory the
 * ref names. If a later phase materialises sources into a scratch dir (a git
 * export, a Tigris fetch), the deletion belongs here and the interface already has
 * a place for it.
 */
export async function materializeBuildSource(sourceRef: string): Promise<MaterializedSource> {
  const root = resolveBuildSourceRoot();
  if (root.length === 0) {
    throw new Error(
      'APP_BUILD_SOURCE_ROOT is not set; this processor is not configured as an app build host',
    );
  }

  const resolvedRoot = path.resolve(root);
  const contextDir = path.resolve(resolvedRoot, sourceRef);
  if (contextDir !== resolvedRoot && !contextDir.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Source ref '${sourceRef}' resolves outside the configured build root`);
  }

  const dirStat = await stat(contextDir).catch(() => null);
  if (dirStat === null || !dirStat.isDirectory()) {
    throw new Error(`Source ref '${sourceRef}' is not a directory`);
  }

  const dockerfile = path.join(contextDir, 'Dockerfile');
  try {
    await access(dockerfile);
  } catch {
    throw new Error(
      `Source ref '${sourceRef}' has no Dockerfile; a published app must declare how it builds`,
    );
  }

  return { contextDir, dockerfile, cleanup: async () => {} };
}
