# Review Vector: Authentication Flows

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/**`, `packages/lib/src/auth/**`
**Level**: service

## Context
PageSpace implements custom JWT-based authentication with multiple entry points: email/password login, signup with verification, password reset, device authentication for mobile clients, and MCP token issuance for external tool integration. Each flow has its own security boundary and threat surface. Review how credentials are handled at every stage from submission through session establishment, paying attention to timing attacks, error message information leakage, and whether each flow correctly invalidates prior state on success.
