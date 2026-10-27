/**
 * image-builder — the Docker BuildKit shell: probe, login, build, push, measure.
 *
 * WHY WE BUILD AT ALL: Fly has no build API. `flyctl deploy` builds on the client
 * (or on a remote builder machine it manages for you) and pushes to
 * `registry.fly.io`; the Machines API only ever accepts an image reference. So the
 * only way a published app gets an image is that WE build it and push it, and this
 * module is that step.
 *
 * EVERY EXTERNAL CALL GOES THROUGH `BuilderRunner`. Nothing here imports
 * `child_process` at module scope, which is what lets the entire pipeline —
 * including the paths where the builder is missing, the login is rejected, and the
 * push half-succeeds — be tested without Docker, and lets `@pagespace/lib` stay
 * importable from environments that have no process-spawning at all.
 *
 * THE PUSHED ARTIFACT IS DELIBERATELY BORING: one platform, no provenance
 * attestation, no SBOM. Buildx defaults to attaching both, which turns the push
 * into an OCI INDEX — several manifests under one digest — and an index has no
 * single image size to record and no single manifest to read layer sizes from.
 * Disabling them keeps the push a plain manifest, which is what makes
 * `parseImageSizeBytes` answerable at all.
 */

import {
  buildTagFor,
  imageRepositoryFor,
  parseImageSizeBytes,
  parseManifestDigest,
} from './build-core';

