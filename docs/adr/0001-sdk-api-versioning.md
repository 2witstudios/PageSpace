# ADR 0001 — SDK ↔ Server API Versioning

- **Status:** Proposed (Phase 0 of the SDK/CLI/OAuth epic)
- **Date:** 2026-07-03
- **Deciders:** SDK/CLI/OAuth epic, Phase 0
- **Consumers:** Phase 2 (SDK transport + operation registry), Phase 1 (OAuth server routes), Phase 6 (MCP adapter parity gate)

## Context

Publishing `@pagespace/sdk` freezes today's internal `/api/*` routes into a public contract.
The SDK will talk to servers of arbitrary age: cloud (`pagespace.ai`, continuously deployed)
and self-hosted installs that may be months behind. Without an explicit compatibility
mechanism, every web-app route refactor silently breaks every SDK consumer.

### Verified ground truth (all claims checked in-repo on 2026-07-03)

**1. The internal API surface is unversioned.**
All app routes live under a flat `/api/<resource>` tree (~50 top-level resource directories
under `apps/web/src/app/api/`). Middleware treats `/api` as one namespace
(`apps/web/middleware.ts:45`, `apps/web/middleware.ts:68`), and its public-route allowlist
hardcodes unversioned prefixes (`apps/web/middleware.ts:110-126`).

**2. The `/api/v1` namespace is already occupied — by a foreign contract.**
`apps/web/src/app/api/v1/` contains the OpenAI-compatible facade
(`v1/chat/completions/route.ts`, `v1/models/route.ts`, `v1/conversations/route.ts`). Its `v1`
mirrors OpenAI's path convention (see imports from `@/lib/ai/openai-api/` in
`apps/web/src/app/api/v1/chat/completions/route.ts:29-30`); it is not, and cannot become, an
internal versioning scheme without colliding with that facade's semantics.

**3. The only existing server version signal is broken in production.**
`GET /api/health` (public per `apps/web/middleware.ts:125`) reports
`version: process.env.npm_package_version || '0.0.0'`
(`apps/web/src/app/api/health/route.ts:59`). But production runs the Next.js standalone
output directly — `CMD ["node", "apps/web/server.js"]` (`apps/web/Dockerfile:115`) — where
`npm_package_version` is undefined, so production reports `0.0.0`. Even if it were populated,
`apps/web/package.json` pins `"version": "0.1.0"` and is never bumped; `packages/lib` and
`packages/db` are likewise frozen at `0.1.0`.

**4. Deployment carries no version either.**
Fly images are deployed as `registry.fly.io/pagespace-*:latest`
(`PageSpace-Deploy/fly/fly.*.toml`, e.g. `fly.realtime.toml:5`), and the web Dockerfile
injects no git SHA or build version (`apps/web/Dockerfile:45-77` — the full ARG/ENV list is
Sentry + `NEXT_PUBLIC_*` only). There is no artifact anywhere that semantically identifies
what API surface a running server speaks.

**5. The predecessor did zero version negotiation — and drifted.**
`pagespace-mcp`'s transport (`/Users/jono/production/pagespace-mcp/src/api.js`, 133 lines)
sends no version information and checks none; failures are stringly typed
(`throw new Error(\`API request failed (${status}): ...\`)`, `src/api.js:67` and `src/api.js:118`).
The server even disagrees with itself about its own version: `src/server.js:33` and
`src/server.js:74` hardcode `'5.1.1'` while `package.json` says `5.2.3`. This is the failure
mode the operation registry + this ADR exist to make structurally impossible.

**6. Client-reported versions exist today only as telemetry.**
Device refresh accepts `appVersion: z.string().optional()`
(`apps/web/src/app/api/auth/device/refresh/route.ts:23`) and records it
(`route.ts:154`); nothing gates on it. There is no precedent of version *enforcement* to
reuse — this ADR introduces it.

**7. House conventions the mechanism must follow.**
- Custom headers are `X-PageSpace-*` (`packages/lib/src/logging/siem-error-hook.ts:48-49`).
- API error bodies are `{ error, code }` with SCREAMING_SNAKE codes
  (`apps/web/middleware.ts:81`: `{ error: 'Origin not allowed', code: 'ORIGIN_INVALID' }`).
- Typed errors are `class XError extends Error` with `this.name` set, a
  `readonly code = '...' as const`, and a realm-independent type guard instead of
  `instanceof` (`packages/lib/src/services/validated-service-token.ts:98-121`,
  `packages/lib/src/utils/fetch-with-timeout.ts:3-8`).
