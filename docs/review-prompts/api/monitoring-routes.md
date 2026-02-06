# Review Vector: Monitoring & Health Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/monitoring/**/route.ts`, `apps/web/src/app/api/health/**/route.ts`, `apps/web/src/app/api/internal/**/route.ts`, `apps/web/src/app/api/pulse/**/route.ts`
**Level**: route

## Context
Monitoring routes expose per-metric dashboards, the health endpoint provides service liveness checks, internal routes handle metrics ingestion from other services in the cluster, and pulse routes generate and serve periodic system health summaries via cron triggers. The health endpoint is typically unauthenticated for load balancer probes, but monitoring and pulse endpoints contain sensitive operational data and must require admin or service-level authentication. The internal ingest endpoint accepts data from trusted services and must validate the source to prevent metric poisoning.
