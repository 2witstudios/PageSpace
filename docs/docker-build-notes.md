# Docker Build Caching Notes (pnpm + Turbo Monorepo)

## Quick inventory (before changes)

- `apps/web/Dockerfile`: multi-stage (`deps` → `builder` → `runner`); `deps` ran `pnpm install` without a persistent pnpm store cache mount.
- `apps/web/Dockerfile.migrate`: single-stage; ran `pnpm install` without a persistent pnpm store cache mount.
- `apps/realtime/Dockerfile`: single-stage; ran `pnpm install` without a persistent pnpm store cache mount.
- `apps/processor/Dockerfile`: multi-stage; copied `packages/` source **before** `pnpm install` (frequent cache invalidation) and used `pnpm@latest` via Corepack.

`docker-compose.yml` builds these images from the repo root context (`context: .`).

## What changed

- Added BuildKit syntax to Dockerfiles using cache mounts: `# syntax=docker/dockerfile:1.6`.
- Pinned pnpm consistently via Corepack (`pnpm@10.13.1`) and removed any `pnpm@latest` usage.
- Every `pnpm install` now uses a persistent BuildKit cache mount for the pnpm store and sets `store-dir` to `/pnpm/store`:
  - `--mount=type=cache,id=pnpm-store,target=/pnpm/store`
- Reordered the processor Dockerfile so only manifest files are copied before dependency install; full source is copied **after** the install layer.
- Updated root `.dockerignore` to reduce context churn (`**/node_modules`, `**/.next`, `**/dist`, `.pnpm-store`, `.turbo`, etc.).

## Why caching now persists

- The pnpm content-addressable store is cached outside the image build using BuildKit cache mounts, so re-running installs reuses already-downloaded packages.
- Dependency installation layers are now based only on monorepo manifest files (lockfile + relevant `package.json` files), so normal source edits do not invalidate the install layer.

## What invalidates the dependency install layer

For each image, the `pnpm install` layer invalidates only when these copied inputs change:

- Root: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Workspace manifests copied in that Dockerfile (e.g. `apps/web/package.json`, `packages/db/package.json`, etc.)

## Remaining unavoidable cache invalidators (expected)

- Base image changes (e.g. `node:22.17.0-alpine` updates) or `apk add` lines changing will invalidate those layers.
- Any change to the files explicitly `COPY`'d before build steps (source code, configs) will re-run build layers (but should not re-run dependency install unless manifests changed).
