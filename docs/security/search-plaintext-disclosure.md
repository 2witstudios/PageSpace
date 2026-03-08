# Search & Plaintext Content Disclosure

## Overview

PageSpace stores page content as **plaintext in PostgreSQL** to enable full-text search and AI context retrieval. This is an intentional design tradeoff: application-layer encryption of content would break search, AI chat context, and real-time collaboration.

This document describes the tradeoff, the controls in place, and the per-page opt-out mechanism.

---

## Why Plaintext

PageSpace supports five content operations that require server-side access to raw text:

1. **Full-text search** — Multi-drive search uses PostgreSQL `ILIKE` and regex operators directly on the `pages.content` column. Encrypted content would require decryption of every page to search, which is infeasible at scale.

2. **AI context** — When users chat with AI about a page, the page content is included in the AI prompt. The server assembles the prompt, so it must be able to read the content.

3. **Real-time collaboration** — The Socket.IO service broadcasts content updates to all connected editors. The server relays these updates and must parse them to resolve conflicts.

4. **File processing** — When files are uploaded, the processor service extracts text content and stores it in the `pages.content` column for downstream search and AI operations.

5. **Activity digest generation** — The pulse/digest service retrieves content snapshots from activity logs to generate change summaries and activity diffs.

---

## Controls

### Access Control

Content is never exposed without authorization:

- **Search results** are filtered by the requesting user's page-level permissions (`canView`). Even if a page matches a search query, the result is excluded unless the user has view access.
- **API endpoints** validate authentication and authorization before returning page content.
- **MCP tokens** respect drive scoping — scoped tokens cannot access content in drives outside their scope.

### Per-Page Search Exclusion

Pages can opt out of search indexing by setting `excludeFromSearch = true`. When enabled:

- The page will **not** appear in multi-drive search results.
- The page will **not** appear in drive-level regex or glob search results.
- The page content **remains stored in plaintext** — the flag only affects query-time filtering, not storage or retention.
- The page content is **still accessible** via direct page load, AI chat, and API endpoints.

This is useful for pages containing sensitive data (credentials, personal notes) that should not surface in search results.

### Database Security

- PostgreSQL is deployed behind a private network (Docker bridge or localhost).
- Database credentials are not exposed to the client.
- Connection strings use `pg` driver with SSL in production configurations.
- Database backups should be encrypted at rest (infrastructure responsibility).

---

## What This Does NOT Provide

- **Encryption at rest at the application layer** — Content is plaintext in the database. Encryption at rest must be handled by the storage layer (e.g., LUKS, AWS EBS encryption, PostgreSQL TDE).
- **Zero-knowledge architecture** — The server can read all content. This is inherent to server-side search and AI.
- **Content in activity logs** — Activity logs preserve raw content snapshots for audit and rollback purposes (limited to 1MB per entry). Content snapshots are not redacted and may contain sensitive data.

---

## Related Documents

- [MCP Token Trust Boundaries](./mcp-trust-boundaries.md) — How MCP tokens scope content access
- [Security Posture Assessment](./2026-02-11-security-posture-assessment.md) — Full security assessment
