# Traefik Reverse Proxy Setup Epic

**Status**: COMPLETE
**Goal**: Wildcard subdomain routing with auto-TLS for tenant stacks via Traefik v3

## Overview

Each tenant gets a subdomain (`{slug}.pagespace.ai`) routing to their isolated Docker stack. Traefik v3 auto-discovers tenant containers via Docker labels, terminates TLS with a wildcard Let's Encrypt cert, and routes HTTP + WebSocket traffic to the right services. This replaces per-tenant nginx config with zero-touch auto-discovery.

---

## Traefik Static Config

Create the Traefik v3 static configuration file for wildcard routing.

**Requirements**:
- Given the static config file, should define entrypoints for HTTP (80) and HTTPS (443)
- Given HTTP traffic on port 80, should redirect to HTTPS
- Given HTTPS traffic, should use Let's Encrypt DNS-01 challenge for wildcard cert (`*.pagespace.ai`)
- Given Docker provider enabled, should watch for container labels on the `traefik` network
- Given the Traefik dashboard, should be accessible at a secure admin endpoint with basic auth

**TDD Approach**:
- Write config validation tests (`infrastructure/__tests__/traefik-config.test.ts`)
- Parse YAML config and assert: entrypoints include `web` (80) and `websecure` (443), certResolver uses `dns-01`, Docker provider `watch` is `true`
- Given the static config, should define `acme` storage path for certificate persistence
- Given the DNS provider config, should reference env var `CF_DNS_API_TOKEN` (not hardcoded)

**Key files to create**:
- `infrastructure/traefik/traefik.yml`

---

## Traefik Docker Compose

Create the Traefik service docker-compose file.

**Requirements**:
- Given `infrastructure/docker-compose.traefik.yml`, should define a Traefik v3 service
- Given the Traefik container, should mount `/var/run/docker.sock` read-only for container discovery
- Given the Traefik container, should mount a persistent volume for Let's Encrypt cert storage (`acme.json`)
- Given the Traefik container, should join a `traefik` external network that tenant stacks also join
- Given port bindings, should expose 80 and 443 on the host

**TDD Approach**:
- Write compose validation tests (`infrastructure/__tests__/traefik-compose.test.ts`)
- Parse YAML and assert: service `traefik` exists, image is `traefik:v3.*`, socket mount is `:ro`, `acme.json` volume persists, network `traefik` is external
- Given the compose file, should NOT contain any tenant-specific configuration

**Key files to create**:
- `infrastructure/docker-compose.traefik.yml`

---

## Socket.IO Path Routing

Validate that Traefik routes `/socket.io` path to the realtime container without path stripping.

**Requirements**:
- Given a request to `https://{slug}.pagespace.ai/socket.io/`, should route to the realtime container on port 3001
- Given a request to `https://{slug}.pagespace.ai/` (all other paths), should route to the web container on port 3000
- Given WebSocket upgrade headers on `/socket.io/`, should pass through to realtime container
- Given the routing priority, should match `/socket.io` with higher priority than the catch-all web route

**TDD Approach**:
- Write integration test (`infrastructure/__tests__/traefik-routing.test.ts`) using a mock tenant stack
- Spin up Traefik + 2 dummy HTTP containers (one for web, one for realtime), apply labels
- Given a curl to `http://localhost/socket.io/` with `Host: test.pagespace.ai`, should hit the realtime container
- Given a curl to `http://localhost/` with `Host: test.pagespace.ai`, should hit the web container
- Given a WebSocket handshake to `/socket.io/`, should upgrade successfully

---

## TLS Wildcard Certificate

Configure DNS-01 challenge for wildcard cert issuance.

**Requirements**:
- Given Cloudflare DNS provider, should use `CF_DNS_API_TOKEN` env var for DNS record creation
- Given first startup, should request wildcard cert for `*.pagespace.ai`
- Given cert renewal (within 30 days of expiry), should auto-renew without downtime
- Given cert storage, should persist `acme.json` to a Docker volume so certs survive container restarts
- Given staging mode (`--certificatesresolvers.le.acme.caserver`), should use Let's Encrypt staging for testing
