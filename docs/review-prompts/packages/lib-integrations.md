# Review Vector: Lib Integrations Package

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- integrations.mdc
- security.mdc

## Scope
**Files**: `packages/lib/src/integrations/**`
**Level**: service

## Context
The integrations package manages connections to external services and third-party APIs including AI providers, storage backends, and communication platforms. Each integration must handle authentication, rate limiting, error responses, and graceful degradation when external services are unavailable. Review should verify that API keys and secrets are never hardcoded, that retry logic uses exponential backoff, and that external service failures do not cascade into application-wide outages.
