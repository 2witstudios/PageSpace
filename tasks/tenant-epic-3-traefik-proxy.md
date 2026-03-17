# Traefik Reverse Proxy Setup Epic

**Status**: IN PROGRESS (PR #798)
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
- Given the Traefik API, should NOT expose an insecure HTTP dashboard (`api.insecure: false`)

**TDD Approach**:
- Write config validation tests (`infrastructure/__tests__/traefik-config.test.ts`)
- Parse YAML config and assert: entrypoints include `web` (80) and `websecure` (443), certResolver uses `dns-01`, Docker provider `watch` is `true`
- Given the static config, should define `acme` storage path for certificate persistence
- Given the DNS provider config, should reference env var `CF_DNS_API_TOKEN` (not hardcoded)

**Key files created**:
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
- Given container hardening, should set `no-new-privileges:true` and a memory limit
- Given the dashboard router, should declare `tls.domains[0].main=pagespace.ai` and `tls.domains[0].sans=*.pagespace.ai` for wildcard cert issuance (without this, Traefik issues per-subdomain certs which hit Let's Encrypt rate limits)
- Given new env vars (`CF_DNS_API_TOKEN`, `TRAEFIK_DASHBOARD_AUTH`), should be documented in `infrastructure/.env.example`

**TDD Approach**:
- Write compose validation tests (`infrastructure/__tests__/traefik-compose.test.ts`)
- Parse YAML and assert: service `traefik` exists, image is `traefik:v3.*`, socket mount is `:ro`, `acme.json` volume persists, network `traefik` is external
- Given the compose file, should NOT contain any tenant-specific configuration
- Assert wildcard `tls.domains` labels are present on the dashboard router
- Assert `security_opt` includes `no-new-privileges:true` and `deploy.resources.limits.memory` is set

**Key files created**:
- `infrastructure/docker-compose.traefik.yml`
- `infrastructure/.env.example`

---

## Socket.IO Path Routing

Validate that Traefik routes `/socket.io` path to the realtime container without path stripping.

**Requirements**:
- Given a request to `https://{slug}.pagespace.ai/socket.io/`, should route to the realtime container on port 3001
- Given a request to `https://{slug}.pagespace.ai/` (all other paths), should route to the web container on port 3000
- Given WebSocket upgrade headers on `/socket.io/`, should pass through to realtime container
- Given the routing priority, should match `/socket.io` with higher priority than the catch-all web route

**TDD Approach (revised)**:

The original plan specified spinning up Traefik + 2 dummy containers and curling them. This was changed to label-template validation for two reasons:
1. Live container tests require Docker-in-Docker or a running Docker daemon in CI, adding infrastructure complexity for marginal validation benefit
2. Traefik's routing is fully determined by label structure — validating the labels validates the routing contract

Actual approach:
- Created `infrastructure/traefik/tenant-labels.yml` — a reference label template for tenant services
- Write label validation tests (`infrastructure/__tests__/traefik-routing.test.ts`)
- Parse the label template and assert: web service on port 3000 with Host rule, realtime on port 3001 with Host + PathPrefix(`/socket.io`), realtime has higher priority, no stripPrefix middleware on realtime route
- Traefik v3 handles WebSocket upgrades natively for HTTP routers — verified realtime labels don't interfere

**Key files created**:
- `infrastructure/traefik/tenant-labels.yml`

---

## TLS Wildcard Certificate

Configure DNS-01 challenge for wildcard cert issuance.

**Requirements**:
- Given Cloudflare DNS provider, should use `CF_DNS_API_TOKEN` env var for DNS record creation
- Given first startup, should request wildcard cert for `*.pagespace.ai`
- Given cert renewal (within 30 days of expiry), should auto-renew without downtime
- Given cert storage, should persist `acme.json` to a Docker volume so certs survive container restarts
- Given staging mode (`--certificatesresolvers.le.acme.caserver`), should use Let's Encrypt staging for testing

**Implementation note**: The wildcard cert is requested via explicit `tls.domains` labels on the dashboard router (the always-on router), not inferred from individual tenant Host rules. This avoids per-subdomain cert issuance that would hit Let's Encrypt rate limits.
