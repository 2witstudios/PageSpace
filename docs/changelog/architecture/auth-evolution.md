# Authentication Evolution

> JWT, sessions, device auth decisions

## The Decision

PageSpace uses custom JWT-based authentication rather than a third-party auth service. This choice evolved significantly as the platform grew.

## Key Architectural Choices

### Custom Auth Over Auth-as-a-Service

**The Choice**: Build custom authentication with JWT + jose library.

**Why**:
- Full control over auth flow
- No external service dependency
- Self-hosted friendly
- Cost savings at scale

**Trade-offs**:
- More responsibility for security
- OAuth/social login requires custom implementation
- No managed session infrastructure

### JWT Token Strategy

**The Choice**: JWTs for stateless authentication.

**Why**:
- Scalable (no session store needed)
- Works across services (web, realtime, processor)
- Verifiable without database lookup

**Implementation**:
- `jose` library for JWT operations
- `bcryptjs` for password hashing
- Short-lived access tokens
- Refresh token rotation

### Device Authentication (Era 6-7)

**The Choice**: Device-specific auth for desktop and mobile apps.

**Why**:
- Desktop app needs persistent login
- Mobile apps need to stay logged in between sessions
- Different security model than browser
- Device can be trusted longer than a session

**Era 6 Foundation (Nov 2025)**:
- `a24be4b27e86` - Device token foundation (Phase 1)
- `c3d772ff9232` - Configurable refresh token TTL
- `a0b0044a9f20` - Desktop null device token handling
- `d1828172083c` - Clear desktop auth on expiry
- PR #44, #46, #47 - Token system implementation

**Why Phase 1**: Started with simple approach to validate the pattern before complex implementation.

**Challenges Encountered**:
- Null device token edge cases on desktop
- Auth loop prevention
- Device persistence improvements
- Token refresh edge cases
- Cross-platform consistency (web, desktop, iOS)

*Multiple commits in Era 7 and 10 address device auth:*
- `Claude/fix device logout issue rw whv`
- `fix(auth): device persistence improvements`
- `Fix/device auth review followup`

## Evolution Through Commits

| Era | Focus |
|-----|-------|
| 1 | Admin auth, basic JWT |
| 2 | Session management basics |
| 3 | Security hardening sprint |
| 4-6 | Refinement, refresh flows |
| 7 | Desktop/device authentication |
| 8-10 | Bug fixes, loop prevention |

### Era 3: Security Hardening (Sep 25-26, 2025)

A concentrated security effort addressed multiple authorization issues:

| Commit | Issue Fixed |
|--------|-------------|
| `d2e9f65fe222` | JWT token decoding in protected routes |
| `b36442f3a445` | JWT authentication bypass (PR #13) |
| `8c2b9d6066b2` | Drive membership checks in permissions |
| `cc89deab66e0` | File authorization issues (PR #14) |
| `1c9f2d5ad4ff` | Processor content hash access control |
| `42c2676958cb` | Tenant token implementation |

**Key Insight**: Multiple security PRs in rapid succession suggests either a security audit or discovery of related vulnerabilities. This proactive approach prevented potential production issues.

### Processor Service Auth (Sep 26-29, 2025)

The processor service required its own authentication layer:
- Tenant tokens for service-to-service auth
- Drive-scoped access validation
- Content hash verification

This established the pattern for internal service authentication used across the monorepo.

## Security Considerations

- Password hashing with bcrypt
- JWT secret rotation capability
- CSRF protection
- Rate limiting on auth endpoints
- Session invalidation on security events

---

*Last updated: 2026-01-22 | Version: 3*
