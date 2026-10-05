/**
 * IMG-1.7: imago ships as its own image, beside classic apps/web.
 *
 * The Dockerfile mirrors apps/admin's (standalone Next server, non-root
 * runner) on port 3006; the local compose stack runs it wired to web (the
 * `/api/*` origin) and realtime (sockets). Production routing of /imago is
 * human-only (IMG-11.1), so the image workflow builds it but never deploys it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf-8');

interface ComposeService {
  build?: { context: string; dockerfile: string; args?: string[] };
  ports?: string[];
  depends_on?: Record<string, { condition: string }>;
  environment?: string[];
  networks?: string[];
}

describe('apps/imago/Dockerfile', () => {
  const dockerfile = read('apps/imago/Dockerfile');

  it('given the deps stage, should install from the frozen lockfile', () => {
    expect(dockerfile).toMatch(/^RUN .*bun install --frozen-lockfile$/m);
  });

  it('given the builder stage, should build the workspace packages imago imports before next build', () => {
    expect(dockerfile).toContain(
      "RUN bun run --filter '@pagespace/db' build && bun run --filter '@pagespace/lib' build && bun run --filter '@pagespace/editor' build",
    );
    expect(dockerfile).toMatch(/^RUN cd apps\/imago && .*bun run build$/m);
  });

  it('given the runner stage, should ship the standalone server and its static assets', () => {
    expect(dockerfile).toContain('COPY --from=builder /app/apps/imago/.next/standalone .');
    expect(dockerfile).toContain('COPY --from=builder /app/apps/imago/.next/static ./apps/imago/.next/static');
    expect(dockerfile).toContain('CMD ["node", "apps/imago/server.js"]');
  });

  it('given the runner stage, should listen on 3006 as the non-root node user', () => {
    expect(dockerfile).toMatch(/^EXPOSE 3006$/m);
    expect(dockerfile).toMatch(/^ENV PORT=3006$/m);
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});

describe('docker-compose.yml imago service', () => {
  const compose = parse(read('docker-compose.yml')) as { services: Record<string, ComposeService> };
  const imago = compose.services.imago;

  it('should exist', () => {
    expect(imago).toBeDefined();
  });

  it('should build from apps/imago/Dockerfile at the repo root', () => {
    expect(imago.build).toMatchObject({ context: '.', dockerfile: 'apps/imago/Dockerfile' });
  });

  it('should publish port 3006 and run the server on it', () => {
    expect(imago.ports).toEqual(['3006:3006']);
    expect(imago.environment).toContain('PORT=3006');
  });

  it('should start after web and realtime', () => {
    expect(Object.keys(imago.depends_on ?? {}).sort()).toEqual(['realtime', 'web']);
  });

  it('should reach web over the internal network and realtime at its public URL', () => {
    expect(imago.environment).toContain('WEB_APP_INTERNAL_URL=http://web:3000');
    expect(imago.environment).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.build?.args).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.networks).toEqual(expect.arrayContaining(['internal', 'frontend']));
  });
});

describe('docker-images.yml imago', () => {
  const workflow = read('.github/workflows/docker-images.yml');
  const deployJob = workflow.slice(workflow.indexOf('\n  deploy-fly:'));

  it('should not deploy imago (production routing is human-only, IMG-11.1)', () => {
    expect(deployJob.length).toBeGreaterThan(0);
    expect(deployJob).not.toMatch(/imago/);
  });
});
