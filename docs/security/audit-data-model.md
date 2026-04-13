# Three-Table Audit Data Model

> **Purpose:** Answer the question "which table do I write this event to?"
> in one page. PageSpace has **three** log tables with deliberately
> distinct purposes. This doc exists so that future PRs do not propose a
> fourth.

PageSpace records events across three tables. Each exists for a
different reason and has different integrity, retention, and SIEM
semantics. **Do not add a fourth.** See §DO NOT below.

| Table | Shape | Hash chain | Retention | Feeds SIEM? |
|---|---|---|---|---|
| `security_audit_log` | Security events (authn/authz/admin) | ✅ yes | Infinite (Art 17(3)(b)) | ✅ yes |
| `activity_logs` | Content/resource operations with rollback | ✅ yes | Infinite (Art 17(3)(b)) | ✅ yes |
| `system_logs` | Structured application logs | ❌ no | 30 days, user-purgeable | ❌ no |

---

## `security_audit_log`

- **Purpose:** Tamper-evident security event trail. Authentication,
  authorization, admin actions, risk/anomaly events. Forensic source
  of truth for "who did what" at the identity/permission layer.
- **Schema:** `packages/db/src/schema/security-audit.ts` — the
  `securityAuditLog` table, with the event type enum enumerating all
  valid event types (e.g., `auth.login.success`,
  `authz.access.denied`, `admin.user.deleted`,
  `security.anomaly.detected`).
- **Who writes it:** `audit()` / `auditRequest()` in
  `packages/lib/src/audit/audit-log.ts`. Always dual-writes to the
  structured logger **and** `securityAudit.logEvent()`
  (`packages/lib/src/audit/security-audit.ts`). This is the canonical
  writer — do not call the lower-level `securityAudit.logEvent`
  directly.
- **Hash chain:** `previousHash` / `eventHash` per row
  (`security-audit.ts:114-115`). The first entry's `previousHash` is
  `'genesis'`. Chain integrity is verified by the daily
  `apps/web/src/app/api/cron/verify-audit-chain/route.ts` job.
- **Retention:** **Infinite.** Intentionally excluded from time-based
  purge under GDPR Art 17(3)(b) — see
  [audit-log-retention-policy.md](audit-log-retention-policy.md).
  Per-user erasure is handled by pseudonymization of `userId`
  columns, not row deletion (which would break the chain).
- **Cloud/SIEM:** Yes. Included in the SIEM export pipeline — see
  `apps/processor/src/services/siem-sources.ts`.
- **Example event:** A failed login attempt from an unknown IP →
  `eventType: 'auth.login.failure'`, `ipAddress`, `userAgent`,
  `riskScore`, anomaly flags. This is **not** a content change, so
  it does not belong in `activity_logs`. It is **not** a debug log
  line, so it does not belong in `system_logs`.

## `activity_logs`

- **Purpose:** Comprehensive audit trail of user / AI operations on
  content and resources (pages, drives, documents, folders,
  conversations). Backs rollback, versioning, and deterministic event
  replay. Answers "who changed what content, and can we undo it?".
- **Schema:** `packages/db/src/schema/monitoring.ts` — the
  `activityLogs` table (around line 328), plus
  `activityOperationEnum` and `activityResourceEnum`.
- **Who writes it:** `packages/lib/src/monitoring/activity-logger.ts`.
  Writers populate denormalized actor snapshots (`actorEmail`,
  `actorDisplayName`), AI attribution fields (`isAiGenerated`,
  `aiProvider`, `aiModel`), rollback provenance
  (`contentSnapshot` / `contentRef`, `previousValues`, `newValues`),
  and deterministic event stream fields (`streamId`, `streamSeq`,
  `changeGroupId`, `stateHashBefore`, `stateHashAfter`).
- **Hash chain:** `previousLogHash` / `logHash` / `chainSeed`
  (`monitoring.ts:389-392`). Verified by the same
  `verify-audit-chain` cron via
  `packages/lib/src/monitoring/hash-chain-verifier.ts`.
- **Retention:** **Infinite.** Intentionally excluded from time-based
  purge under GDPR Art 17(3)(b) on two grounds: hash-chain integrity
  **and** contractual performance (Art 6(1)(b)) for the rollback
  feature. See
  [audit-log-retention-policy.md](audit-log-retention-policy.md).
  Per-user erasure goes through FK pseudonymization
  (`onDelete: 'set null'`) and column overwrites — not row deletion.
- **Cloud/SIEM:** Yes. Included in the SIEM export pipeline — see
  `apps/processor/src/services/siem-sources.ts`.
