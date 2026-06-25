# GDPR Consent & Analytics Gating Epic

**Status**: ✅ COMPLETED (2026-06-25)
**Goal**: Make PageSpace's consent story lawful — gate non-essential cookies, analytics, and third-party scripts behind explicit opt-in; affirm minimum age at signup.

**Closes**: #923, #924, #921, #940, #922, #939. Pure consent core (11 tests in `packages/lib/src/consent`) + thin edges, TDD throughout. Cookie-policy legal copy left as a `{/* FILL: cookie policy copy */}` slot per the user-owned task.

**Scope note (2026-06-25 product call)**: the per-user AI-processing consent system (issue **#925**, originally Phase 2) was **dropped** — for an AI product, processing prompts is the contracted service under GDPR Art 6(1)(b), not a separate consent the user grants; cross-border disclosure belongs in the privacy policy / ToS, not a per-provider consent record. #925 is therefore **not** closed by this PR. The DOB-based age gate (#922, originally Phase 3) was **right-sized**: rather than a date-of-birth field + `users.ageVerifiedAt` column, age is folded into the existing Terms-of-Service affirmation every signup path already requires ("…and I am at least 16"), with an inline disclosure on the OAuth paths. #922 stays closed via that ToS affirmation.

## Overview

Because PageSpace currently fires first-party analytics on every page (incl. unauth), loads Google Identity Services / One Tap before any notice, sets preference cookies with no consent gate, and has no age affirmation, the platform violates GDPR Art 6/7/8/13/25 and ePrivacy Art 5(3). This epic ships the code/UX half: a consent banner + store, consent-gated analytics (mode-aware), deferred third-party scripts, a One Tap pre-consent notice with autoSelect off, and a minimum-age affirmation folded into the ToS checkbox at signup. All consent/gating decisions live in PURE functions (tested first, RED→GREEN); React components are thin shells. Cookie-policy legal copy is a separate user-owned task — banner ships with a clearly-marked FILL slot.

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

## Phase 2 — AI processing consent core — #925 — ❌ DROPPED

**Not shipped.** An earlier iteration built a per-user AI-processing consent record (table, `/api/consent/ai-processing` route, capture UI/hook, and a flag-gated server enforcement guard). The 2026-06-25 product call removed all of it: for an AI product, processing the user's prompts *is* the contracted service (GDPR Art 6(1)(b)), so a separate "consent" the user grants/revokes is the wrong legal basis. Cross-border processing is a **disclosure** obligation (privacy policy / ToS), not a per-provider consent record. Issue **#925** remains open and is **not** closed by this PR.

---

## Phase 3 — Age affirmation — #922

Right-sized from a DOB-based gate to a minimum-age affirmation folded into the Terms-of-Service checkbox that every signup path already requires. No date-of-birth field, no `users.ageVerifiedAt` column, no separate age-pure-logic module or `AGE_REQUIRED` plumbing.

### Signup age affirmation wiring

The existing "I agree to the Terms" affirmation is extended to "…and I am at least 16", so accepting it asserts both. Applies uniformly across passkey, magic-link, and OAuth signup; the OAuth buttons carry an inline age/ToS disclosure (no checkbox to intercept the redirect).

**Requirements**:
- Given any signup path (passkey, magic-link, OAuth), the user cannot complete signup without affirming the combined ToS + minimum-age statement.
- Given the magic-link path, the affirmation is always-required and mirrors the signin ToS checkbox, so it never leaks whether the email is new (enumeration resistance).
- Given the OAuth paths, the age/ToS affirmation is disclosed inline before the user leaves for the provider.

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
