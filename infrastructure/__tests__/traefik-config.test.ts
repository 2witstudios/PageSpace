import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const CONFIG_PATH = resolve(__dirname, '../traefik/traefik.yml');

interface TraefikConfig {
  entryPoints: Record<string, { address: string; http?: { redirections?: { entryPoint?: { to: string; scheme: string } } } }>;
  certificatesResolvers?: Record<string, { acme: { email?: string; storage?: string; caServer?: string; dnsChallenge?: { provider: string; resolvers?: string[] } } }>;
  providers?: { docker?: { watch?: boolean; network?: string; exposedByDefault?: boolean; endpoint?: string } };
  api?: { dashboard?: boolean; insecure?: boolean };
  log?: { level?: string };
}

function loadConfig(): TraefikConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  return parse(raw) as TraefikConfig;
}

describe('Traefik static configuration', () => {
  const config = loadConfig();

  describe('entrypoints', () => {
    it('given the static config file, should define a web entrypoint on port 80', () => {
      expect(config.entryPoints.web).toBeDefined();
      expect(config.entryPoints.web.address).toBe(':80');
    });

    it('given the static config file, should define a websecure entrypoint on port 443', () => {
      expect(config.entryPoints.websecure).toBeDefined();
      expect(config.entryPoints.websecure.address).toBe(':443');
    });

    it('given HTTP traffic on port 80, should redirect to HTTPS', () => {
      const redirection = config.entryPoints.web.http?.redirections?.entryPoint;
      expect(redirection).toBeDefined();
      expect(redirection!.to).toBe('websecure');
      expect(redirection!.scheme).toBe('https');
    });
  });

  describe('certificate resolvers', () => {
    it('given HTTPS traffic, should use Let\'s Encrypt DNS-01 challenge for wildcard cert', () => {
      expect(config.certificatesResolvers?.le).toBeDefined();
      const acme = config.certificatesResolvers!.le.acme;
      expect(acme.dnsChallenge).toBeDefined();
      expect(acme.dnsChallenge!.provider).toBe('cloudflare');
    });

    it('given the static config, should define acme storage path for certificate persistence', () => {
      const acme = config.certificatesResolvers!.le.acme;
      expect(acme.storage).toBe('/letsencrypt/acme.json');
    });

    it('given the DNS provider config, should reference env var CF_DNS_API_TOKEN (not hardcoded)', () => {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      // The config should NOT contain an actual API token value
      expect(raw).not.toMatch(/CF_DNS_API_TOKEN\s*[:=]\s*[a-zA-Z0-9]{20,}/);
      // The Cloudflare provider uses CF_DNS_API_TOKEN env var automatically
      // Verify the provider is cloudflare (which reads from env)
      const acme = config.certificatesResolvers!.le.acme;
      expect(acme.dnsChallenge!.provider).toBe('cloudflare');
    });
  });

  describe('Docker provider', () => {
    it('given Docker provider enabled, should watch for container labels', () => {
      expect(config.providers?.docker).toBeDefined();
      expect(config.providers!.docker!.watch).toBe(true);
    });

    it('given Docker provider, should use the traefik network', () => {
      expect(config.providers!.docker!.network).toBe('traefik');
    });

    it('given Docker provider, should not expose containers by default', () => {
      expect(config.providers!.docker!.exposedByDefault).toBe(false);
    });
  });

  describe('dashboard', () => {
    it('given the Traefik dashboard, should be enabled', () => {
      expect(config.api?.dashboard).toBe(true);
    });

    it('given the Traefik API, should not expose insecure HTTP dashboard', () => {
      expect(config.api?.insecure).toBe(false);
    });
  });
});
