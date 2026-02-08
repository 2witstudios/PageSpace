# Review Vector: TypeScript Quality

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `**/*.ts`, `**/*.tsx`, `*/tsconfig.json`
**Level**: cross-cutting

## Context
The codebase enforces strict TypeScript across all packages and apps to catch errors at compile time and serve as living documentation. Review that no `any` types are used, that function signatures have explicit return types where appropriate, and that tsconfig strictness settings are consistent across the monorepo. Pay attention to type assertions that may mask underlying type safety issues.
