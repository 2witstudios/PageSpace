# MCP Token Trust Boundaries

## Overview

PageSpace exposes API endpoints to external clients via MCP (Model Context Protocol) tokens. MCP tokens allow third-party tools — Claude Desktop, Cursor, custom scripts — to read and write PageSpace content programmatically. This document describes the trust model, known limitations, and guidance for users creating MCP tokens.

---

## Token Security Model

### Storage

MCP tokens use **hash-only storage**. The raw token is shown once at creation and never stored. The database holds:

- **SHA-256 hash** of the token (`tokenHash` column, unique index)
- **Token prefix** — first 12 characters for debugging (`tokenPrefix` column)
- Metadata: name, creation time, last used, revocation timestamp

Plaintext tokens cannot be recovered from the database. A compromised database does not expose token values.

### Authentication Flow

1. Client sends raw MCP token in the `Authorization: Bearer mcp_...` header
2. Server hashes the token with SHA-256
3. Server looks up the hash in the `mcp_tokens` table
4. Server verifies the token is not revoked (`revokedAt IS NULL`)
5. Server verifies the owning user is not suspended (`suspendedAt IS NULL`)
6. Server resolves the token's scoped drives (if any)

### Scope Enforcement (Fail-Closed)

MCP tokens support optional **drive scoping**:

- **Unscoped tokens**: Access all drives the owning user can access.
- **Scoped tokens**: Access only explicitly listed drives. If all scoped drives are deleted, the token becomes inert (`isScoped = true` with zero drives = deny all).

This is a **fail-closed** design: loss of scope data results in denial, not elevation.

---

## Trust Boundaries

### Boundary 1: MCP Client → PageSpace API

MCP tokens are **bearer credentials**. Any process possessing the raw token string can act as the owning user within the token's scope. PageSpace authenticates the token but cannot verify the identity of the process presenting it.

**Implication**: Users must protect MCP token values with the same care as passwords. Tokens should not be committed to version control, shared in chat, or stored in plaintext configuration files accessible to other users.

### Boundary 2: Scoped vs Unscoped Access

Scoped tokens restrict which drives a client can access. However:

- **Within a scoped drive**, the token has full read/write access matching the owning user's permissions.
- Scope restricts drive-level access, not page-level or operation-level access.
- There is no per-endpoint scope restriction (e.g., "read-only" tokens are not yet supported).

### Boundary 3: Hybrid Route Scope Enforcement

Some API routes accept both session cookies and MCP tokens (`allow: ['session', 'mcp']`). These "hybrid" routes present a known scope enforcement gap:

- **53 hybrid routes** exist across the API surface.
- Not all hybrid routes consistently enforce MCP drive scope restrictions.
- Session-authenticated requests bypass scope checks (sessions have full user access).

**Status**: This is a documented P1 gap. Enforcement is being added incrementally.

### Boundary 4: User Suspension Propagation

When an admin suspends a user account:

- Active MCP tokens for that user are immediately invalidated (checked on every request).
- In-flight requests that already passed authentication may complete.
- Token revocation is separate from user suspension — both are checked.

---

## Known Limitations

| Issue | Severity | Status |
|-------|----------|--------|
| No read-only token scope | P2 | Planned |
| Inconsistent scope enforcement on hybrid routes | P1 | In progress |
| No token usage rate limiting (separate from user rate limits) | P3 | Backlog |
| Token expiration not supported (revocation only) | P3 | Backlog |

---

## Recommendations for Users

1. **Prefer scoped tokens** — Create tokens scoped to specific drives rather than unscoped tokens. This limits blast radius if a token is compromised.

2. **Name tokens descriptively** — Use names like "Cursor - Project X" so you can identify and revoke specific tokens.

3. **Revoke unused tokens** — Regularly audit active tokens in Settings → API Tokens. Revoke any tokens no longer in use.

4. **Treat tokens as secrets** — Store MCP tokens in your system keychain or a secrets manager. Never commit them to repositories.

5. **Monitor last-used timestamps** — Tokens that haven't been used recently but weren't revoked may indicate forgotten integrations.

---

## Related Documents

- [Desktop MCP Trust Model](./desktop-mcp-trust-model.md) — Trust model for local desktop MCP servers
- [Zero-Trust Architecture](./zero-trust-architecture.md) — Cloud/web security architecture
- [Security Posture Assessment](./2026-02-11-security-posture-assessment.md) — Full security assessment including MCP gaps