/** What one external command produced. A non-zero (or null) code is a failure. */
export interface BuilderProcessResult {
  /** Exit code, or null when the process was killed (timeout, signal). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface BuilderRunOptions {
  /** Written to the process's stdin and closed. Used for `--password-stdin`. */
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * The one seam every subprocess goes through. Implementations must NEVER pass the
 * command through a shell — `spawn(cmd, args)` with an argument array, so a source
 * ref or an image tag cannot become shell syntax.
 */
export interface BuilderRunner {
  run(command: string, args: string[], options?: BuilderRunOptions): Promise<BuilderProcessResult>;
}

/** Build timeouts. A slim image is minutes; the ceiling is for a build gone wrong. */
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 60_000;

export type BuilderAvailability =
  | { available: true; version: string }
  | { available: false; detail: string };

/**
 * Is a BuildKit builder actually usable here?
 *
 * ASKED BEFORE ANY STATE IS MOVED, and that ordering is the whole feature. A
 * processor deployed without Docker — a developer's laptop, a container image
 * that never installed it, a host where the daemon is down — would otherwise fail
 * every build at the `docker build` call, which is indistinguishable from "this
 * user's Dockerfile is broken" and marks THEIR app `failed`. Probing first lets the
 * job report a BLOCKED build instead: the row stays `building`, nothing is marked
 * failed, and the reconciler re-queues it when a builder comes back.
 *
 * `docker buildx version` rather than `docker version`: BuildKit is the thing we
 * need, and a daemon that answers `version` can still have no buildx plugin.
 */
export async function probeBuilder(runner: BuilderRunner): Promise<BuilderAvailability> {
  let result: BuilderProcessResult;
  try {
    result = await runner.run('docker', ['buildx', 'version'], { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : 'docker could not be executed',
    };
  }
  if (result.code !== 0) {
    return {
      available: false,
      detail: (result.stderr || result.stdout || `docker buildx version exited ${result.code}`).trim(),
    };
  }
  return { available: true, version: result.stdout.trim() };
}

export class ImageBuildError extends Error {
  constructor(
    message: string,
    /** Which step failed — the stage a failed build reports and the reconciler logs. */
    public readonly stage: 'login' | 'build' | 'inspect',
  ) {
    super(message);
    this.name = 'ImageBuildError';
  }
}

/**
 * Authenticate to `registry.fly.io` with an app-scoped deploy token.
 *
 * The token arrives on STDIN (`--password-stdin`), never as an argv element.
 * Process arguments are world-readable on Linux (`/proc/<pid>/cmdline`) and land in
 * shell history and process listings; this credential has full machine CRUD on its
 * app and can mint its own successors indefinitely, so the difference is not
 * cosmetic. Fly's documented username for a deploy token is the literal `x`.
 */
export async function registryLogin(runner: BuilderRunner, token: string): Promise<void> {
  const result = await runner.run(
    'docker',
    ['login', 'registry.fly.io', '--username', 'x', '--password-stdin'],
    { stdin: token, timeoutMs: LOGIN_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    // Deliberately does not echo stdout/stderr wholesale into the message: a failed
    // docker login can echo back parts of what it was given.
    throw new ImageBuildError(
      `docker login registry.fly.io failed (exit ${result.code})`,
      'login',
    );
  }
}

export interface BuildAndPushInput {
  flyAppName: string;
  /** Directory containing the app source and its Dockerfile. */
  contextDir: string;
  /** Dockerfile path, relative to `contextDir` or absolute. */
  dockerfile: string;
  sourceRef: string;
  /** Defaults to `linux/amd64` — Fly's shared-cpu guests. */
  platform?: string;
  timeoutMs?: number;
}

export interface BuiltImage {
  digest: string;
  /** Registry size in bytes, or null when the manifest could not be measured. */
  sizeBytes: number | null;
}

/**
 * Build the app image and push it, then read back what was actually pushed.
 *
 * THE DIGEST IS READ FROM THE REGISTRY, not from the build's own output. A build
 * that reports success and a registry that holds the image are two different facts,
 * and the second is the one every subsequent machine create depends on. Inspecting
 * the pushed tag turns "the push claimed to work" into "the bytes are there under
 * this digest" — and a push that half-landed fails HERE, before any machine is
 * created from a reference that would 404 at boot.
 *
 * The tag is pushed for traceability; nothing ever boots from it (see
 * `pinnedImageRef`).
 */
export async function buildAndPush(
  runner: BuilderRunner,
  input: BuildAndPushInput,
): Promise<BuiltImage> {
  const repository = imageRepositoryFor(input.flyAppName);
  const taggedRef = `${repository}:${buildTagFor(input.sourceRef)}`;

  const build = await runner.run(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      input.platform ?? 'linux/amd64',
      '--file',
      input.dockerfile,
      '--tag',
      taggedRef,
      // See the module docblock: attestations would make this an OCI index.
      '--provenance=false',
      '--sbom=false',
      '--push',
      input.contextDir,
    ],
    { cwd: input.contextDir, timeoutMs: input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS },
  );
  if (build.code !== 0) {
    throw new ImageBuildError(
      `Image build failed (exit ${build.code}): ${tail(build.stderr || build.stdout)}`,
      'build',
    );
  }

  const descriptor = await runner.run(
    'docker',
    ['buildx', 'imagetools', 'inspect', taggedRef, '--format', '{{json .Manifest}}'],
    { timeoutMs: INSPECT_TIMEOUT_MS },
  );
  if (descriptor.code !== 0) {
    throw new ImageBuildError(
      `Could not inspect the pushed image (exit ${descriptor.code}): ${tail(descriptor.stderr)}`,
      'inspect',
    );
  }
  const digest = parseManifestDigest(descriptor.stdout);
  if (digest === null) {
    throw new ImageBuildError(
      'The pushed image reported no usable sha256 digest; refusing to pin an unverified image',
      'inspect',
    );
  }

  return { digest, sizeBytes: await measureImage(runner, repository, digest) };
}

/**
 * The pushed image's size, or null.
 *
 * NEVER THROWS, and that is the contract: the size is a cost signal for the
 * economics dashboard, and a registry hiccup while measuring it must not fail a
 * deploy whose image is already pushed and verified. A missing size is a gap in a
 * chart; a failed deploy over one is an outage.
 */
async function measureImage(
  runner: BuilderRunner,
  repository: string,
  digest: string,
): Promise<number | null> {
  try {
    const manifest = await runner.run(
      'docker',
      ['buildx', 'imagetools', 'inspect', `${repository}@${digest}`, '--raw'],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    );
    if (manifest.code !== 0) return null;
    return parseImageSizeBytes(manifest.stdout);
  } catch {
    return null;
  }
}

/** Last 2KB of a tool's output — enough to diagnose, bounded enough to store. */
function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
}
