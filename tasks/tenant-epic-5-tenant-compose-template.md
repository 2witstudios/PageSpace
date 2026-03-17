# Tenant Docker Compose Template Epic

**Status**: PLANNED
**Goal**: A parameterized docker-compose template that provisions a complete, isolated PageSpace stack per tenant

## Overview

Each tenant gets their own Docker Compose project (`ps-{slug}`) with dedicated postgres, redis, web, realtime, processor, and cron containers. The template is identical to the main `docker-compose.yml` but parameterized via `.env` files and annotated with Traefik labels for auto-discovery. This is the core infrastructure artifact that the control plane (Epic 6) will use to provision tenants.

**Dependencies**: Epic 1 (images from registry), Epic 3 (Traefik network for routing)

---

## Tenant Docker Compose File

Create a parameterized docker-compose template for tenant stacks.

**Requirements**:
- Given `infrastructure/docker-compose.tenant.yml`, should define the same services as the main `docker-compose.yml`: postgres, redis, redis-sessions, migrate, web, processor, realtime, cron
- Given image references, should use `ghcr.io/pagespace/{service}:${IMAGE_TAG:-latest}` instead of local builds
- Given the web service, should have Traefik labels: `traefik.http.routers.ps-${TENANT_SLUG}-web.rule=Host(\`${TENANT_SLUG}.pagespace.ai\`)` and TLS cert resolver
- Given the realtime service, should have Traefik labels routing `/socket.io` path with higher priority than web
- Given all services, should use `${TENANT_SLUG}` in container names and volume names for isolation
- Given the web service env, should set `DEPLOYMENT_MODE=tenant`
- Given the migrate service, should run with `service_completed_successfully` dependency (existing pattern)
- Given resource limits, should match the main compose: postgres 200MB, web 768MB, processor 1280MB, realtime 256MB, redis 160MB+96MB, cron 32MB
- Given the network config, should join both an `internal` bridge network and the external `traefik` network

**TDD Approach**:
- Write structural validation tests (`infrastructure/__tests__/tenant-compose.test.ts`)
- Parse the YAML and assert: all 8 services exist, image refs use `ghcr.io/pagespace/`, web has Traefik labels, all env vars reference `${...}` placeholders, network includes `traefik` as external
- Given the compose file, should NOT contain any hardcoded secrets or passwords
- Given the compose file, every secret should reference a `${VAR}` placeholder

---

## Tenant Env Template

Create a `.env` template file with all required variables for a tenant stack.

**Requirements**:
- Given `infrastructure/env.tenant.template`, should list every env var needed by the tenant compose
- Given secret variables (ENCRYPTION_KEY, CSRF_SECRET, JWT_SECRET, REDIS_PASSWORD, etc.), should have placeholder values like `__GENERATE__`
- Given tenant-specific vars (TENANT_SLUG, WEB_APP_URL, CORS_ORIGIN), should have placeholder values like `__SET_BY_PROVISIONER__`
- Given shared vars (IMAGE_TAG, DEPLOYMENT_MODE=tenant), should have sensible defaults
- Given the template, should include inline comments explaining each variable's purpose

**TDD Approach**:
- Write template validation tests (`infrastructure/__tests__/env-template.test.ts`)
- Parse the template and assert: every `${VAR}` referenced in the compose file has a corresponding entry, no `__GENERATE__` placeholders are empty, `DEPLOYMENT_MODE` defaults to `tenant`
- Given the compose file variables, should have 100% coverage in the template (no missing vars)

---

## Tenant Env Generator Script

Create a shell script that generates a complete `.env` for a specific tenant.

**Requirements**:
- Given `infrastructure/scripts/generate-tenant-env.sh {slug}`, should output a complete `.env` file to stdout
- Given the slug argument, should set `TENANT_SLUG`, `WEB_APP_URL=https://{slug}.pagespace.ai`, `CORS_ORIGIN=https://{slug}.pagespace.ai`
- Given secret generation, should generate cryptographically random values for ENCRYPTION_KEY (32 bytes hex), CSRF_SECRET (32 bytes hex), JWT_SECRET (64 bytes hex), REDIS_PASSWORD (24 bytes alphanumeric), POSTGRES_PASSWORD (24 bytes alphanumeric)
- Given the output, should be a valid `.env` file parseable by docker compose
- Given an optional `--image-tag` flag, should set IMAGE_TAG to the specified value

**TDD Approach**:
- Write script tests (`infrastructure/__tests__/generate-tenant-env.test.ts`)
- Run the script with a test slug, capture output, parse as `.env`
- Given output `.env`, should have no `__GENERATE__` or `__SET_BY_PROVISIONER__` remaining
- Given secret values, should all be unique (not reused across variables)
- Given secret values, should meet minimum length requirements (ENCRYPTION_KEY >= 32 chars, etc.)
- Given running the script twice, should generate different secrets each time

---

## Tenant Stack Lifecycle Script

Create a helper script for manual tenant stack management (used by control plane in Epic 6).

**Requirements**:
- Given `infrastructure/scripts/tenant-stack.sh up {slug}`, should `docker compose -p ps-{slug} -f docker-compose.tenant.yml --env-file tenants/{slug}/.env up -d`
- Given `infrastructure/scripts/tenant-stack.sh down {slug}`, should `docker compose -p ps-{slug} down`
- Given `infrastructure/scripts/tenant-stack.sh status {slug}`, should show container status for all services in the project
- Given `infrastructure/scripts/tenant-stack.sh health {slug}`, should curl the web health endpoint and report status
- Given `infrastructure/scripts/tenant-stack.sh upgrade {slug} {tag}`, should pull new images and recreate containers with zero-downtime (recreate one service at a time)
- Given a nonexistent slug, should exit with error code and message

**TDD Approach**:
- Write script tests (`infrastructure/__tests__/tenant-stack.test.ts`)
- Use a test slug with a minimal compose (just postgres + a health-check container)
- Given `up` command, should result in running containers detectable via `docker ps`
- Given `status` command, should output container names matching `ps-{slug}` prefix
- Given `down` command, should stop and remove all containers
- Given invalid slug, should exit with code 1
