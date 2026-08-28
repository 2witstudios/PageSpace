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
import type { ExecutableSandbox } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import {
  planDockerfileSynthesis,
  GENERATED_DOCKERFILE_MARKER,
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

  // Direct existence checks, never a directory listing: `ls -a`'s output is
  // capped (`maxBytes`) and a root with enough entries to exceed that cap
  // would make a Dockerfile-HAVING env look Dockerfile-less to a substring
  // parse of a truncated listing — which would then overwrite the user's
  // real Dockerfile. `test -f` on a specific path can't be truncated into a
  // wrong answer.
  const hasDockerfile = await fileExists(sandbox, `${SANDBOX_ROOT}/Dockerfile`);
  if (hasDockerfile === 'inspect_failed') {
    return { ok: false, reason: 'inspect_failed', detail: 'could not check for a Dockerfile at the environment root' };
  }

  let dockerfileFirstLine: string | null = null;
  if (hasDockerfile) {
    const head = await sandbox.runCommand({
      cmd: 'head',
      args: ['-n', '1', `${SANDBOX_ROOT}/Dockerfile`],
      timeoutMs: 10_000,
      maxBytes: 4 * 1024,
    });
    dockerfileFirstLine = head.exitCode === 0 ? head.stdout.replace(/\n$/, '') : '';

    // A real, user-authored Dockerfile wins outright and needs nothing else
    // inspected — a repo that happens to also carry a `package.json` (build
    // tooling config, not the app itself) must never have that fact read,
    // let alone acted on, once its own Dockerfile has already settled the
    // question.
    if (dockerfileFirstLine !== GENERATED_DOCKERFILE_MARKER) {
      return { ok: true };
    }
  }

  const hasPackageJson = await fileExists(sandbox, `${SANDBOX_ROOT}/package.json`);
  if (hasPackageJson === 'inspect_failed') {
    return { ok: false, reason: 'inspect_failed', detail: 'could not check for a package.json at the environment root' };
  }

  const hasIndexHtml = await fileExists(sandbox, `${SANDBOX_ROOT}/index.html`);
  if (hasIndexHtml === 'inspect_failed') {
    return { ok: false, reason: 'inspect_failed', detail: 'could not check for an index.html at the environment root' };
  }

  let packageJson: SourceRootListing['packageJson'] = null;
  if (hasPackageJson) {
    const cat = await sandbox.runCommand({
      cmd: 'cat',
      args: [`${SANDBOX_ROOT}/package.json`],
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
    });
    packageJson = cat.exitCode === 0 ? parsePackageJson(cat.stdout) : {};
  }

  const plan = planDockerfileSynthesis({
    dockerfileFirstLine,
    hasIndexHtml,
    packageJson,
  });

  if (plan.action === 'use_existing') return { ok: true };
  if (plan.action === 'refuse') return { ok: false, reason: plan.reason };

  try {
    await sandbox.writeFiles([
      { path: `${SANDBOX_ROOT}/Dockerfile`, content: plan.dockerfile },
      { path: `${SANDBOX_ROOT}/.dockerignore`, content: plan.dockerignore },
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: 'inspect_failed',
      detail: error instanceof Error ? error.message : 'failed to write synthesized Dockerfile',
    };
  }

  return { ok: true };
}

/**
 * `test -f <path>` inside the sandbox — exit 0 means present, exit 1 means
 * absent, anything else (timeout, sandbox error) is `'inspect_failed'` rather
 * than silently treated as "absent," which would route a genuinely
 * uninspectable root into synthesis instead of refusing honestly.
 */
async function fileExists(sandbox: ExecutableSandbox, path: string): Promise<boolean | 'inspect_failed'> {
  const result = await sandbox.runCommand({
    cmd: 'test',
    args: ['-f', path],
    timeoutMs: 10_000,
    maxBytes: 1024,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return 'inspect_failed';
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
