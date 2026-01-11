# Security Update - VPS Deployment Guide

> **For:** VPS Administrator
> **Scope:** Security hardening (distributed rate limiting, token hashing, JTI tracking)

---

## New Requirements

### 1. Redis Instances

Two Redis 7.x instances are required:

| Instance | Purpose | Port | Config |
|----------|---------|------|--------|
| `redis` | Realtime/Socket.IO, general cache | 6379 | `maxmemory 128mb`, `allkeys-lru` |
| `redis-sessions` | Security features (sessions, JTI, rate limiting) | 6380 | `maxmemory 64mb`, `allkeys-lru` |

The `redis-sessions` instance uses different databases:
- **DB 0:** Session data, JTI tracking
- **DB 1:** Rate limit counters

---

### 2. Environment Variables

Add these to your deployment:

```bash
# Redis - General (realtime, cache)
REDIS_URL=redis://:PASSWORD@redis:6379

# Redis - Security features (sessions, JTI, rate limiting)
REDIS_SESSION_URL=redis://:PASSWORD@redis-sessions:6379/0
REDIS_RATE_LIMIT_URL=redis://:PASSWORD@redis-sessions:6379/1

# Cron authentication
# Generate with: openssl rand -base64 32
CRON_SECRET=<secure-random-string>
```

**Security note:** If Redis is unavailable in production:
- Rate limiting falls back to in-memory (security risk with multiple instances)
- JTI checks fail closed (tokens rejected)

---

### 3. One-Time Token Migration

After deploying the new images, run this SQL script **once** against the database:

```bash
# Option 1: Via psql
psql $DATABASE_URL -f scripts/migrate-token-hashes.sql

# Option 2: Via docker exec into postgres container
docker exec -i postgres psql -U user -d pagespace < scripts/migrate-token-hashes.sql
```

**Expected output:**
```
   table_name       | total | with_hash | without_hash
--------------------+-------+-----------+--------------
 refresh_tokens     |   X   |     X     |      0
 mcp_tokens         |   X   |     X     |      0
 device_tokens      |   X   |     X     |      0
 verification_tokens|   X   |     X     |      0
```

All `without_hash` values should be `0` after migration.

Full runbook: `docs/security/token-hashing-migration.md`

---

### 4. Cron Job

Set up hourly (or daily) token cleanup:

**Endpoint:**
```
GET /api/cron/cleanup-tokens
Authorization: Bearer $CRON_SECRET
```

**Example cron entry:**
```bash
0 * * * * curl -s -X GET "https://your-domain.com/api/cron/cleanup-tokens" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Verification Checklist

After deployment:

- [ ] Redis accessible from web containers
- [ ] Environment variables set
- [ ] Token migration completed
- [ ] Cron job scheduled
- [ ] Login/logout flow tested
- [ ] No Redis connection errors in logs

---

## Quick Redis Test

From web container:
```bash
# Test general Redis
node -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL);
r.ping().then(res => console.log('redis:', res)).catch(console.error).finally(() => r.quit());
"

# Test sessions Redis
node -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_SESSION_URL);
r.ping().then(res => console.log('redis-sessions:', res)).catch(console.error).finally(() => r.quit());
"
# Expected: PONG for both
```