- All API responses flow through `createSecureResponse(..., { isAPIRoute: true })` in
  middleware (`apps/web/middleware.ts:102`, `apps/web/middleware.ts:127`), giving a single
  central place to stamp a response header on every `/api/*` response.

## Options considered

### (a) Server-declared API version header + SDK-declared minimum — **chosen, with one correction**

The SDK checks a version the server advertises against a minimum the SDK was built with.
Avoids any route migration. The correction ground truth forces: the advertised version
**cannot** be the app version (`npm_package_version` is undefined in prod, `package.json`
versions are frozen at `0.1.0`, images are `:latest` — facts 3 & 4). A new, deliberately
maintained **API contract version** must be introduced as the single source of truth.

### (b) `/api/v1` route re-pathing — rejected

Requires migrating ~50 top-level route directories plus every hardcoded `/api/...` prefix in
middleware, origin validation, and clients, inside an epic that is explicitly not a route
migration. Worse, the `v1` namespace is already taken by the OpenAI-compat facade (fact 2),
so PageSpace's own "v1" would collide with a differently-shaped foreign contract. Path
versioning also versions the *transport location*, not the *contract* — a semantic change to
an existing route's response shape is invisible to a path prefix.

### (c) Capability discovery endpoint — rejected as the primary mechanism, absorbed as a seam

A rich `GET /api/capabilities` answers "does this server support operation X?" but not the
prior question "does this server speak the contract at all?", and it invites per-call
capability probing (chatty, cacheable-stale, and a larger surface to secure). The operation
registry (Phase 2) already gives per-operation granularity at build time. The chosen
`GET /api/version` endpoint (below) returns a structured document, so capability fields can
be added additively later without a new ADR.

## Decision

### D1. The compatibility token is a hand-maintained **API contract version**

A semver string exported from one place:

```ts
// packages/lib/src/api-contract-version.ts
export const API_CONTRACT_VERSION = '1.0.0';
```

- It versions the **operation registry contract** (the set of operations, their input/output
  schemas, and their error semantics) — not the app, not the deploy artifact.
- It is bumped only by PRs that change the contract, per the policy in D5. A CI check
  (Phase 7) fails any PR that changes registry schemas without a version bump.
- New subpath module ⇒ needs a `package.json` exports entry in `packages/lib` plus
  `bun install` in the worktree (project law).
- It is deliberately **not** derived from `npm_package_version`, git tags, or image tags —
  every one of those is unpopulated or meaningless in this codebase today (facts 3–4), and
  deriving from them would re-create the `pagespace-mcp` 5.1.1-vs-5.2.3 drift (fact 5).

### D2. The server advertises it in two places

1. **Response header on every `/api/*` response:**
   `X-PageSpace-API-Version: <semver>` — stamped centrally where API responses already get
   their security headers (`createSecureResponse(..., { isAPIRoute: true })`,
   `apps/web/src/middleware/security-headers.ts:153-166`), so no route can forget it.
   Follows the existing `X-PageSpace-*` convention (fact 7).
2. **Public handshake endpoint:** `GET /api/version` — added to the middleware public-route
   allowlist (alongside `/api/health`, `apps/web/middleware.ts:125`), touches no DB (unlike
   `/api/health`, which runs `SELECT 1` — `apps/web/src/app/api/health/route.ts:31`),
   returns constant JSON:

   ```json
   { "service": "pagespace-web", "apiVersion": "1.0.0" }
   ```

   This endpoint is the eager-handshake target and the future seam for capability fields.

The header/endpoint expose no secrets (the contract version is public by definition — it
ships inside the published SDK) and gate no privileges, so public exposure is not an oracle.

### D3. The SDK pins its own minimum and verifies on every response

- `packages/sdk` compiles in its own literal
  `MIN_SERVER_API_VERSION` — deliberately **not** imported from
  `@pagespace/lib`'s `API_CONTRACT_VERSION`, because the SDK on npm is decoupled from the
  server tree the moment it is published; importing the live constant would make skew
  untestable and mask real minimums. A repo test asserts
  `MIN_SERVER_API_VERSION <= API_CONTRACT_VERSION` so the SDK never demands a future server.
- **Eager handshake (optional):** `client.connect()` performs `GET /api/version` and renders
  a verdict before any operation runs.
