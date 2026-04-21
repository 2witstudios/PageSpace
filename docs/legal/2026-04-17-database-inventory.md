# PageSpace — Database Inventory and Hosting

**Prepared:** 2026-04-17
**Scope:** Production databases for PageSpace as of the date above.
**Source of truth:** `docker-compose.prod.yml` in the `PageSpace-Deploy`
repository.

## Summary

All PageSpace production databases run as Docker containers on **a single
Hetzner VPS** under the seller's Hetzner account. There are no managed
database providers (no RDS, no Supabase, no Neon, no Upstash, no Aiven, no
Fly Postgres, etc.) and no databases on any other cloud or physical host.

## Inventory

| Instance | Engine | Version | Role | Host | Persistence |
|---|---|---|---|---|---|
| `postgres` | PostgreSQL | 17.5 (Alpine) | Primary application database — all user data, workspaces, pages, files metadata, AI chat history, audit logs, encrypted BYOK keys, rate-limit buckets, session/JTI revocation state, auth handoff tokens | Single Hetzner VPS (Docker container) | Docker volume `postgres_data` on the VPS disk |

## Handover mechanism

Handover at cutover is specified in the main IP/OSS disclosure
(`docs/legal/2026-04-16-oss-compliance-report.md`):

- **Postgres**: §4.5 *User-data handover* — `pg_dump` from the Hetzner
  Postgres container to a buyer-provided Postgres instance over an
  encrypted channel, with three options for BYOK encryption-key handover.
  Postgres is the only durable datastore; there is no secondary cache or
  session instance to migrate.

After the rollback window, the Hetzner VPS disk is destroyed and the
seller retains no copy of the database. Written confirmation of
destruction is delivered to the buyer per §4.5 of the main disclosure.

## Out of scope

- No separate analytics warehouse (BigQuery, Snowflake, ClickHouse, etc.).
- No search service with its own index (Elasticsearch, Typesense,
  Algolia, etc.) — search is implemented against the `postgres` instance
  above.
- No dedicated queue or message broker — no RabbitMQ, Kafka, NATS, or managed
  SQS/EventBridge equivalent. Socket.IO fanout runs inside the realtime
  service without an external broker.
- No external backup target holding PageSpace user data (the seller does
  not ship backups to S3, B2, or a similar off-Hetzner destination).
