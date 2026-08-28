/**
 * publish-source-check — the up-front half of D1's "a Dockerfile at the root
 * wins, else a default buildpack" (see `dockerfile-synthesis-core.ts` for the
 * pure decision, and its docblock for why "buildpack" means a synthesized
 * Dockerfile, not an external buildpack system).
 *
 * Runs BEFORE `snapshotEnvFilesystem`/`enqueuePublishBuild` — a source this
 * module cannot recognize refuses here, at essentially no cost, rather than
 * after a multi-hundred-MB tar/upload round trip fails deep in the build
 * queue with a much colder trail back to "add a Dockerfile."
 *
 * WHY THE SYNTHESIZED DOCKERFILE IS WRITTEN INTO THE ENV, not injected into
 * the tarball after the fact: this module and `env-snapshot.ts` are
 * deliberately independent (no shared edit surface), and the env's own
 * `ExecutableSandbox.writeFiles` is the only I/O primitive available at this
 * seam. Writing it into the environment is also arguably the right end
 * state, not just an implementation convenience — it leaves the generated
 * Dockerfile visible and editable in the workspace a developer actually
 * works in, the same way a scaffolding tool would, rather than a build
 * artifact that exists nowhere the user can see or customize it.
 */

import { createProductionSpritesSandboxClient } from '@/lib/sandbox/sprites-client';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import {
  planDockerfileSynthesis,
  type SourceRootListing,
} from '@pagespace/lib/services/app-hosting/dockerfile-synthesis-core';

export type EnsureBuildableSourceResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'no_live_sandbox'
        | 'sandbox_not_found'
        | 'inspect_failed'
        | 'no_recognizable_source'
        | 'node_missing_start_command';
      detail?: string;
    };

function parsePackageJson(raw: string): SourceRootListing['packageJson'] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const { scripts, main } = parsed as { scripts?: unknown; main?: unknown };
    return {
      scripts: scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : undefined,
      main: typeof main === 'string' ? main : undefined,
    };
  } catch {
    // An unparseable package.json is still "a package.json is present" for
    // the purposes of routing to the Node branch, but carries no scripts/main
    // — planDockerfileSynthesis then correctly refuses with
    // `node_missing_start_command` rather than this function guessing.
    return {};
  }
}

/**
 * Ensure the env has (or now has) a buildable root before any snapshot work
 * starts. A hibernating Sprite wakes transparently on these commands, same as
 * every other `ExecutableSandbox` call — see `env-snapshot.ts`'s docblock for
 * the underlying SDK behavior this relies on.
 */
export async function ensureBuildableSource(sandboxId: string | null): Promise<EnsureBuildableSourceResult> {
  if (!sandboxId) return { ok: false, reason: 'no_live_sandbox' };

  const client = await createProductionSpritesSandboxClient();
  const sandbox = await client.get({ sandboxId });
  if (!sandbox) return { ok: false, reason: 'sandbox_not_found' };

  const ls = await sandbox.runCommand({
    cmd: 'ls',
    args: ['-a', SANDBOX_ROOT],
    timeoutMs: 10_000,
    maxBytes: 16 * 1024,
  });
  if (ls.exitCode !== 0) {
    return { ok: false, reason: 'inspect_failed', detail: ls.stderr.slice(0, 500) };
  }
  const entries = new Set(ls.stdout.split('\n').map((line) => line.trim()).filter(Boolean));

  let packageJson: SourceRootListing['packageJson'] = null;
  if (entries.has('package.json')) {
    const cat = await sandbox.runCommand({
      cmd: 'cat',
      args: [`${SANDBOX_ROOT}/package.json`],
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
    });
    packageJson = cat.exitCode === 0 ? parsePackageJson(cat.stdout) : {};
  }

  const plan = planDockerfileSynthesis({
    hasDockerfile: entries.has('Dockerfile'),
    hasIndexHtml: entries.has('index.html'),
    packageJson,
  });

  if (plan.action === 'use_existing') return { ok: true };
  if (plan.action === 'refuse') return { ok: false, reason: plan.reason };

  try {
    await sandbox.writeFiles([{ path: `${SANDBOX_ROOT}/Dockerfile`, content: plan.dockerfile }]);
  } catch (error) {
    return {
      ok: false,
      reason: 'inspect_failed',
      detail: error instanceof Error ? error.message : 'failed to write synthesized Dockerfile',
    };
  }

  return { ok: true };
}

/** User-facing copy for each refusal — used by the publish route. */
export function describeUnbuildableSourceReason(
  reason: Exclude<EnsureBuildableSourceResult, { ok: true }>['reason'],
): string {
  switch (reason) {
    case 'no_recognizable_source':
      return "This environment has no Dockerfile, package.json, or index.html — add a Dockerfile (or a package.json/index.html PageSpace can build from) and publish again.";
    case 'node_missing_start_command':
      return 'This environment has a package.json but no `scripts.start` or `main` entry, so PageSpace cannot generate a Dockerfile that knows how to run it — add one of those, or add your own Dockerfile.';
    case 'inspect_failed':
      return 'Could not inspect the environment to determine how to build it.';
    case 'sandbox_not_found':
      return 'This environment has no reachable session to publish from.';
    case 'no_live_sandbox':
      return 'This environment has no live session to publish from — start a session in it first.';
  }
}
