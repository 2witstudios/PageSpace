# Encryption in Transit (GDPR S4:F5 / #969)

**Article 32.** Personal data must be protected in transit. This documents
PageSpace's transit posture and the gaps closed in the GDPR encryption epic.

## 1. Browser ↔ edge (HSTS) — FIXED

HSTS was previously emitted only when `NODE_ENV === 'production'`
(`apps/web/src/middleware/security-headers.ts`). Any HTTPS-served environment
that is not literally production (staging, tenant, preview) therefore shipped no
`Strict-Transport-Security` header — a downgrade-attack window.

**Now:** HSTS (`max-age=63072000; includeSubDomains; preload`) is emitted for
**any HTTPS response**, detected via `isSecureRequest()` (honoring
`x-forwarded-proto` set by the Caddy/Fly edge) — see `shouldEmitHsts()`.
Plain-HTTP localhost dev still omits HSTS so developer machines are unaffected.
Production continues to emit unconditionally for back-compat.

## 2. Internal / service-to-service traffic — REQUIREMENT

Web ↔ realtime ↔ processor ↔ Postgres traffic must not traverse any untrusted
network in cleartext.

- **Cloud/Fly:** intra-app traffic rides Fly's private 6PN WireGuard mesh
  (`*.internal`), which is encrypted at the network layer. Postgres connections
  must use `sslmode=require` (or `verify-full` where the CA is pinned).
- **Self-host / multi-host onprem & tenant:** when services span hosts, operators
  MUST terminate TLS between them (mTLS or a TLS-terminating mesh/proxy). The
  compose topology must not expose service ports on a shared/untrusted L2 without
  TLS. Single-host deployments (all containers on one Docker bridge network) are
  acceptable because traffic never leaves the host.
- **Action for deploy repo:** `docker-compose.yml` inter-service hops that can
  cross hosts require TLS; document the required `sslmode`/mTLS settings in
  `PageSpace-Deploy`. Tracked alongside #969.

## 3. Mobile clients (cert pinning) — REQUIREMENT

The iOS/Android Capacitor wrappers connect to the cloud API over TLS but do not
pin the server certificate, leaving them exposed to a compromised/rogue CA on a
hostile network.

- **Requirement:** add certificate (or SPKI public-key) pinning to the Capacitor
  HTTP/WebSocket layer for the production API + realtime origins, with a backup
  pin to survive cert rotation. Pin the leaf or intermediate SPKI, ship at least
  two pins (current + next), and fail closed on mismatch.
- This is a native-shell change (out of scope for the web middleware leaf) and is
  tracked as a mobile follow-up under #969.

## Verification

- `apps/web/src/middleware/__tests__/security-headers-hsts.test.ts` asserts HSTS
  is emitted for HTTPS regardless of `NODE_ENV` and omitted for plain-HTTP dev.
- Manual: `curl -sI https://<staging-host>/ | grep -i strict-transport-security`
  must return the header in every HTTPS environment.
