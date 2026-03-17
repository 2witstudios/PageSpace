# Operational Tooling Epic

**Status**: PLANNED
**Goal**: Day-2 operations for managing N tenant stacks: backups, health monitoring, rolling upgrades, and alerting

## Overview

Running 10-20 isolated tenant stacks requires operational automation. This epic builds the tools that the control plane uses for ongoing management: per-tenant backups, health polling, rolling upgrades across all tenants, and alerting when things go wrong. These are the tools that prevent 3am pager duty.

**Dependencies**: Epic 6d (control plane REST API)

---

## Per-Tenant Backup Service

Automated pg_dump + file storage backup per tenant, scheduled via control plane.

**Requirements**:
- Given a backup request for tenant slug, should run `pg_dump` against the tenant's postgres container and save to `backups/{slug}/{timestamp}.sql.gz`
- Given the backup, should also tar the tenant's file_storage volume to `backups/{slug}/{timestamp}-files.tar.gz`
- Given the backup completes, should record in `tenant_backups` table: path, size, status=completed, duration
- Given the backup fails, should record status=failed with error message
- Given a retention policy of 7 daily + 4 weekly, should prune old backups
- Given the backup schedule, should run daily for all active tenants (staggered, not all at once)
- Given a backup restore request, should be able to restore from any backup to a fresh tenant stack

**TDD Approach**:
- Write backup service tests (`apps/control-plane/src/services/__tests__/backup-service.test.ts`)
- Mock shell execution (docker exec pg_dump, tar)
- Given successful pg_dump, should record backup with status=completed and correct file path
- Given pg_dump failure (exit code 1), should record status=failed
- Given 10 daily backups and 7-day retention, should prune the 3 oldest
- Given backup restore, should call pg restore with correct flags

---

## Health Monitoring Service

Poll each tenant's health endpoint and update status in the registry.

**Requirements**:
- Given the health monitor, should poll `GET /api/health` on each active tenant every 5 minutes
- Given a healthy response (200), should update tenant healthStatus to `healthy`
- Given an unhealthy response (non-200 or timeout), should update to `unhealthy`
- Given 3 consecutive unhealthy checks, should trigger an alert
- Given a tenant recovering (unhealthy -> healthy), should record a `recovered` event
- Given a suspended tenant, should skip health checks
- Given the poll interval, should stagger requests across tenants to avoid burst

**TDD Approach**:
- Write health monitor tests (`apps/control-plane/src/services/__tests__/health-monitor.test.ts`)
- Mock HTTP client for health endpoint calls
- Given 3 active tenants, should make 3 health check requests
- Given healthy response, should call `updateHealthStatus(id, 'healthy')`
- Given unhealthy response 3 times in a row, should trigger alert callback
- Given suspended tenant in list, should skip without making request

---

## Rolling Upgrade Service

Upgrade all tenant stacks to a new image version with zero-downtime per tenant.

**Requirements**:
- Given an upgrade request with target image tag, should iterate all active tenants sequentially
- Given each tenant, should: pull new images, recreate containers one service at a time (migrate first, then web, then realtime, then processor), wait for health check after each service recreation
- Given a tenant upgrade failure, should stop the rollout, record error, and leave remaining tenants on old version
- Given a `--continue-on-error` flag, should skip failed tenants and continue
- Given the upgrade progress, should record events for each tenant: `upgrade_started`, `upgrade_completed`, or `upgrade_failed`
- Given a dry-run flag, should list what would change without executing

**TDD Approach**:
- Write upgrade service tests (`apps/control-plane/src/services/__tests__/upgrade-service.test.ts`)
- Mock docker compose commands
- Given 3 tenants and successful upgrades, should call docker compose for each in sequence
- Given 2nd tenant fails, should stop and not upgrade 3rd (default behavior)
- Given `--continue-on-error` and 2nd tenant fails, should continue to 3rd
- Given dry-run, should return plan without calling any docker commands

---

## Alerting Service

Notify operators when tenants have issues.

**Requirements**:
- Given a tenant unhealthy for 3+ consecutive checks, should send alert via configured channel
- Given alert channels, should support: email (via SMTP), Slack webhook, and stdout (for logging)
- Given an alert, should include: tenant slug, current status, duration of outage, last error message
- Given alert resolution (tenant recovers), should send recovery notification
- Given alert deduplication, should not re-alert for the same ongoing issue within 1 hour

**TDD Approach**:
- Write alerting tests (`apps/control-plane/src/services/__tests__/alerting-service.test.ts`)
- Mock email/Slack transports
- Given unhealthy tenant alert trigger, should call configured transport with alert payload
- Given same tenant still unhealthy within 1 hour, should NOT send duplicate alert
- Given same tenant still unhealthy after 1 hour, should re-alert
- Given tenant recovers, should send recovery notification

---

## Centralized Logging Configuration

Configure structured logging across tenant stacks.

**Requirements**:
- Given Docker log driver config in tenant compose, should use `json-file` with max-size=10MB and max-file=3
- Given a log aggregation script, should be able to tail logs for a specific tenant: `docker compose -p ps-{slug} logs -f --tail 100`
- Given the control plane, should log its own operations in structured JSON format
- Given tenant events, should be queryable via the control plane API

**TDD Approach**:
- Write logging config tests (`infrastructure/__tests__/logging-config.test.ts`)
- Parse tenant compose YAML and assert: all services have `logging.driver: json-file`, `logging.options.max-size: 10m`, `logging.options.max-file: "3"`
- Given the control plane logger, should output valid JSON with timestamp, level, and message fields
