# Review Vector: Dependency Graph

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `*/package.json`, `*/tsconfig.json`, `turbo.json`
**Level**: architectural

## Context
The monorepo has layered dependencies: apps depend on packages, packages should not depend on apps, and shared packages (db, lib) form the foundation. Review whether the dependency graph is acyclic, whether tsconfig paths and package.json references align, and whether any package pulls in dependencies that belong to a different layer or service boundary.
