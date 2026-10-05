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
  env_file?: string;
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

  it('given the runner stage, should report health from /imago/api/health', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK .*http:\/\/127\.0\.0\.1:3006\/imago\/api\/health/m);
    // Docker sets HOSTNAME to the container id; the standalone server binds to it.
    expect(dockerfile).toMatch(/^ENV HOSTNAME=0\.0\.0\.0$/m);
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

  it('should get no database credentials or .env (imago holds no state of its own)', () => {
    expect(imago).not.toHaveProperty('env_file');
    expect((imago.environment ?? []).some((e) => e.startsWith('DATABASE_URL='))).toBe(false);
  });

  it('should reach web over the internal network and realtime at its public URL', () => {
    expect(imago.environment).toContain('WEB_APP_INTERNAL_URL=http://web:3000');
    expect(imago.environment).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.build?.args).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.networks).toEqual(expect.arrayContaining(['internal', 'frontend']));
  });
});

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface Workflow {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>;
  jobs: Record<string, { steps?: WorkflowStep[] } & Record<string, unknown>>;
}

const readWorkflow = (file: string): Workflow => parse(read(`.github/workflows/${file}`)) as Workflow;

describe('docker-images.yml imago', () => {
  const workflow = readWorkflow('docker-images.yml');

  it('should still carry the deploy-fly job the guard below inspects', () => {
    expect(Object.keys(workflow.jobs)).toContain('deploy-fly');
  });

  it('should mention imago only in build-and-push — no job deploys it (production routing is human-only, IMG-11.1)', () => {
    const jobsMentioningImago = Object.entries(workflow.jobs)
      .filter(([, job]) => /imago/i.test(JSON.stringify(job)))
      .map(([name]) => name);
    expect(jobsMentioningImago).toEqual(['build-and-push']);
  });
});

describe('imago-image.yml (PR proof that the image builds and boots)', () => {
  const workflow = readWorkflow('imago-image.yml');
  const pr = workflow.on.pull_request;
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const buildStep = steps.find((s) => s.uses?.startsWith('docker/build-push-action'));

  it('given a pull request to pu/imago touching an imago build input, should run', () => {
    expect(pr?.branches).toContain('pu/imago');
    expect(pr?.paths).toEqual(
      expect.arrayContaining([
        'apps/imago/**',
        'apps/*/Dockerfile*',
        'packages/**',
        'package.json',
        'bun.lock',
        '.github/workflows/imago-image.yml',
      ]),
    );
  });

  it('should build apps/imago/Dockerfile from the repo root, cached, without pushing', () => {
    expect(buildStep).toBeDefined();
    expect(buildStep!.with).toMatchObject({ context: '.', file: 'apps/imago/Dockerfile', push: false, load: true });
    expect(buildStep!.with?.['cache-from']).toBeDefined();
    expect(buildStep!.with?.['cache-to']).toBeDefined();
  });

  it('should never log in to a registry or deploy', () => {
    expect(steps.some((s) => s.uses?.startsWith('docker/login-action'))).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/flyctl|secrets\./);
  });

  it('should boot the built image on 3006 and require /imago/api/health to answer', () => {
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toMatch(/docker run [^\n]*-p 3006:3006/);
    expect(runs).toMatch(/curl [^\n]*--fail[^\n]*http:\/\/localhost:3006\/imago\/api\/health/);
  });
});
