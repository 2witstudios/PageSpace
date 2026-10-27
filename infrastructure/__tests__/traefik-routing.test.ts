import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

/**
 * These tests validate that tenant Docker Compose labels
 * correctly configure Traefik routing for web and realtime services.
 *
 * We define a reference tenant compose snippet and validate the
 * label structure that Traefik uses for dynamic routing.
 */

const TEMPLATE_PATH = resolve(__dirname, '../traefik/tenant-labels.yml');

interface LabelSet {
  web: Record<string, string>;
  realtime: Record<string, string>;
}

function loadLabels(): LabelSet {
  const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
  return parse(raw) as LabelSet;
}

describe('Traefik routing labels for tenant services', () => {
  const labels = loadLabels();

  describe('web service routing', () => {
    it('given a request to https://{slug}.pagespace.ai/ (all other paths), should route to the web container on port 3000', () => {
      expect(labels.web['traefik.enable']).toBe('true');
      expect(labels.web['traefik.http.services.TENANT_SLUG-web.loadbalancer.server.port']).toBe('3000');
    });

    it('given the web route, should use the websecure entrypoint', () => {
      expect(labels.web['traefik.http.routers.TENANT_SLUG-web.entrypoints']).toBe('websecure');
    });

    it('given the web route, should use the LE certificate resolver', () => {
      expect(labels.web['traefik.http.routers.TENANT_SLUG-web.tls.certresolver']).toBe('le');
    });

    it('given the web route, should match the tenant subdomain via Host rule', () => {
      const rule = labels.web['traefik.http.routers.TENANT_SLUG-web.rule'];
      expect(rule).toContain('Host(`TENANT_SLUG.pagespace.ai`)');
    });
  });

  describe('realtime service routing', () => {
    it('given a request to https://{slug}.pagespace.ai/socket.io/, should route to the realtime container on port 3001', () => {
      expect(labels.realtime['traefik.enable']).toBe('true');
      expect(labels.realtime['traefik.http.services.TENANT_SLUG-realtime.loadbalancer.server.port']).toBe('3001');
    });

    it('given the realtime route, should use the websecure entrypoint', () => {
      expect(labels.realtime['traefik.http.routers.TENANT_SLUG-realtime.entrypoints']).toBe('websecure');
    });

    it('given the realtime route, should use the LE certificate resolver', () => {
      expect(labels.realtime['traefik.http.routers.TENANT_SLUG-realtime.tls.certresolver']).toBe('le');
    });

    it('given the realtime route, should match Host AND PathPrefix for /socket.io', () => {
      const rule = labels.realtime['traefik.http.routers.TENANT_SLUG-realtime.rule'];
      expect(rule).toContain('Host(`TENANT_SLUG.pagespace.ai`)');
      expect(rule).toContain('PathPrefix(`/socket.io`)');
    });

    it('given the routing priority, should match /socket.io with higher priority than the catch-all web route', () => {
      const realtimePriority = parseInt(
        labels.realtime['traefik.http.routers.TENANT_SLUG-realtime.priority'] ?? '0',
        10,
      );
      const webPriority = parseInt(
        labels.web['traefik.http.routers.TENANT_SLUG-web.priority'] ?? '0',
        10,
      );
      // Realtime must have higher priority (higher number = matched first)
      // OR web has no explicit priority (Traefik default is lower than explicit)
      if (webPriority > 0) {
        expect(realtimePriority).toBeGreaterThan(webPriority);
      } else {
        // If web has no explicit priority, realtime just needs one set
        expect(realtimePriority).toBeGreaterThan(0);
      }
    });
  });

  describe('WebSocket support', () => {
    it('given WebSocket upgrade headers on /socket.io/, should pass through to realtime container', () => {
      // Traefik v3 handles WebSocket upgrades natively for HTTP routers.
      // We just need to verify the realtime service is properly configured
      // with the correct port and no middleware stripping the path.
      expect(labels.realtime['traefik.http.services.TENANT_SLUG-realtime.loadbalancer.server.port']).toBe('3001');
      // Should NOT have a stripPrefix middleware on the realtime route
      const middlewareKey = Object.keys(labels.realtime).find((k) =>
        k.includes('stripprefix') || k.includes('stripPrefix'),
      );
      expect(middlewareKey).toBeUndefined();
    });
  });

  describe('template placeholders', () => {
    it('given the labels template, should use TENANT_SLUG as a placeholder for tenant substitution', () => {
      const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
      expect(raw).toContain('TENANT_SLUG');
    });
  });
});
