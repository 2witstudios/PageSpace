# Review Vector: Monorepo Structure

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `turbo.json`, `pnpm-workspace.yaml`, `*/package.json`
**Level**: architectural

## Context
PageSpace is a pnpm workspace monorepo with Turbo build orchestration spanning five apps (web, realtime, processor, desktop) and two shared packages (db, lib). Package boundaries define what each service can import and how dependencies flow between them. Review whether the workspace configuration enforces clean boundaries, whether package.json dependencies are minimal and correct, and whether the monorepo structure supports independent development and deployment of each service.
