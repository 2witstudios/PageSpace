import { describe, expect, it } from 'vitest';
import { planDockerfileSynthesis, GENERATED_DOCKERFILE_MARKER, type SourceRootListing } from '../dockerfile-synthesis-core';
import { PUBLISHED_APP_INTERNAL_PORT } from '../build-core';

function listing(overrides: Partial<SourceRootListing> = {}): SourceRootListing {
  return { dockerfileFirstLine: null, hasIndexHtml: false, packageJson: null, ...overrides };
}

describe('planDockerfileSynthesis', () => {
  it('D1: a user-authored Dockerfile always wins, even alongside a package.json', () => {
    const plan = planDockerfileSynthesis(
      listing({ dockerfileFirstLine: 'FROM ubuntu:22.04', packageJson: { scripts: { start: 'node index.js' } } }),
    );
    expect(plan).toEqual({ action: 'use_existing' });
  });

  it('regenerates over a Dockerfile that carries the generated marker (ours from a previous publish)', () => {
    const plan = planDockerfileSynthesis(
      listing({ dockerfileFirstLine: GENERATED_DOCKERFILE_MARKER, packageJson: { scripts: { start: 'node index.js' } } }),
    );
    expect(plan.action).toBe('synthesize');
  });

  it('keeps a marker-carrying Dockerfile as-is when nothing recognizable remains underneath it', () => {
    const plan = planDockerfileSynthesis(listing({ dockerfileFirstLine: GENERATED_DOCKERFILE_MARKER }));
    expect(plan).toEqual({ action: 'use_existing' });
  });

  it('synthesizes a Node Dockerfile from package.json using scripts.start', () => {
    const plan = planDockerfileSynthesis(listing({ packageJson: { scripts: { start: 'node server.js' } } }));
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    // Bun-only repository policy (CLAUDE.md: "bun only. Never npm/pnpm.") —
    // a generated image must not be the one place that reaches for npm.
    expect(plan.dockerfile).toContain('FROM oven/bun:1-alpine');
    expect(plan.dockerfile).not.toContain('node:20-alpine');
    expect(plan.dockerfile).toContain('RUN bun install');
    expect(plan.dockerfile).not.toContain('npm install');
    expect(plan.dockerfile.replace(/\s/g, '')).toContain('CMD["bun","run","start"]');
    expect(plan.dockerfile).not.toContain('npm run build');
    expect(plan.dockerfile).not.toContain('npm run start');
    expect(plan.dockerfile).toContain(`EXPOSE ${PUBLISHED_APP_INTERNAL_PORT}`);
    expect(plan.dockerfile.startsWith(GENERATED_DOCKERFILE_MARKER)).toBe(true);
    expect(plan.dockerfile).toContain('USER bun');
    expect(plan.dockerignore).toContain('node_modules');
    expect(plan.dockerignore).toContain('.env*');
    expect(plan.dockerignore).toContain('.git');
  });

  it('includes a build step only when scripts.build exists', () => {
    const plan = planDockerfileSynthesis(
      listing({ packageJson: { scripts: { start: 'node server.js', build: 'tsc' } } }),
    );
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile).toContain('RUN bun run build');
    expect(plan.dockerfile).not.toContain('npm run build');
  });

  it('falls back to `main` when there is no start script', () => {
    const plan = planDockerfileSynthesis(listing({ packageJson: { main: 'index.js' } } as SourceRootListing));
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile.replace(/\s/g, '')).toContain('CMD["bun","run","index.js"]');
  });

  it('refuses a Node source with neither a start script nor a main entry', () => {
    const plan = planDockerfileSynthesis(listing({ packageJson: { scripts: { build: 'tsc' } } }));
    expect(plan).toEqual({ action: 'refuse', reason: 'node_missing_start_command' });
  });

  it('synthesizes a static nginx Dockerfile when there is an index.html and no package.json', () => {
    const plan = planDockerfileSynthesis(listing({ hasIndexHtml: true }));
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile).toContain('FROM nginx:alpine');
    expect(plan.dockerfile).toContain('COPY . /usr/share/nginx/html');
    // The functional bug this guards against: nginx's stock conf listens on
    // 80, but Fly only ever forwards to PUBLISHED_APP_INTERNAL_PORT — a
    // Dockerfile that doesn't repoint nginx there builds and deploys clean
    // while being completely unreachable.
    expect(plan.dockerfile).toContain(`listen ${PUBLISHED_APP_INTERNAL_PORT};`);
    expect(plan.dockerfile).toContain(`EXPOSE ${PUBLISHED_APP_INTERNAL_PORT}`);
    expect(plan.dockerfile.startsWith(GENERATED_DOCKERFILE_MARKER)).toBe(true);
    expect(plan.dockerfile).toContain('USER nginx');
    expect(plan.dockerignore).toContain('node_modules');
  });

  it('refuses anything unrecognizable', () => {
    const plan = planDockerfileSynthesis(listing());
    expect(plan).toEqual({ action: 'refuse', reason: 'no_recognizable_source' });
  });
});
