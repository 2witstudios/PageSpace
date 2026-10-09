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

  it('given NEXT_PUBLIC_COOKIE_DOMAIN, should accept it as a build ARG (empty default) baked into the bundle before next build, as apps/web does (IMG-1.7a)', () => {
    const builder = dockerfile.slice(dockerfile.indexOf(' AS builder'), dockerfile.indexOf(' AS runner'));
    const arg = builder.indexOf('ARG NEXT_PUBLIC_COOKIE_DOMAIN=""\n');
    const env = builder.indexOf('ENV NEXT_PUBLIC_COOKIE_DOMAIN=$NEXT_PUBLIC_COOKIE_DOMAIN\n');
    const build = builder.search(/^RUN cd apps\/imago && .*bun run build$/m);
    expect(arg).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(arg);
    expect(build).toBeGreaterThan(env);
    // Same declaration as classic, so one build arg drives both apps.
    expect(read('apps/web/Dockerfile')).toContain('ARG NEXT_PUBLIC_COOKIE_DOMAIN=""\n');
  });

  it('given NEXT_PUBLIC_IMAGO_ENABLED, should be a web build ARG (default false) baked in before next build, like NEXT_PUBLIC_COOKIE_DOMAIN (IMG-10.7)', () => {
    const web = read('apps/web/Dockerfile');
    const builder = web.slice(web.indexOf(' AS builder'), web.indexOf(' AS runner'));
    const arg = builder.indexOf('ARG NEXT_PUBLIC_IMAGO_ENABLED="false"\n');
    const env = builder.indexOf('ENV NEXT_PUBLIC_IMAGO_ENABLED=$NEXT_PUBLIC_IMAGO_ENABLED\n');
    const build = builder.search(/^RUN .*bun run build/m);
    expect(arg).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(arg);
    expect(build).toBeGreaterThan(env);
  });

  it('given IMAGO_API_PROXY_ORIGIN, should accept it as a builder ARG (empty default) set before next build, which bakes rewrites into the routes manifest (IMG-10.9)', () => {
    const builder = dockerfile.slice(dockerfile.indexOf(' AS builder'), dockerfile.indexOf(' AS runner'));
    const arg = builder.indexOf('ARG IMAGO_API_PROXY_ORIGIN=""\n');
    const env = builder.indexOf('ENV IMAGO_API_PROXY_ORIGIN=$IMAGO_API_PROXY_ORIGIN\n');
    const build = builder.search(/^RUN cd apps\/imago && .*bun run build$/m);
    expect(arg).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(arg);
    expect(build).toBeGreaterThan(env);
  });

  it("given turbo's strict env mode, should declare IMAGO_API_PROXY_ORIGIN for imago's build so it reaches next build and keys the cache (IMG-10.9)", () => {
    const turbo = JSON.parse(read('apps/imago/turbo.json')) as { extends: string[]; tasks: { build?: { env?: string[] } } };
    expect(turbo.extends).toEqual(['//']);
    expect(turbo.tasks.build?.env).toContain('IMAGO_API_PROXY_ORIGIN');
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

  // getViewer() validates the session and the drive services read pages
  // straight from Postgres, so a signed-in render needs web's database.
  const entry = (service: ComposeService, name: string) =>
    (service.environment ?? []).find((e) => e.startsWith(`${name}=`));

  it("given signed-in renders, should reach web's database (IMG-10.9)", () => {
    const web = compose.services.web;
    expect(entry(web, 'DATABASE_URL')).toBeDefined();
    expect(entry(imago, 'DATABASE_URL')).toBe(entry(web, 'DATABASE_URL'));
  });

  it("given session and mode checks shared with web, should read the same .env values web does (IMG-10.9)", () => {
    // web reads these from env_file: .env; Compose interpolates ${VAR} from
    // the same project .env. Empty means the same default as unset.
    for (const name of ['DATABASE_SSL', 'DEPLOYMENT_MODE', 'SESSION_IDLE_TIMEOUT_MS', 'LOG_LEVEL']) {
      expect(entry(imago, name)).toBe(`${name}=\${${name}:-}`);
    }
    expect(compose.services.web.env_file).toBe('.env');
  });

  it('passes public storage, preview and standalone auth policy configuration without credentials', () => {
    for (const name of ['AWS_ENDPOINT_URL_S3', 'DEV_PREVIEW_ENABLED', 'DEV_PREVIEW_APEX']) {
      expect(entry(imago, name)).toBe(`${name}=\${${name}:-}`);
    }
    expect(entry(imago, 'BUCKET_NAME')).toBe('BUCKET_NAME=${BUCKET_NAME:-${TIGRIS_BUCKET:-${S3_BUCKET:-pagespace-files}}}');
    expect(imago.build?.args).toContain('NEXT_PUBLIC_WEB_APP_URL=${WEB_APP_URL:-http://localhost:3000}');
    expect(read('apps/imago/Dockerfile')).toContain('ENV NEXT_PUBLIC_WEB_APP_URL=$NEXT_PUBLIC_WEB_APP_URL');
  });

  it('should get no other credentials or the whole .env (imago reads no secrets) (IMG-10.9)', () => {
    expect(imago).not.toHaveProperty('env_file');
    expect((imago.environment ?? []).filter((e) => /ADMIN_|SECRET|KEY|PASSWORD|TOKEN/.test(e.split('=')[0]))).toEqual([]);
  });

  it('given no edge in front of it, should build the /api proxy to web into the image (IMG-10.9)', () => {
    expect(imago.build?.args).toContain('IMAGO_API_PROXY_ORIGIN=http://web:3000');
  });

  it('should reach web over the internal network and realtime at its public URL', () => {
    expect(imago.environment).toContain('WEB_APP_INTERNAL_URL=http://web:3000');
    expect(imago.environment).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.build?.args).toContain('NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}');
    expect(imago.networks).toEqual(expect.arrayContaining(['internal', 'frontend']));
  });

  it('given IMAGO_ENABLED in .env, should pass it to imago at runtime, off by default (IMG-10.7)', () => {
    expect(imago.environment).toContain('IMAGO_ENABLED=${IMAGO_ENABLED:-false}');
  });

  it('given NEXT_PUBLIC_IMAGO_ENABLED in .env, should bake it into the web build, off by default (IMG-10.7)', () => {
    expect(compose.services.web.build?.args).toContain('NEXT_PUBLIC_IMAGO_ENABLED=${NEXT_PUBLIC_IMAGO_ENABLED:-false}');
  });

  it('should bake the same cookie domain as the web service (IMG-1.7a)', () => {
    const web = compose.services.web;
    const cookieDomain = (args: string[] | undefined) =>
      args?.find((a) => a.startsWith('NEXT_PUBLIC_COOKIE_DOMAIN='));
    expect(cookieDomain(web.build?.args)).toBeDefined();
    expect(cookieDomain(imago.build?.args)).toBe(cookieDomain(web.build?.args));
  });
});

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface Workflow {
  on: Record<string, { branches?: string[]; paths?: string[]; tags?: string[] } | null>;
  jobs: Record<string, { steps?: WorkflowStep[] } & Record<string, unknown>>;
}

