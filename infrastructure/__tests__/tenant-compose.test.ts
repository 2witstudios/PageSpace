import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const COMPOSE_PATH = resolve(__dirname, '../docker-compose.tenant.yml');

interface ComposeService {
  image?: string;
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string> | string[];
  labels?: string[] | Record<string, string>;
  restart?: string;
  command?: string | string[];
  security_opt?: string[];
  deploy?: { resources?: { limits?: { memory?: string } } };
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] | string; interval?: string; timeout?: string; retries?: number; start_period?: string };
  user?: string;
  read_only?: boolean;
  tmpfs?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, { external?: boolean; driver?: string; internal?: boolean }>;
  volumes?: Record<string, { driver?: string } | null>;
}

function loadCompose(): ComposeFile {
  const raw = readFileSync(COMPOSE_PATH, 'utf-8');
  return parse(raw) as ComposeFile;
}

function getRawYaml(): string {
  return readFileSync(COMPOSE_PATH, 'utf-8');
}

describe('Tenant docker-compose configuration', () => {
  const compose = loadCompose();

  describe('services', () => {
    const requiredServices = [
      'postgres', 'postgres-admin', 'migrate',
      'web', 'processor', 'realtime', 'cron',
    ];

    it.each(requiredServices)(
      'given the tenant compose, should define the %s service',
      (svc) => {
        expect(compose.services[svc]).toBeDefined();
      },
    );

    it('given the tenant compose, should define the processor-permissions init container', () => {
      expect(compose.services['processor-permissions']).toBeDefined();
    });

    const removedServices = ['redis', 'redis-sessions'];
    it.each(removedServices)(
      'given the tenant compose, should NOT define the %s service (Redis was deprecated)',
      (svc) => {
        expect(compose.services[svc]).toBeUndefined();
      },
    );
  });

  describe('image references', () => {
    const appImages: [string, string][] = [
      ['web', 'pagespace-web'],
      ['realtime', 'pagespace-realtime'],
      ['processor', 'pagespace-processor'],
      ['cron', 'pagespace-cron'],
      ['migrate', 'pagespace-migrate'],
    ];

    it.each(appImages)(
      'given the %s service, should use ghcr.io/2witstudios/%s image with IMAGE_TAG',
      (svc, imageName) => {
        const image = compose.services[svc].image;
        expect(image).toContain(`ghcr.io/2witstudios/${imageName}`);
        expect(image).toContain('${IMAGE_TAG:-latest}');
      },
    );

    it('given the processor-permissions service, should use the processor image', () => {
      const image = compose.services['processor-permissions'].image;
      expect(image).toContain('ghcr.io/2witstudios/pagespace-processor');
    });

    it('given the postgres service, should use postgres:17.5-alpine', () => {
      expect(compose.services.postgres.image).toBe('postgres:17.5-alpine');
    });

    it('given the postgres-admin service, should pin the SAME image as the main postgres service', () => {
      expect(compose.services['postgres-admin'].image).toBe(compose.services.postgres.image);
    });

    it('given the raw YAML, should not contain any redis image references', () => {
      expect(getRawYaml()).not.toMatch(/redis:/i);
    });
  });

  describe('resource limits', () => {
    const limits: [string, string][] = [
      ['postgres', '200M'],
      ['postgres-admin', '200M'],
      ['web', '768M'],
      ['processor', '1280M'],
      ['realtime', '256M'],
      ['cron', '32M'],
    ];

    it.each(limits)(
      'given the %s service, should have a memory limit of %s',
      (svc, mem) => {
        const limit = compose.services[svc].deploy?.resources?.limits?.memory;
        expect(limit).toBe(mem);
      },
    );
  });

  describe('dependencies', () => {
    it('given the migrate service, should depend on postgres being healthy', () => {
      const deps = compose.services.migrate.depends_on;
      expect(deps?.postgres?.condition).toBe('service_healthy');
    });

    it('given the migrate service, should depend on postgres-admin being healthy', () => {
      const deps = compose.services.migrate.depends_on;
      expect(deps?.['postgres-admin']?.condition).toBe('service_healthy');
    });

    it('given the migrate service, should run db:migrate:admin after db:migrate', () => {
      const command = String(compose.services.migrate.command);
      expect(command).toContain('db:migrate:admin');
      expect(command.indexOf('db:migrate')).toBeLessThan(command.indexOf('db:migrate:admin'));
    });

    it('given the web service, should depend on migrate completed and processor healthy only', () => {
      const deps = compose.services.web.depends_on;
      expect(deps?.migrate?.condition).toBe('service_completed_successfully');
      expect(deps?.processor?.condition).toBe('service_healthy');
      expect(deps?.redis).toBeUndefined();
      expect(deps?.['redis-sessions']).toBeUndefined();
    });

    it('given the processor service, should depend on migrate completed, postgres healthy, and processor-permissions completed (no redis deps)', () => {
      const deps = compose.services.processor.depends_on;
      expect(deps?.migrate?.condition).toBe('service_completed_successfully');
      expect(deps?.postgres?.condition).toBe('service_healthy');
      expect(deps?.['processor-permissions']?.condition).toBe('service_completed_successfully');
      expect(deps?.redis).toBeUndefined();
      expect(deps?.['redis-sessions']).toBeUndefined();
    });

    it('given the realtime service, should depend on migrate completed only (no redis deps)', () => {
      const deps = compose.services.realtime.depends_on;
      expect(deps?.migrate?.condition).toBe('service_completed_successfully');
      expect(deps?.redis).toBeUndefined();
      expect(deps?.['redis-sessions']).toBeUndefined();
    });

    it('given the cron service, should depend on web being started', () => {
      const deps = compose.services.cron.depends_on;
      expect(deps?.web?.condition).toBe('service_started');
    });
  });

  describe('Traefik labels on web', () => {
    function getLabels(svc: string): string[] {
      const labels = compose.services[svc].labels ?? [];
      return Array.isArray(labels)
        ? labels
        : Object.entries(labels).map(([k, v]) => `${k}=${v}`);
    }

    it('given the web service, should enable traefik', () => {
      expect(getLabels('web').some(l => l.includes('traefik.enable=true'))).toBe(true);
    });

    it('given the web service, should route by Host with TENANT_SLUG variable', () => {
      expect(getLabels('web').some(l => l.includes('Host(') && l.includes('${TENANT_SLUG}'))).toBe(true);
    });

    it('given the web service, should use websecure entrypoint', () => {
      expect(getLabels('web').some(l => l.includes('entrypoints=websecure'))).toBe(true);
    });

    it('given the web service, should use le certresolver', () => {
      expect(getLabels('web').some(l => l.includes('certresolver=le'))).toBe(true);
    });

    it('given the web service, should route to port 3000', () => {
      expect(getLabels('web').some(l => l.includes('port=3000') || l.includes('port: 3000'))).toBe(true);
    });
  });

  describe('Traefik labels on realtime', () => {
    function getLabels(svc: string): string[] {
      const labels = compose.services[svc].labels ?? [];
      return Array.isArray(labels)
        ? labels
        : Object.entries(labels).map(([k, v]) => `${k}=${v}`);
    }

    it('given the realtime service, should enable traefik', () => {
      expect(getLabels('realtime').some(l => l.includes('traefik.enable=true'))).toBe(true);
    });

    it('given the realtime service, should include PathPrefix for /socket.io', () => {
      expect(getLabels('realtime').some(l => l.includes('PathPrefix(`/socket.io`)'))).toBe(true);
    });

    it('given the realtime service, should have priority 100', () => {
      expect(getLabels('realtime').some(l => l.includes('priority=100'))).toBe(true);
    });

    it('given the realtime service, should route to port 3001', () => {
      expect(getLabels('realtime').some(l => l.includes('port=3001') || l.includes('port: 3001'))).toBe(true);
    });
  });

  describe('networks', () => {
    it('given the web service, should join both internal and traefik networks', () => {
      const nets = compose.services.web.networks;
      if (Array.isArray(nets)) {
        expect(nets).toContain('internal');
        expect(nets).toContain('traefik');
      } else {
        expect(nets).toHaveProperty('internal');
        expect(nets).toHaveProperty('traefik');
      }
    });

    it('given the realtime service, should join both internal and traefik networks', () => {
      const nets = compose.services.realtime.networks;
      if (Array.isArray(nets)) {
        expect(nets).toContain('internal');
        expect(nets).toContain('traefik');
      } else {
        expect(nets).toHaveProperty('internal');
        expect(nets).toHaveProperty('traefik');
      }
    });

    const internalOnly = ['postgres', 'postgres-admin', 'migrate', 'processor', 'cron'];

    it.each(internalOnly)(
      'given the %s service, should only join the internal network',
      (svc) => {
        const nets = compose.services[svc].networks;
        if (Array.isArray(nets)) {
          expect(nets).toContain('internal');
          expect(nets).not.toContain('traefik');
        } else {
          expect(nets).toHaveProperty('internal');
          expect(nets).not.toHaveProperty('traefik');
        }
      },
    );

    it('given the network definitions, traefik should be external', () => {
      expect(compose.networks?.traefik).toBeDefined();
      expect(compose.networks!.traefik.external).toBe(true);
    });

    it('given the network definitions, internal should be a bridge network', () => {
      expect(compose.networks?.internal).toBeDefined();
      expect(compose.networks!.internal.driver).toBe('bridge');
    });

    it('given the network definitions, internal should block outbound access', () => {
      expect(compose.networks!.internal.internal).toBe(true);
    });
  });

  describe('security', () => {
    it('given the processor service, should run as user 1000:1000', () => {
      expect(compose.services.processor.user).toBe('1000:1000');
    });

    it('given the processor service, should be read-only', () => {
      expect(compose.services.processor.read_only).toBe(true);
    });

    it('given the processor service, should mount tmpfs', () => {
      expect(compose.services.processor.tmpfs).toBeDefined();
      expect(compose.services.processor.tmpfs!.length).toBeGreaterThan(0);
    });

    it('given the processor service, should prevent privilege escalation', () => {
      const secOpt = compose.services.processor.security_opt ?? [];
      expect(secOpt).toContain('no-new-privileges:true');
    });
  });

  describe('no hardcoded secrets', () => {
    it('given the raw YAML, should not contain literal passwords or secrets', () => {
      const raw = getRawYaml();
      const lines = raw.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('#')) continue;
        if (/(?:PASSWORD|SECRET):\s+[^$\s{]/.test(line)) {
          expect.fail(`Found hardcoded secret in line: ${line.trim()}`);
        }
      }
    });

    it('given the raw YAML, should not contain env_file directive', () => {
      const raw = getRawYaml();
      expect(raw).not.toMatch(/env_file:/);
    });

    it('given the raw YAML, all secret references should use variable interpolation', () => {
      const raw = getRawYaml();
      const secretVars = ['ENCRYPTION_KEY', 'CSRF_SECRET', 'POSTGRES_PASSWORD', 'ADMIN_POSTGRES_PASSWORD'];
      for (const v of secretVars) {
        const lines = raw.split('\n').filter(l => !l.trim().startsWith('#'));
        for (const line of lines) {
          const assignMatch = line.match(new RegExp(`${v}:\\s+(.+)`));
          if (assignMatch) {
            const value = assignMatch[1].trim();
            expect(value).toMatch(/\$\{/);
          }
        }
      }
    });
  });

  describe('environment variables', () => {
    function getEnv(svc: string): Record<string, string> {
      const env = compose.services[svc].environment;
      if (!env) return {};
      if (Array.isArray(env)) {
        const result: Record<string, string> = {};
        for (const e of env) {
          const [k, ...v] = e.split('=');
          result[k] = v.join('=');
        }
        return result;
      }
      return env;
    }

    it('given the web service, should set DEPLOYMENT_MODE to tenant', () => {
      expect(getEnv('web').DEPLOYMENT_MODE).toBe('tenant');
    });

    it('given the web service, should set NEXT_PUBLIC_DEPLOYMENT_MODE to tenant', () => {
      expect(getEnv('web').NEXT_PUBLIC_DEPLOYMENT_MODE).toBe('tenant');
    });

    it('given the web service, should not include STRIPE vars', () => {
      const env = getEnv('web');
      const stripeKeys = Object.keys(env).filter(k => k.includes('STRIPE'));
      expect(stripeKeys).toHaveLength(0);
    });

    it('given the web service, should not include NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID', () => {
      const env = getEnv('web');
      expect(env).not.toHaveProperty('NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID');
    });

    it('given the web service, DATABASE_URL should reference internal postgres', () => {
      const dbUrl = getEnv('web').DATABASE_URL;
      expect(dbUrl).toContain('@postgres:');
      expect(dbUrl).toContain('${POSTGRES_PASSWORD');
    });

    const adminDbServices = ['web', 'processor', 'realtime', 'migrate'];

    it.each(adminDbServices)(
      'given the %s service, ADMIN_DATABASE_URL should reference internal postgres-admin with interpolated credentials',
      (svc) => {
        const url = getEnv(svc).ADMIN_DATABASE_URL;
        expect(url).toContain('@postgres-admin:');
        expect(url).toContain('${ADMIN_POSTGRES_PASSWORD');
      },
    );

    const redisEnvVars = ['REDIS_URL', 'REDIS_SESSION_URL', 'REDIS_RATE_LIMIT_URL', 'REDIS_PASSWORD'];
    const jwtEnvVars = ['JWT_SECRET', 'JWT_ISSUER', 'JWT_AUDIENCE'];
    const servicesWithEnv = Object.keys(compose.services).filter(
      (svc) => compose.services[svc].environment !== undefined,
    );

    it.each(servicesWithEnv.flatMap(svc => redisEnvVars.map(v => [svc, v] as const)))(
      'given the %s service, should NOT set %s (Redis was deprecated)',
      (svc, v) => {
        expect(getEnv(svc)).not.toHaveProperty(v);
      },
    );

    it.each(servicesWithEnv.flatMap(svc => jwtEnvVars.map(v => [svc, v] as const)))(
      'given the %s service, should NOT set %s (JWT is vestigial; auth uses opaque session tokens)',
      (svc, v) => {
        expect(getEnv(svc)).not.toHaveProperty(v);
      },
    );
  });

  describe('upgrade fail-fast for pre-Phase-1 .env files (admin DB credentials)', () => {
    // A tenant .env generated before Phase 1 has no ADMIN_POSTGRES_* vars.
    // Plain ${ADMIN_POSTGRES_PASSWORD} renders as "" (only a soft compose
    // warning) and postgres-admin never becomes healthy, silently wedging the
    // whole stack behind depends_on. The ${VAR:?message} required-var syntax
    // makes `docker compose` abort immediately with a message naming the
    // cause and the upgrade note instead.
    it('given the postgres-admin service, POSTGRES_PASSWORD should use required-var syntax pointing at infrastructure/UPGRADE.md', () => {
      const raw = getRawYaml();
      expect(raw).toMatch(
        /POSTGRES_PASSWORD: \$\{ADMIN_POSTGRES_PASSWORD:\?[^}]*infrastructure\/UPGRADE\.md[^}]*\}/,
      );
    });

    it('given every ADMIN_DATABASE_URL derivation, should use required-var syntax on the admin password', () => {
      const lines = getRawYaml()
        .split('\n')
        .filter((l) => !l.trim().startsWith('#') && l.includes('ADMIN_DATABASE_URL:'));
      expect(lines.length).toBeGreaterThanOrEqual(4); // web, processor, realtime, migrate
      for (const line of lines) {
        expect(line).toMatch(/\$\{ADMIN_POSTGRES_PASSWORD:\?/);
      }
    });

    it('given the comment block above the postgres-admin service, should link infrastructure/UPGRADE.md', () => {
      const lines = getRawYaml().split('\n');
      const svcIdx = lines.findIndex((l) => l.startsWith('  postgres-admin:'));
      expect(svcIdx).toBeGreaterThan(-1);
      const commentBlock: string[] = [];
      for (let i = svcIdx - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('#')) commentBlock.push(line);
        else if (line === '') continue;
        else break;
      }
      expect(commentBlock.join('\n')).toContain('infrastructure/UPGRADE.md');
    });
  });

  describe('healthchecks', () => {
    it('given the postgres service, should use pg_isready', () => {
      const test = compose.services.postgres.healthcheck?.test;
      const testStr = Array.isArray(test) ? test.join(' ') : test;
      expect(testStr).toContain('pg_isready');
    });

    it('given the postgres-admin service, should use pg_isready', () => {
      const test = compose.services['postgres-admin'].healthcheck?.test;
      const testStr = Array.isArray(test) ? test.join(' ') : test;
      expect(testStr).toContain('pg_isready');
    });

    it('given the processor service, should check HTTP health on port 3003', () => {
      const test = compose.services.processor.healthcheck?.test;
      const testStr = Array.isArray(test) ? test.join(' ') : test;
      expect(testStr).toContain('3003/health');
    });
  });

  describe('volumes', () => {
    const requiredVolumes = [
      'postgres_data',
      'postgres_admin_data',
      'file_storage',
      'cache_storage',
    ];

    it.each(requiredVolumes)(
      'given the compose file, should define the %s volume',
      (vol) => {
        expect(compose.volumes).toHaveProperty(vol);
      },
    );

    const removedVolumes = ['redis_data', 'redis_sessions_data'];
    it.each(removedVolumes)(
      'given the compose file, should NOT define the %s volume (Redis was deprecated)',
      (vol) => {
        expect(compose.volumes ?? {}).not.toHaveProperty(vol);
      },
    );
  });
});
