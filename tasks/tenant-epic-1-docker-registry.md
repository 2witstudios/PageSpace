# Docker Image Registry & CI Builds Epic

**Status**: PLANNED
**Goal**: Reusable, tagged Docker images for all PageSpace services in a container registry

## Overview

Per-tenant isolated infrastructure requires running the same Docker images with different env vars across many stacks. Today, images are built locally for a single compose stack. This epic establishes a CI pipeline that builds, tags, and pushes images to GitHub Container Registry so that any tenant stack can `docker pull` the exact same image. Without this, every tenant provisioning would require a full build on the VPS.

---

## CI Workflow for Image Builds

Create a GitHub Actions workflow that builds and pushes all service images on release tags and main branch pushes.

**Requirements**:
- Given a push to the `master` branch, should build and push images tagged `latest` and `sha-{short}`
- Given a semver tag push (e.g., `v1.2.3`), should build and push images tagged `latest`, `v1.2.3`, and `sha-{short}`
- Given the existing Dockerfiles (`apps/web/Dockerfile`, `apps/web/Dockerfile.migrate`, `apps/realtime/Dockerfile`, `apps/processor/Dockerfile`, `docker/cron/Dockerfile`), should build each as a separate image
- Given the image names `ghcr.io/pagespace/{web,realtime,processor,migrate,cron}`, should push all five to GHCR

**TDD Approach**:
- Write a dry-run validation script (`infrastructure/scripts/__tests__/validate-ci-config.test.ts`) that parses the workflow YAML and asserts: all 5 services are listed, tag patterns match expected regex, each service references the correct Dockerfile path
- Given a valid workflow file, should pass all structural assertions
- Given a missing service, should fail with descriptive error

---

## Image Runtime Env Verification Script

Create a script that verifies images work correctly with runtime-only env vars (no baked-in secrets).

**Requirements**:
- Given a web image started with `WEB_APP_URL=https://test.example.com`, should respond to health check at `/api/health`
- Given a realtime image started with `CORS_ORIGIN=https://test.example.com`, should respond to health check
- Given a processor image started with `FILE_STORAGE_PATH=/data/files`, should respond to health check at `/health`
- Given no `NEXT_PUBLIC_REALTIME_URL` baked in, should still boot without crash (validated in Epic 2)

**TDD Approach**:
- Write integration tests (`infrastructure/scripts/__tests__/image-runtime.test.ts`) that spin up containers with docker compose, wait for health, then assert
- Each test should be independently runnable and clean up its own containers
- Given a healthy container, should return 200 from health endpoint
- Given a container that fails to start, should timeout and report failure within 30s

---

## Registry Authentication Setup

Configure GHCR authentication for both CI pushes and VPS pulls.

**Requirements**:
- Given GitHub Actions workflow, should authenticate to GHCR using `GITHUB_TOKEN` (built-in)
- Given a VPS server, should be able to `docker pull ghcr.io/pagespace/web:latest` with a read-only PAT
- Given an unauthorized pull attempt, should fail with clear auth error
- Given the `.env` template for VPS, should include `REGISTRY_TOKEN` variable for pull authentication
