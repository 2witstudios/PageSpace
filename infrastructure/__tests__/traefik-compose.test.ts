import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const COMPOSE_PATH = resolve(__dirname, '../docker-compose.traefik.yml');

interface ComposeService {
  image?: string;
  ports?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string> | string[];
  labels?: string[] | Record<string, string>;
  restart?: string;
  command?: string | string[];
  security_opt?: string[];
  deploy?: { resources?: { limits?: { memory?: string } } };
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, { external?: boolean }>;
  volumes?: Record<string, { driver?: string } | null>;
}

function loadCompose(): ComposeFile {
  const raw = readFileSync(COMPOSE_PATH, 'utf-8');
  return parse(raw) as ComposeFile;
}

describe('Traefik docker-compose configuration', () => {
  const compose = loadCompose();

  describe('traefik service', () => {
    it('given docker-compose.traefik.yml, should define a traefik service', () => {
      expect(compose.services.traefik).toBeDefined();
    });

    it('given the traefik container, should use a traefik v3 image', () => {
      expect(compose.services.traefik.image).toMatch(/^traefik:v3/);
    });

    it('given port bindings, should expose port 80 on the host', () => {
      const ports = compose.services.traefik.ports ?? [];
      const has80 = ports.some((p: string) => p.includes('80:80'));
      expect(has80).toBe(true);
    });

    it('given port bindings, should expose port 443 on the host', () => {
      const ports = compose.services.traefik.ports ?? [];
      const has443 = ports.some((p: string) => p.includes('443:443'));
      expect(has443).toBe(true);
    });
  });

  describe('volume mounts', () => {
    it('given the traefik container, should mount docker socket read-only', () => {
      const volumes = compose.services.traefik.volumes ?? [];
      const socketMount = volumes.find((v: string) => v.includes('/var/run/docker.sock'));
      expect(socketMount).toBeDefined();
      expect(socketMount).toContain(':ro');
    });

    it('given the traefik container, should mount persistent volume for acme.json cert storage', () => {
      const volumes = compose.services.traefik.volumes ?? [];
      const acmeMount = volumes.find((v: string) => v.includes('letsencrypt'));
      expect(acmeMount).toBeDefined();
    });

    it('given the traefik container, should mount the static config file', () => {
      const volumes = compose.services.traefik.volumes ?? [];
      const configMount = volumes.find((v: string) => v.includes('traefik.yml'));
      expect(configMount).toBeDefined();
      expect(configMount).toContain(':ro');
    });
  });

  describe('networking', () => {
    it('given the traefik container, should join the traefik external network', () => {
      const serviceNetworks = compose.services.traefik.networks;
      if (Array.isArray(serviceNetworks)) {
        expect(serviceNetworks).toContain('traefik');
      } else {
        expect(serviceNetworks).toHaveProperty('traefik');
      }
    });

    it('given the network definition, traefik network should be external', () => {
      expect(compose.networks?.traefik).toBeDefined();
      expect(compose.networks!.traefik.external).toBe(true);
    });
  });

  describe('container hardening', () => {
    it('given the traefik container, should prevent privilege escalation', () => {
      const securityOpt = compose.services.traefik.security_opt ?? [];
      expect(securityOpt).toContain('no-new-privileges:true');
    });

    it('given the traefik container, should enforce a memory limit', () => {
      const memLimit = compose.services.traefik.deploy?.resources?.limits?.memory;
      expect(memLimit).toBeDefined();
    });
  });

  describe('tenant isolation', () => {
    it('given the compose file, should NOT contain any tenant-specific configuration', () => {
      const raw = readFileSync(COMPOSE_PATH, 'utf-8');
      // Should not hardcode any tenant slugs
      expect(raw).not.toMatch(/slug|tenant[_-]?\d|customer[_-]?\d/i);
    });
  });

  describe('wildcard TLS certificate', () => {
    it('given the dashboard router, should request a wildcard cert for *.pagespace.ai', () => {
      const labels = compose.services.traefik.labels ?? [];
      const labelsArr = Array.isArray(labels) ? labels : Object.entries(labels).map(([k, v]) => `${k}=${v}`);
      const hasMain = labelsArr.some((l: string) => l.includes('tls.domains[0].main=pagespace.ai'));
      const hasSans = labelsArr.some((l: string) => l.includes('tls.domains[0].sans=*.pagespace.ai'));
      expect(hasMain).toBe(true);
      expect(hasSans).toBe(true);
    });
  });

  describe('environment', () => {
    it('given the traefik container, should pass CF_DNS_API_TOKEN via environment', () => {
      const env = compose.services.traefik.environment;
      if (Array.isArray(env)) {
        const hasCfToken = env.some((e: string) => e.includes('CF_DNS_API_TOKEN'));
        expect(hasCfToken).toBe(true);
      } else if (env) {
        expect(env).toHaveProperty('CF_DNS_API_TOKEN');
      } else {
        // environment must be defined
        expect(env).toBeDefined();
      }
    });
  });
});
