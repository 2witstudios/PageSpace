import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const COMPOSE_PATH = resolve(__dirname, '../../docker-compose.yml');

interface ComposeService {
  image?: string;
  ports?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string> | string[];
  command?: string | string[];
  deploy?: { resources?: { limits?: { memory?: string } } };
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] | string; interval?: string; timeout?: string; retries?: number };
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

function getEnv(compose: ComposeFile, svc: string): Record<string, string> {
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

describe('Root (dev/self-host) docker-compose configuration', () => {
  const compose = loadCompose();

  describe('postgres-admin service (trust plane)', () => {
    it('given the root compose, should define the postgres-admin service', () => {
      expect(compose.services['postgres-admin']).toBeDefined();
    });

    it('given the postgres-admin service, should pin the SAME postgres image as the main postgres service', () => {
      expect(compose.services['postgres-admin'].image).toBe(compose.services.postgres.image);
    });

    it('given the postgres-admin service, should mount its own postgres_admin_data volume', () => {
      const vols = compose.services['postgres-admin'].volumes ?? [];
      expect(vols.some(v => v.startsWith('postgres_admin_data:'))).toBe(true);
    });

    it('given the compose file, should define the postgres_admin_data volume', () => {
      expect(compose.volumes).toHaveProperty('postgres_admin_data');
    });

    it('given the postgres-admin service, should use the pagespace_admin database name', () => {
      expect(getEnv(compose, 'postgres-admin').POSTGRES_DB).toBe('pagespace_admin');
    });

    it('given the postgres-admin service, should have a pg_isready healthcheck against pagespace_admin', () => {
      const test = compose.services['postgres-admin'].healthcheck?.test;
      const testStr = Array.isArray(test) ? test.join(' ') : test;
      expect(testStr).toContain('pg_isready');
      expect(testStr).toContain('pagespace_admin');
    });

    it('given the postgres-admin service, should join only the internal network', () => {
      const nets = compose.services['postgres-admin'].networks;
      if (Array.isArray(nets)) {
        expect(nets).toEqual(['internal']);
      } else {
        expect(Object.keys(nets ?? {})).toEqual(['internal']);
      }
    });

    it('given the postgres-admin service, should expose host port 5433 (documented in .env.onprem.example)', () => {
      const ports = compose.services['postgres-admin'].ports ?? [];
      expect(ports.some(p => String(p).startsWith('5433:'))).toBe(true);
    });

    it('given the postgres-admin service, should have the same memory limit as the main postgres service', () => {
      expect(compose.services['postgres-admin'].deploy?.resources?.limits?.memory)
        .toBe(compose.services.postgres.deploy?.resources?.limits?.memory);
    });
  });

  describe('migrate one-shot', () => {
    it('given the migrate service, should depend on both postgres and postgres-admin being healthy', () => {
      const deps = compose.services.migrate.depends_on;
      expect(deps?.postgres?.condition).toBe('service_healthy');
      expect(deps?.['postgres-admin']?.condition).toBe('service_healthy');
    });

    it('given the migrate service, should run db:migrate:admin after db:migrate', () => {
      const command = String(compose.services.migrate.command);
      expect(command).toContain('db:migrate:admin');
      expect(command.indexOf('db:migrate')).toBeLessThan(command.indexOf('db:migrate:admin'));
    });

    it('given the migrate service, should receive ADMIN_DATABASE_URL pointing at postgres-admin', () => {
      const url = getEnv(compose, 'migrate').ADMIN_DATABASE_URL;
      expect(url).toContain('@postgres-admin:5432/pagespace_admin');
    });

    it('given the migrate service, should run db:provision:admin-users after db:migrate:admin', () => {
      const command = String(compose.services.migrate.command);
      expect(command).toContain('db:provision:admin-users');
      expect(command.indexOf('db:migrate:admin')).toBeLessThan(
        command.indexOf('db:provision:admin-users'),
      );
    });

    it('given the migrate service, should receive all four per-service login passwords for provisioning', () => {
      const env = getEnv(compose, 'migrate');
      expect(env.ADMIN_APP_PASSWORD).toBeTruthy();
      expect(env.ADMIN_PROCESSOR_PASSWORD).toBeTruthy();
      expect(env.ADMIN_READER_PASSWORD).toBeTruthy();
      expect(env.ADMIN_ERASER_PASSWORD).toBeTruthy();
    });
  });

  describe('ADMIN_DATABASE_URL wiring (per-service least-privilege LOGINs, #890 Phase 2)', () => {
    // Owner/bootstrap credentials bypass the drizzle-admin/0001 zero-trust
    // grants, so only the migrate one-shot may hold them. Each runtime
    // service connects as its own LOGIN user attached to its role template:
    // web → admin_app, processor → admin_chainer+admin_siem, admin → admin_reader.
    const serviceLogins: [string, string, string][] = [
      ['web', 'admin_app_user', 'ADMIN_APP_PASSWORD'],
      ['processor', 'admin_processor_user', 'ADMIN_PROCESSOR_PASSWORD'],
      ['admin', 'admin_reader_user', 'ADMIN_READER_PASSWORD'],
    ];

    it.each(serviceLogins)(
      'given the %s service, ADMIN_DATABASE_URL should connect as %s at postgres-admin',
      (svc, loginUser) => {
        const url = getEnv(compose, svc).ADMIN_DATABASE_URL;
        expect(url).toContain(`://${loginUser}:`);
        expect(url).toContain('@postgres-admin:5432/pagespace_admin');
      },
    );

    it.each(serviceLogins)(
      'given the %s service, its login password should match the one migrate provisions via %s',
      (svc, loginUser, passwordVar) => {
        const url = getEnv(compose, svc).ADMIN_DATABASE_URL;
        const provisionPassword = getEnv(compose, 'migrate')[passwordVar];
        expect(url).toContain(`://${loginUser}:${provisionPassword}@`);
      },
    );

    it.each(serviceLogins.map(([svc]) => svc))(
      'given the %s service, should NOT connect to postgres-admin with the owner credentials',
      (svc) => {
        const url = getEnv(compose, svc).ADMIN_DATABASE_URL;
        const ownerUrl = getEnv(compose, 'migrate').ADMIN_DATABASE_URL;
        expect(url).not.toBe(ownerUrl);
        expect(url).not.toContain('://user:');
      },
    );

    it('given the realtime service, should NOT wire ADMIN_DATABASE_URL (no audit path in realtime)', () => {
      expect(getEnv(compose, 'realtime')).not.toHaveProperty('ADMIN_DATABASE_URL');
    });

    it('given the processor service, AUDIT_CHAINER_ALLOW_GENESIS should be true — the local stack is always a fresh install (empty admin chain, nothing to backfill; #890 Phase 2 era-fork guard)', () => {
      expect(getEnv(compose, 'processor').AUDIT_CHAINER_ALLOW_GENESIS).toBe('true');
    });

    // #890 Phase 2 leaf 6: the GDPR pseudonymization route (web) erases PII
    // on the trust plane as its own column-scoped identity.
    it('given the web service, ADMIN_ERASER_DATABASE_URL should connect as admin_gdpr_eraser_user with the password migrate provisions', () => {
      const url = getEnv(compose, 'web').ADMIN_ERASER_DATABASE_URL;
      const provisionPassword = getEnv(compose, 'migrate').ADMIN_ERASER_PASSWORD;
      expect(url).toContain(`://admin_gdpr_eraser_user:${provisionPassword}@`);
      expect(url).toContain('@postgres-admin:5432/pagespace_admin');
    });

    it.each(['admin', 'processor', 'realtime'])(
      'given the %s service, should NOT wire ADMIN_ERASER_DATABASE_URL (only the web GDPR route erases)',
      (svc) => {
        expect(getEnv(compose, svc)).not.toHaveProperty('ADMIN_ERASER_DATABASE_URL');
      },
    );

    it.each(['web', 'admin', 'processor', 'realtime'])(
      'given the %s service, should still receive DATABASE_URL pointing at the main postgres',
      (svc) => {
        const url = getEnv(compose, svc).DATABASE_URL;
        expect(url).toContain('@postgres:5432/pagespace');
      },
    );
  });
});
