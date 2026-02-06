# Review Vector: Dependency Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `*/package.json`, `pnpm-lock.yaml`
**Level**: cross-cutting

## Context
The pnpm workspace manages dependencies across multiple apps and packages, with Turbo handling the build graph. Review that dependency versions are consistent where packages share the same library, that no unnecessary duplicates exist in the lockfile, and that dependencies with known security advisories are flagged. Verify that dev dependencies are not accidentally bundled into production builds.
