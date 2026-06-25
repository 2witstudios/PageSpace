# GDPR Consent & Analytics Gating Epic

**Status**: ✅ COMPLETED (2026-06-24)
**Goal**: Make PageSpace's consent story lawful — gate non-essential cookies, analytics, and third-party scripts behind explicit opt-in; record AI cross-border processing consent; verify age at signup.

**Closes**: #923, #924, #925, #921, #940, #922, #939. All phases shipped; pure consent core (40 tests in `packages/lib/src/consent`) + thin edges, TDD throughout. Cookie-policy legal copy left as a `{/* FILL: cookie policy copy */}` slot per the user-owned task.

## Overview

Because PageSpace currently fires first-party analytics on every page (incl. unauth), loads Google Identity Services / One Tap before any notice, sets preference cookies with no consent gate, keeps no per-user record that prompts leave the platform, and has no age gate, the platform violates GDPR Art 6/7/8/13/25 and ePrivacy Art 5(3). This epic ships the code/UX half: a consent banner + store, consent-gated analytics (mode-aware), deferred third-party scripts, a per-user AI-processing consent record + capture UI, a One Tap pre-consent notice with autoSelect off, and a signup age gate. All consent/gating decisions live in PURE functions (tested first, RED→GREEN); React components are thin shells. Cookie-policy legal copy is a separate user-owned task — banner ships with a clearly-marked FILL slot.

---

## Phase 1 — Pure consent core (packages/lib)

### Consent model + cookie serialization

Pure types + cookie (de)serialization for the consent state that every gate reads.

**Requirements**:
- Given a raw consent cookie string that is missing/malformed, when parsed, should return the default state with only the necessary category granted.
- Given a consent state, when serialized then re-parsed, should round-trip identically (including a version field).
- Given a stored consent of an older schema version, when parsed, should be treated as no-consent so the banner re-shows.

### Category gating decisions

Pure predicates that gate categories and the consent banner.

**Requirements**:
- Given a consent state, when asked if a non-necessary category is allowed, should return true only if that category was explicitly granted.
- Given the necessary category, should always report allowed regardless of stored state.
- Given a default (no-decision) consent state, when asked whether to show the banner, should return true; given any explicit accept/reject decision, should return false.

### Analytics gate (mode-aware) — #924 + #939

Single pure function combining consent + deployment mode for the analytics tracker.

**Requirements**:
- Given onprem mode, should never fire analytics even if analytics consent is granted.
- Given cloud/tenant mode with analytics consent granted, should fire analytics.
- Given cloud/tenant mode with analytics consent not granted (default or rejected), should not fire analytics.

### Third-party script gate — #940

Pure decision for whether the Google Identity Services script may load.

**Requirements**:
- Given a consent state without the required (preferences/auth) category granted, when asked if the GIS script may load, should return false.
- Given that category granted, should return true.

---

## Phase 2 — AI processing consent core — #925

### AI consent record shaping + validity

Pure shaping of the per-user AI-processing consent record and a validity check.

**Requirements**:
- Given a user id, policy version, and timestamp, when building an AI-processing consent record, should produce a record carrying userId, the policy version, consentedAt, and a null revokedAt.
- Given a consent record whose policy version matches the current version and revokedAt is null, should report valid AI consent.
- Given a consent record that is revoked or whose policy version is stale, should report invalid (re-consent required).

### AI consent DB table

New Drizzle table for the AI-processing consent record (schema + generated migration).

**Requirements**:
- Given the schema package, should expose an `aiProcessingConsents` table keyed by user with policyVersion, consentedAt, revokedAt, and a unique constraint preventing duplicate active rows per user.
- Given a schema change, the migration should be produced by `db:generate` (never hand-written) and not collide with existing migration numbering.

---

## Phase 3 — Age gate — #922

### Minimum-age pure logic

Pure age computation honoring Art 8's 16-year default.

**Requirements**:
- Given a date of birth and a reference date, when computing age, should not count the current year's birthday until it has passed.
- Given a date of birth that yields an age below the configured minimum (default 16), should report the age requirement as not met.
- Given a malformed/absent date of birth, should report the requirement as not met (fail closed).

### Signup age field wiring

Thread the age confirmation through the passkey signup edge (form → route → user creation), persisting verification minimally.

**Requirements**:
- Given a signup request asserting an age below the minimum, the signup edge should reject it before creating a user.
- Given a successful signup, the user record should persist that age was verified at signup time.

---

## Phase 4 — Client consent store + banner — #923

### Consent store (client)

Thin zustand store wrapping the Phase-1 pure cookie functions.

**Requirements**:
- Given the store initializes, should hydrate from the consent cookie via the pure parser (no logic duplicated in the store).
- Given accept-all / reject-non-essential / save-custom actions, should persist via the pure serializer and update in-memory state.

### Cookie banner + provider

Thin React banner + provider; placeholder cookie-policy copy with a FILL slot.

**Requirements**:
- Given no prior consent decision, the provider should surface the banner; given a decision exists, should not.
- Given the banner renders, should include a clearly-marked `{/* FILL: cookie policy copy */}` slot and not block the necessary category.

---

## Phase 5 — Gate the live surfaces

### Gate analytics tracker — #924 + #939

Make the client tracker consult the mode-aware analytics gate before any send (incl. auto page-view on load).

**Requirements**:
- Given analytics is not permitted (no consent or onprem), the tracker should make zero network sends, including the initial auto page-view.
- Given consent is later granted, subsequent tracking calls should send.

### One Tap pre-consent + autoSelect off — #921 + #940

Pre-consent notice gates One Tap; autoSelect defaults false; GIS script deferred behind the Phase-1 script gate.

**Requirements**:
- Given default props, One Tap should initialize with auto_select false.
- Given consent for the third-party/auth category is absent, the GIS script should not be injected and the prompt should not display until the user acts on the notice.
- Given the user accepts the notice, the script loads and the prompt displays.

---