- **Lazy verification (always):** the transport extracts `X-PageSpace-API-Version` from
  every **2xx** response and evaluates the pure compatibility function below. This catches
  mid-session server upgrades/downgrades and makes the eager handshake an optimization, not
  a correctness requirement.
- Non-2xx responses are mapped to their own typed transport/HTTP errors **first** — a Caddy
  502 or proxy error page carries no header and must surface as a server/transport error,
  never as a false `IncompatibleServerError`. The compatibility verdict is only rendered
  from responses that are identifiably the app's (2xx with headers).

### D4. Fail-closed posture (zero trust)

The SDK never assumes a compatible server. On a 2xx response:

| Observation | Verdict |
|---|---|
| Header missing | **Incompatible** (`missing-header`) — a pre-contract server (today's prod) must be refused, not silently degraded to |
| Header not valid semver | **Incompatible** (`malformed-version`) — garbage input is rejected, not coerced |
| `major(server) ≠ major(min)` | **Incompatible** (`major-mismatch`) — no silent forward-compat across breaking majors, in either direction |
| `server < min` (same major) | **Incompatible** (`server-too-old`) |
| `server ≥ min` (same major) | **Compatible** — newer minor/patch is additive by policy D5 |

Every incompatible verdict throws `IncompatibleServerError` naming both versions. There is
no partial-compatibility mode, no warn-and-continue flag, no env-var escape hatch. The
header is untrusted network input: it is zod-validated, and a lying server can only cause a
*denial* (fail closed) — it cannot unlock anything, because the version grants no capability.

### D5. Breaking-change policy for the operation registry

The contract version bumps with the registry:

- **MAJOR (breaking):** removing or renaming an operation; adding a required input field;
  removing an input field consumers may send (schema narrowing); removing or retyping an
  existing output field; tightening an operation's auth/scope requirement; changing the
  meaning of an existing error `code`.
- **MINOR (additive):** adding an operation; adding an optional input field; widening an
  input type; adding an output field; adding a new error `code`. Corollary rule, enforced by
  registry linting: SDK **output** schemas must parse open-world (unknown fields stripped
  not rejected; enum-like output values decoded as `knownEnum ∪ string`), otherwise additive
  server changes would be de-facto breaking.
- **PATCH:** documentation/description-only registry changes.

**Deprecation** is registry metadata, not a route header (server routes are not
registry-aware): `deprecated: { since: string; removeIn: string; replacement?: string }` on
an operation. The SDK warns once per process per deprecated operation; the CLI surfaces the
warning; the MCP adapter marks the tool description. Removal happens only at `removeIn`'s
major.

**SDK semver mapping:** `@pagespace/sdk`'s npm major tracks the contract major (SDK `1.x`
speaks contract `1.x.x`). Within a major, the SDK bumps its `MIN_SERVER_API_VERSION` only
when it starts *requiring* an operation or field introduced in a later contract minor — and
because that bump drops support for older servers, **any `MIN_SERVER_API_VERSION` raise is
an SDK major**. One client, one minimum — no per-method carve-outs. (Per-operation minimums
via registry metadata are a possible future minor-safe refinement, out of scope for this
ADR.)

### D6. Pure function signatures (Phase 2 implements exactly these)

All decision logic is side-effect-free; I/O (fetch, header extraction) stays at the edges.

```ts
// packages/sdk — pure, no I/O, no clock, no globals

export type IncompatibilityReason =
  | 'missing-header'
  | 'malformed-version'
  | 'major-mismatch'
  | 'server-too-old';

export type CompatibilityResult =
  | { ok: true; serverVersion: string }
  | { ok: false;
      reason: IncompatibilityReason;
      serverVersion: string | null;   // raw header value, null if absent
      sdkMinVersion: string };

/** Parse a strict semver "MAJOR.MINOR.PATCH" (no ranges, no prerelease). */
export function parseApiVersion(raw: string): { major: number; minor: number; patch: number } | null;

/** Total order on parsed versions: -1 | 0 | 1. */
export function compareApiVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1;

/** The single compatibility decision. (serverVersion, sdkMinVersion) → ok | incompatible. */
export function checkServerCompatibility(
  serverVersion: string | null,     // raw X-PageSpace-API-Version value (or /api/version body field)
  sdkMinVersion: string,            // SDK's compiled-in MIN_SERVER_API_VERSION
): CompatibilityResult;
```

