# Review Vector: Type System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `packages/lib/src/types/**`, `packages/lib/src/types.ts`, `*/tsconfig.json`
**Level**: architectural

## Context
TypeScript strictness and shared type definitions are foundational to correctness across the monorepo. The project mandates no `any` types and explicit typing throughout. Review whether tsconfig strict mode is consistently enabled, whether shared types in packages/lib serve as the single source of truth, and whether type definitions accurately model the domain without resorting to escape hatches.