- **Example event:** A user edits a page's body → `operation:
  'update'`, `resourceType: 'page'`, `resourceId`, `previousValues`,
  `newValues`, `contentSnapshot` / `contentRef`, stream fields. This
  is **not** a security event (no privilege change) so it does not
  belong in `security_audit_log`. It is **not** a debug log line, so
  it does not belong in `system_logs`.

## `system_logs`

- **Purpose:** Structured application logs (trace / debug / info /
  warn / error / fatal). Operational observability — endpoint
  latency, error stacks, memory usage, request IDs. Ephemeral by
  design.
- **Schema:** `packages/db/src/schema/monitoring.ts` — the
  `systemLogs` table (around line 29).
- **Who writes it:** The category loggers in
  `packages/lib/src/logging/logger-config.ts`
  (`loggers.auth`, `loggers.api`, `loggers.ai`, `loggers.security`,
  etc.) flow into `writeLogsToDatabase()` at
  `packages/lib/src/logging/logger-database.ts:103`. Every call
  through any of the category loggers lands here. The `audit()`
  function in `packages/lib/src/audit/audit-log.ts` also writes here
  as one half of its dual-write — meaning a security event
  intentionally shows up in **both** `security_audit_log` and
  `system_logs`.
- **Hash chain:** None. This table is not tamper-evident and cannot
  be used as a forensic source of truth on its own.
- **Retention:** **30 days** by default
  (`RETENTION_SYSTEM_LOGS_DAYS`), via `cleanupSystemLogs` in
  `packages/lib/src/compliance/retention/monitoring-retention.ts`.
  User rows are purged on account deletion by
  `deleteMonitoringDataForUser` in
  `packages/lib/src/logging/monitoring-purge.ts`.
- **Cloud/SIEM:** **No.** Not included in the SIEM export pipeline.
  Operational noise is not forwarded; only the hash-chained tables
  are. Confirm the source list in
  `apps/processor/src/services/siem-sources.ts`.
- **Example event:** A slow database query logged by the category
  logger → `level: 'warn'`, `category: 'database'`, `message`,
  `duration`, `requestId`. This is **not** a security-relevant event
  and carries no forensic weight, so it does not belong in
  `security_audit_log`. It is **not** a content operation, so it
  does not belong in `activity_logs`.

---

## Decision tree — "I have an event, which table?"

```
Is the event security-relevant?
 (auth / authz / admin / privilege / anomaly / brute force)
 └─ YES → security_audit_log
          (call audit() / auditRequest() from packages/lib/src/audit/audit-log.ts —
           it dual-writes to system_logs automatically)
 └─ NO  → Does it mutate or read user content / resources
          in a way that needs to be rolled back, replayed, or
          attributed to a specific actor long-term?
          └─ YES → activity_logs
                   (call the writer in packages/lib/src/monitoring/activity-logger.ts)
          └─ NO  → system_logs
                   (just use the structured logger —
                    loggers.api.info(...), loggers.ai.error(...), etc.)
```

Quick dispatch table:

| Event type | Table |
|---|---|
| Login / logout / MFA / session create/revoke | `security_audit_log` |
| Permission grant/deny, role change | `security_audit_log` |
| Admin user CRUD, settings change | `security_audit_log` |
| Brute-force / rate-limit / anomaly detection | `security_audit_log` |
| Page / document / folder create / update / delete | `activity_logs` |
| AI tool call that writes content | `activity_logs` (with `isAiGenerated = true`) |
| Rollback of a prior activity | `activity_logs` (links `rollbackFromActivityId`) |
| Slow query warning, cache miss rate, memory pressure | `system_logs` |
| Request latency / error stack trace | `system_logs` |
| Generic `loggers.api.info('...')` call | `system_logs` (automatic) |

---

## DO NOT propose a fourth table

The three-table split is deliberate. Before proposing a new log-shaped
table, talk to the team. The usual reasons the fourth table is wrong:

- **"I need security events with rollback."** No you don't. Security
  events are facts about what happened — they are not undoable. Use
  `security_audit_log`.
- **"I need content events with fast TTL."** No you don't. Content
  events back rollback and deterministic replay; if you truncate them
  you break those features. If the concern is storage growth, that is
  the hot/cold tiering job tracked in issue #984 (see
  [audit-log-retention-policy.md](audit-log-retention-policy.md) §
  "Planned"), not a new table.
- **"I need hash-chained debug logs."** No you don't. `system_logs`
  is operational telemetry; tamper-evidence on debug logs buys
  nothing because they have no compliance obligation and are purged
  on a 30-day cycle.
- **"I need my own table for $feature."** If the events are security
  events, extend `security_event_type` in
  `packages/db/src/schema/security-audit.ts`. If they are content
  operations, extend `activityOperationEnum` /
  `activityResourceEnum` in `packages/db/src/schema/monitoring.ts`.
  If neither fits, raise it on the SIEM / audit epic before writing
  any code.

A fourth table means a fourth hash chain (or a fourth thing that
doesn't have one), a fourth retention policy, a fourth SIEM pipeline
decision, and a fourth thing for downstream consumers to reason about.
The cost is high; the benefit is almost always "I did not read this
doc."

---

## References

- `packages/db/src/schema/security-audit.ts` — `security_audit_log` schema and event type enum
- `packages/db/src/schema/monitoring.ts` — `activity_logs` and `system_logs` schemas
- `packages/lib/src/audit/audit-log.ts` — canonical `audit()` / `auditRequest()` writer (dual-write)
- `packages/lib/src/audit/security-audit.ts` — low-level `securityAudit.logEvent` used by `audit()`
- `packages/lib/src/monitoring/activity-logger.ts` — `activity_logs` writer and hash chain producer
- `packages/lib/src/monitoring/hash-chain-verifier.ts` — hash chain integrity verification
- `packages/lib/src/logging/logger-config.ts` — category loggers that feed `system_logs`
- `packages/lib/src/logging/logger-database.ts` — `writeLogsToDatabase()` batch insert for `system_logs`
- `packages/lib/src/compliance/retention/monitoring-retention.ts` — `system_logs` time-based purge
- `apps/processor/src/services/siem-sources.ts` — SIEM pipeline source list (`security_audit_log` + `activity_logs`)
- `apps/web/src/app/api/cron/verify-audit-chain/route.ts` — daily hash chain verification cron
- [audit-log-retention-policy.md](audit-log-retention-policy.md) — Art 17(3)(b) exemption and per-user erasure paths
