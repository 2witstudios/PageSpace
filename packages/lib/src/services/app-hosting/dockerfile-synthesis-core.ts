/**
 * dockerfile-synthesis-core — the pure decision half of D1's "a Dockerfile at
 * the root wins, else a default buildpack."
 *
 * "Buildpack" here is NOT an external buildpack system (no Cloud Native
 * Buildpacks, no `pack build`) — it is this module synthesizing a plain
 * Dockerfile for the two source shapes PageSpace can recognize on its own: a
 * Node app (a `package.json` at the root) and static content (an
 * `index.html` at the root with no `package.json`). Anything else is refused
 * — the caller is expected to surface that refusal BEFORE spending any work
 * snapshotting or uploading the source, per the founder's own framing: "tell
 * the user to add a Dockerfile," not silently fail deep in the build queue.
 *
 * Kept pure and fs-free on purpose (matching `provisioner-core.ts`/
 * `router-core.ts`'s split): the caller does the filesystem/sandbox I/O
 * (listing root entries, reading `package.json`) and this module only
 * decides. `materializeBuildSource` in the processor's
 * `app-build-runner.ts` still owns the actual "Dockerfile at root wins"
 * ENFORCEMENT (it throws if the materialized source has none) — this module
 * runs earlier, before that source even exists, so a Dockerfile is either
 * already there or gets synthesized in time to satisfy it.
 *
 * BOTH TEMPLATES TARGET `PUBLISHED_APP_INTERNAL_PORT`, not a stack's own
 * default. `buildMachineConfig` (`build-core.ts`) forwards that one fixed
 * port for every published app regardless of stack — a synthesized nginx
 * image left listening on its stock port 80 would build, push, and deploy
 * clean while being completely unreachable, since Fly only ever forwards to
 * the configured internal port.
 */

import { PUBLISHED_APP_INTERNAL_PORT } from './build-core';

export interface SourceRootListing {
  hasDockerfile: boolean;
  hasIndexHtml: boolean;
  /** `null` when there is no `package.json` at the root at all. */
  packageJson: { scripts?: Record<string, string>; main?: string } | null;
}

export type DockerfineSynthesisRefusalReason =
  | 'no_recognizable_source'
  | 'node_missing_start_command';

export type DockerfileSynthesisPlan =
  /** A Dockerfile is already at the root — D1 says it wins; nothing to synthesize. */
  | { action: 'use_existing' }
  | { action: 'synthesize'; dockerfile: string }
  | { action: 'refuse'; reason: DockerfineSynthesisRefusalReason };

const NODE_IMAGE_TAG = 'node:20-alpine';
const NGINX_IMAGE_TAG = 'nginx:alpine';

function synthesizeNodeDockerfile(pkg: { scripts?: Record<string, string>; main?: string }): DockerfileSynthesisPlan {
  const startCommand = pkg.scripts?.start
    ? ['npm', 'run', 'start']
    : pkg.main
      ? ['node', pkg.main]
      : null;

  if (startCommand === null) {
    // Neither a `start` script nor a `main` entry — there is no command this
    // synthesizer can honestly hand to `CMD`, and guessing one (`index.js`?)
    // would produce a container that fails at run time instead of at publish
    // time, which is a worse place for the user to find out.
    return { action: 'refuse', reason: 'node_missing_start_command' };
  }

  const buildStep = pkg.scripts?.build ? '\nRUN npm run build' : '';
  const cmdJson = JSON.stringify(startCommand);

  // `PORT` is also set on the machine's env by `buildMachineConfig`, but that
  // only helps an app that reads `process.env.PORT` — setting it here too
  // costs nothing and makes the image correct even run outside a published
  // machine (e.g. `docker run -p 8080:8080` while debugging one locally).
  const dockerfile = `FROM ${NODE_IMAGE_TAG}
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .${buildStep}
ENV PORT=${PUBLISHED_APP_INTERNAL_PORT}
EXPOSE ${PUBLISHED_APP_INTERNAL_PORT}
CMD ${cmdJson}
`;

  return { action: 'synthesize', dockerfile };
}

function synthesizeStaticDockerfile(): DockerfileSynthesisPlan {
  // nginx's stock `default.conf` listens on 80, which a container running
  // this image never gets traffic on — Fly forwards only to
  // `PUBLISHED_APP_INTERNAL_PORT`. The stock conf is replaced outright rather
  // than patched with `sed` against `listen 80;`, whose exact spacing/IPv6
  // variants are an upstream implementation detail this shouldn't depend on.
  const dockerfile = `FROM ${NGINX_IMAGE_TAG}
COPY . /usr/share/nginx/html
RUN printf 'server {\\n  listen ${PUBLISHED_APP_INTERNAL_PORT};\\n  root /usr/share/nginx/html;\\n  index index.html;\\n  location / {\\n    try_files \\$uri \\$uri/ /index.html;\\n  }\\n}\\n' > /etc/nginx/conf.d/default.conf
EXPOSE ${PUBLISHED_APP_INTERNAL_PORT}
`;
  return { action: 'synthesize', dockerfile };
}

/**
 * Decide what, if anything, to synthesize for a snapshot's root.
 *
 * Order matters and is exactly D1's: an existing Dockerfile always wins,
 * checked first and unconditionally — a repo that happens to also have a
 * `package.json` (e.g. tooling config, not the app itself) must never have
 * its real Dockerfile silently overridden by a Node guess.
 */
export function planDockerfileSynthesis(listing: SourceRootListing): DockerfileSynthesisPlan {
  if (listing.hasDockerfile) return { action: 'use_existing' };
  if (listing.packageJson) return synthesizeNodeDockerfile(listing.packageJson);
  if (listing.hasIndexHtml) return synthesizeStaticDockerfile();
  return { action: 'refuse', reason: 'no_recognizable_source' };
}
