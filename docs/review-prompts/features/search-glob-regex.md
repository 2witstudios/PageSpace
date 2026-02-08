# Review Vector: Search with Glob and Regex

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/components/search/**`, `apps/web/src/app/api/search/**`
**Level**: domain

## Context
Search supports multi-drive queries with both regex and glob pattern matching, requiring careful input validation to prevent ReDoS attacks from malicious patterns. Results must be filtered through the permission system so users only see content they have access to across their drives. The frontend provides real-time search-as-you-type with debouncing and result highlighting that accurately reflects the matched pattern regions.