```ts
// packages/sdk — error type, following the house convention
// (name + readonly code + realm-independent guard; cf. validated-service-token.ts:98-121)

export class IncompatibleServerError extends Error {
  readonly code = 'INCOMPATIBLE_SERVER' as const;
  readonly reason: IncompatibilityReason;
  readonly serverVersion: string | null;
  readonly sdkMinVersion: string;
  constructor(result: Extract<CompatibilityResult, { ok: false }>);
}

export function isIncompatibleServerError(error: unknown): error is IncompatibleServerError;
```

### D7. Testable assertions (each becomes a RED test in Phase 2)

1. Given `serverVersion = null`, `checkServerCompatibility` returns
   `{ ok: false, reason: 'missing-header' }` — never `{ ok: true }`.
2. Given `serverVersion = 'latest'` (or `''`, `'1.0'`, `'v1.0.0'`, `'1.0.0-beta'`), returns
   `{ ok: false, reason: 'malformed-version' }`.
3. Given `serverVersion = '2.0.0'`, `sdkMinVersion = '1.3.0'`, returns
   `{ ok: false, reason: 'major-mismatch' }` (newer server major is NOT accepted).
4. Given `serverVersion = '1.2.9'`, `sdkMinVersion = '1.3.0'`, returns
   `{ ok: false, reason: 'server-too-old', serverVersion: '1.2.9', sdkMinVersion: '1.3.0' }`.
5. Given `serverVersion = '1.3.0'` or `'1.9.4'`, `sdkMinVersion = '1.3.0'`, returns `{ ok: true }`.
6. `checkServerCompatibility` is referentially transparent: same inputs ⇒ same output, no
   clock/env/network access (enforced by unit tests with plain values, per epic
   non-negotiable #2).
7. The transport throws `IncompatibleServerError` (guard-detectable via
   `isIncompatibleServerError`) on any 2xx response whose header fails the check, and the
   error message names both versions.
8. The transport maps a non-2xx response without the header to an HTTP/transport error,
   **not** `IncompatibleServerError`.
9. `GET /api/version` responds 200 without auth and without touching the DB, body
   `{ service, apiVersion }` where `apiVersion === API_CONTRACT_VERSION`.
10. Every `/api/*` response (success and error alike, as both flow through
    `createSecureResponse`) carries `X-PageSpace-API-Version` equal to `API_CONTRACT_VERSION`.
11. Repo-level: `MIN_SERVER_API_VERSION <= API_CONTRACT_VERSION` (SDK never requires a
    future server).
12. Repo-level (Phase 7 gate): a change to any registry operation schema without an
    `API_CONTRACT_VERSION` bump fails CI.

## Consequences

- **Work created:** `packages/lib/src/api-contract-version.ts` (+ exports entry);
  `GET /api/version` route + middleware allowlist entry; header stamping in
  `security-headers.ts`; the pure module + error type in `packages/sdk` (Phase 2); the CI
  contract-bump gate (Phase 7).
- **Today's production servers are incompatible by definition** — they send no header. The
  SDK refuses them with a precise error instead of failing mysteriously per-call. This is
  intended: the SDK's floor is the first server release that ships this epic's server-side
  changes (`API_CONTRACT_VERSION = '1.0.0'`).
- **Self-hosted skew is handled at runtime**, which is the only place it can be: cloud
  deploys continuously from `:latest` while self-hosted installs pin arbitrary ages, so no
  build-time assumption is sound.
- The `/api/v1` OpenAI facade is untouched and its versioning (OpenAI's) stays orthogonal.
- `/api/health` keeps its infra-monitoring role; its broken `npm_package_version` field is
  out of scope here (it does not participate in the SDK handshake).
- Rate limiting for `GET /api/version` follows the standard public-endpoint posture
  (`packages/lib/src/auth/rate-limit-utils.ts`); the endpoint is constant-cost and
  constant-shape, so it adds no oracle surface.

## References

- Epic spec: PageSpace page `ea07mt5jvw0flihsbjce1iv9` (architecture + non-negotiables)
- Phase 0 contract: page `yrysra5lbw28b2h45p3ofv1q`; this task: page `g6mpdnhl1ffpg1cu0fox1tba`
- Behavior-parity source: `/Users/jono/production/pagespace-mcp` @ `5.2.3`
- House conventions cited inline: `apps/web/middleware.ts`,
  `apps/web/src/middleware/security-headers.ts`, `apps/web/src/app/api/health/route.ts`,
  `packages/lib/src/services/validated-service-token.ts`,
  `packages/lib/src/utils/fetch-with-timeout.ts`, `apps/web/Dockerfile`
