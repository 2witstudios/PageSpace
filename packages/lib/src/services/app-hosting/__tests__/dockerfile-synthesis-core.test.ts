import { describe, expect, it } from 'vitest';
import { planDockerfileSynthesis, type SourceRootListing } from '../dockerfile-synthesis-core';
import { PUBLISHED_APP_INTERNAL_PORT } from '../build-core';

function listing(overrides: Partial<SourceRootListing> = {}): SourceRootListing {
  return { hasDockerfile: false, hasIndexHtml: false, packageJson: null, ...overrides };
}

describe('planDockerfileSynthesis', () => {
  it('D1: an existing Dockerfile always wins, even alongside a package.json', () => {
    const plan = planDockerfileSynthesis(
      listing({ hasDockerfile: true, packageJson: { scripts: { start: 'node index.js' } } }),
    );
    expect(plan).toEqual({ action: 'use_existing' });
  });

  it('synthesizes a Node Dockerfile from package.json using scripts.start', () => {
    const plan = planDockerfileSynthesis(listing({ packageJson: { scripts: { start: 'node server.js' } } }));
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile).toContain('FROM node:20-alpine');
    expect(plan.dockerfile.replace(/\s/g, '')).toContain('CMD["npm","run","start"]');
    expect(plan.dockerfile).not.toContain('npm run build');
    expect(plan.dockerfile).toContain(`EXPOSE ${PUBLISHED_APP_INTERNAL_PORT}`);
  });

  it('includes a build step only when scripts.build exists', () => {
    const plan = planDockerfileSynthesis(
      listing({ packageJson: { scripts: { start: 'node server.js', build: 'tsc' } } }),
    );
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile).toContain('RUN npm run build');
  });

  it('falls back to `main` when there is no start script', () => {
    const plan = planDockerfileSynthesis(listing({ packageJson: { main: 'index.js' } } as SourceRootListing));
    expect(plan.action).toBe('synthesize');
    if (plan.action !== 'synthesize') throw new Error('expected synthesize');
    expect(plan.dockerfile.replace(/\s/g, '')).toContain('CMD["node","index.js"]');
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
  });

  it('refuses anything unrecognizable', () => {
    const plan = planDockerfileSynthesis(listing());
    expect(plan).toEqual({ action: 'refuse', reason: 'no_recognizable_source' });
  });
});
