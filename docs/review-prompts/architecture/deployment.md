# Review Vector: Deployment

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `Dockerfile*`, `docker-compose*`, `scripts/**`
**Level**: architectural

## Context
PageSpace deploys as Docker containers on a Mac Studio, orchestrating the web app, realtime service, processor service, and PostgreSQL database as interconnected services. Review whether the Docker setup properly layers builds for cache efficiency, whether service orchestration handles startup ordering and health checks, and whether the deployment scripts are robust against partial failures.
