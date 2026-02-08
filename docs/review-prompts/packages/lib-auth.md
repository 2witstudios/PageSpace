# Review Vector: Lib Auth Package

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- auth.mdc
- security.mdc

## Scope
**Files**: `packages/lib/src/auth/**`
**Level**: service

## Context
The lib auth package provides shared authentication primitives including JWT creation and verification, password hashing, token refresh logic, and session utilities consumed by the web app and other services. As a foundational security package, any change here propagates across the entire authentication surface. Review must verify cryptographic correctness, proper secret handling, token expiration enforcement, and that no authentication bypass paths are introduced.