const readWorkflow = (file: string): Workflow => parse(read(`.github/workflows/${file}`)) as Workflow;

describe('docker-images.yml imago', () => {
  const workflow = readWorkflow('docker-images.yml');

  it('should still carry the deploy-fly job the guard below inspects', () => {
    expect(Object.keys(workflow.jobs)).toContain('deploy-fly');
  });

  it('given the edge routes /api to web in production, should build the published imago image without the /api proxy (IMG-10.9)', () => {
    expect(JSON.stringify(workflow)).not.toContain('IMAGO_API_PROXY_ORIGIN');
    expect(read('.github/workflows/imago-image.yml')).not.toContain('IMAGO_API_PROXY_ORIGIN');
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

  const push = workflow.on.push;
  // Everything apps/imago/Dockerfile COPYs, plus this workflow.
  const buildInputs = [
    'apps/imago/**',
    'apps/*/Dockerfile*',
    'apps/*/package.json',
    'packages/**',
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'types/**',
    '.github/workflows/imago-image.yml',
  ];

  it('given a pull request to a pu/* integration branch (pu/imago until it merges) touching an imago build input, should run', () => {
    expect(pr?.branches).toContain('pu/**');
    expect(pr?.branches).not.toContain('pu/imago');
    expect(pr?.paths).toEqual(expect.arrayContaining(buildInputs));
  });

  it('given a pull request to master touching an imago build input, should run, so a broken image fails the PR instead of skipping every deploy (IMG-10.7)', () => {
    expect(pr?.branches).toContain('master');
  });

  it('given a push to master touching an imago build input, should run (IMG-10.7)', () => {
    expect(push?.branches).toEqual(['master']);
    expect(push?.paths).toEqual(expect.arrayContaining(buildInputs));
    expect(push).not.toHaveProperty('tags');
  });

  it('given apps/imago/Dockerfile, should list every path it COPYs from the context as a trigger (IMG-10.7)', () => {
    const copied = read('apps/imago/Dockerfile')
      .split('\n')
      .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
      .flatMap((line) => line.slice('COPY '.length).trim().split(/\s+/).slice(0, -1));
    const matchesTrigger = (path: string) =>
      (pr?.paths ?? []).some((glob) => {
        const re = new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
        return re.test(path) || re.test(`${path}/x`);
      });
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.filter((path) => !matchesTrigger(path))).toEqual([]);
  });

  it('should build apps/imago/Dockerfile from the repo root, cached, without pushing', () => {
    expect(buildStep).toBeDefined();
    expect(buildStep!.with).toMatchObject({ context: '.', file: 'apps/imago/Dockerfile', push: false, load: true });
    expect(buildStep!.with?.['cache-from']).toBeDefined();
    expect(buildStep!.with?.['cache-to']).toBeDefined();
  });

  it('given a sentinel NEXT_PUBLIC_COOKIE_DOMAIN build arg, should require it in the built client bundle (IMG-1.7a)', () => {
    const args = String(buildStep!.with?.['build-args'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const arg = args.find((a) => a.startsWith('NEXT_PUBLIC_COOKIE_DOMAIN='));
    expect(arg).toBeDefined();
    const sentinel = arg!.slice('NEXT_PUBLIC_COOKIE_DOMAIN='.length);
    // A value no source file contains, so finding it proves the build inlined it.
    expect(sentinel).toMatch(/^\.[a-z0-9.-]+\.test$/);
    expect(read('apps/imago/src/lib/theme/theme-provider.tsx')).not.toContain(sentinel);
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain(`grep -rqF -- '${sentinel}' apps/imago/.next/static`);
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

describe('test.yml after pu/imago merges (IMG-10.7)', () => {
  const workflow = readWorkflow('test.yml');

  it('should name no branch that is deleted at the final merge', () => {
    expect(workflow.on.push?.branches).not.toContain('pu/imago');
    expect(workflow.on.pull_request?.branches).not.toContain('pu/imago');
  });

  it('given a PR into any pu/* integration branch (pu/imago until it merges), should still run the full suite', () => {
    expect(workflow.on.pull_request?.branches).toContain('pu/**');
  });
});

describe('imago-image.yml concurrency (IMG-10.7)', () => {
  it('should cancel superseded PR runs but never a master push run', () => {
    const raw = read('.github/workflows/imago-image.yml');
    expect(raw).toContain("group: imago-image-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}");
  });
});
