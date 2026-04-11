# SIEM Connect Epic

**Status**: ✅ COMPLETED (2026-04-10)
**Goal**: Wire the existing SIEM adapter into production so audit events are delivered to external SIEM endpoints

## Overview

The full SIEM adapter is built (webhook + syslog, HMAC-signed, RFC 5424) at `apps/processor/src/services/siem-adapter.ts` but has zero production callers. Audit events go to the database only — no external SIEM delivery happens. This epic adds a cursor-based polling worker in the processor's pg-boss job system that periodically reads new audit events from `activity_logs`, transforms them, and delivers them to configured SIEM endpoints.

---

## DB Schema: siem_delivery_cursors

Add a cursor-tracking table to `packages/db/src/schema/monitoring.ts` and generate the migration.

**Requirements**:
- Given a new SIEM delivery system, should have a `siem_delivery_cursors` table to track the last delivered event per source
- Given cursor columns (id, lastDeliveredId, lastDeliveredAt, lastError, lastErrorAt, deliveryCount, updatedAt), should support tracking delivery position, errors, and throughput
- Given the schema change, should generate a Drizzle migration via `pnpm db:generate`

---

## Event Mapper Tests

Write failing tests for the event mapper before implementation (TDD).

**Requirements**:
- Given a complete activity_logs row, should map all fields to `AuditLogEntry` type from siem-adapter.ts
- Given null/optional fields (userId, aiProvider, etc.), should pass them through as-is
- Given an AI-generated entry, should preserve aiProvider, aiModel, and aiConversationId
- Given a batch of rows, should map all entries correctly

---

## Event Mapper Implementation

Create `apps/processor/src/services/siem-event-mapper.ts` to make the mapper tests pass.

**Requirements**:
- Given an activity_logs row, should produce a valid `AuditLogEntry` with timestamp as Date object
- Given enum fields (operation, resourceType), should cast them to strings

---

## Delivery Worker Tests

Write failing tests for the delivery worker before implementation (TDD).

**Requirements**:
- Given SIEM is disabled, should short-circuit with no DB queries
- Given an invalid SIEM config, should short-circuit with no delivery
- Given new activity_logs rows after the cursor, should deliver them via `deliverToSiemWithRetry`
- Given successful delivery, should update cursor with last delivered id, timestamp, and increment count
- Given failed delivery, should update cursor with lastError and lastErrorAt
- Given no new rows, should complete without error or delivery

---

## Delivery Worker Implementation

Create `apps/processor/src/workers/siem-delivery-worker.ts` to make worker tests pass.

**Requirements**:
- Given a configured SIEM, should read cursor from `siem_delivery_cursors` using raw pg Pool
- Given rows newer than cursor, should query `activity_logs` ordered by timestamp ASC with batch limit
- Given mapped entries, should call `deliverToSiemWithRetry()` from the existing siem-adapter
- Given the processor's DB pattern, should use raw SQL via `apps/processor/src/db.ts` — NOT Drizzle

---

## Queue Manager Integration

Wire the delivery worker into pg-boss scheduling via `queue-manager.ts` and update types.

**Requirements**:
- Given processor startup, should create a `siem-delivery` queue and register the worker
- Given pg-boss scheduling, should run the worker on a recurring ~30 second interval
- Given the `JobDataMap` type, should include `'siem-delivery': Record<string, never>` so `QueueName` includes it
- Given the `getQueueStatus()` method, should include `siem-delivery` in the status report

---

## Fix: MCP-WS Audit Semantics

**Requirements**:
- Given a WebSocket connection in mcp-ws/route.ts, should log a connection event rather than a data-access 'read'
- Given the SecurityAuditService API, should use `logEvent` with an appropriate event type (not `logDataAccess`)

---

## Fix: Admin Route Audit Coverage

**Requirements**:
- Given admin user listing (api/admin/users), should log a 'read' audit for user data access
- Given admin user data access (api/admin/users/[userId]/data), should log a 'read' audit
- Given admin user data export (api/admin/users/[userId]/export), should log an 'export' audit
- Given admin audit-log reads (api/admin/audit-logs), should log a 'read' audit

---

## Fix: File Access Route Audit Coverage

**Requirements**:
- Given a file download (api/files/[id]/download), should log a 'read' audit with file metadata
- Given a file view (api/files/[id]/view), should log a 'read' audit with file metadata

---

## Fix: Activity Route Audit Coverage

**Requirements**:
- Given activity listing (api/activities), should log a 'read' audit
- Given activity export (api/activities/export), should log an 'export' audit
- Given activity rollback (api/activities/[activityId]/rollback), should log a 'write' audit

---

## Fix: Medium-Priority Route Audit Coverage

**Requirements**:
- Given AI chat routes, should log appropriate audit events for message read/write
- Given channel message routes, should log audit events for message access
- Given DM/conversation routes, should log audit events for conversation access
- Given integration/connection routes, should log audit events for connection management
- Given calendar event routes, should log audit events for calendar access
- Given agent integration routes, should log audit events for grant management
- Given user preference routes, should log audit events for preference access

---

## Fix: Audit Wiring Tests

**Requirements**:
- Given each route group (search, workflow, trash, voice, mcp, admin, files, activities), should have at least one test verifying securityAudit.logDataAccess is called with correct arguments
- Given a route with audit logging, the test should mock securityAudit and verify it was called after a successful operation

---

## Fix: GDPR — Remove PII from audit details

The `details` field is included in the tamper-evident hash chain and cannot be erased under GDPR Article 17. User-typed search queries and filter user IDs must not appear in `details`.

**Requirements**:
- Given a search audit log, should not include the raw query text in details (could contain names/emails)
- Given a mentions search audit log, should not include the raw query text in details
- Given an admin audit-log read, should not include the filtered userId in details (PII of the queried user)
- Given any audit log details field, should only contain non-PII operational metadata (counts, types, sources)

---

## Health Check Enhancement

Add SIEM delivery status to the `/health` endpoint in `apps/processor/src/server.ts`.

**Requirements**:
- Given a health check request, should include SIEM config status (enabled, type)
- Given cursor data, should include lastDeliveredAt, lastError, and deliveryCount

---
