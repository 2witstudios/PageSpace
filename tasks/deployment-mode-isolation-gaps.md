# Deployment Mode Isolation Gaps Epic

**Status**: 📋 PLANNED
**Goal**: Close three cloud-credential leak vectors so on-prem and tenant installs cannot call Resend, Google Calendar OAuth, or external AI providers.

## Overview

On-prem and tenant deployments currently share cloud-only infrastructure — Resend email credentials, Google Calendar OAuth routes, and the full external AI provider set are all accessible regardless of DEPLOYMENT_MODE. This creates compliance risk for self-hosted customers and credential leakage if an on-prem instance is compromised. Each fix is a targeted guard at the service or route boundary using the existing `isCloud()` / `isOnPrem()` / `isTenantMode()` utilities from `packages/lib/src/deployment-mode.ts`.

---

## Gate email-service in non-cloud modes

Add `isCloud()` guard in `packages/lib/src/services/email-service.ts`. In non-cloud modes skip sending and log a warning — on-prem uses password auth so magic-link emails are not expected; no new dependency needed.

**Requirements**:
- Given cloud mode + `sendEmail()` call, should call Resend and send the email as before
- Given onprem mode + `sendEmail()` call, should return without calling Resend and emit a warning log
- Given tenant mode + `sendEmail()` call, should return without calling Resend and emit a warning log
- Given onprem mode + `sendEmail()` call, should NOT throw (callers must not crash)

---

## Gate Google Calendar routes with isCloud()

Add `if (!isCloud()) return Response.json({ error: 'Not available' }, { status: 404 })` at the top of all 8 route handlers under `apps/web/src/app/api/integrations/google-calendar/` (connect, disconnect, status, callback, sync, settings, calendars, webhook).

**Requirements**:
- Given cloud mode + request to any calendar route, should proceed to normal handler logic
- Given onprem mode + request to any calendar route, should return 404 before any DB or OAuth work
- Given tenant mode + request to any calendar route, should return 404 before any DB or OAuth work

---

## Extend AI provider filtering to tenant mode

Fix two places: `getVisibleProviders()` in `apps/web/src/lib/ai/core/ai-providers-config.ts` (currently only checks onprem), and `isProviderBlocked()` in `apps/web/src/app/api/ai/settings/route.ts` (same gap). Tenant mode should apply the same `ONPREM_ALLOWED_PROVIDERS` allowlist as onprem.

**Requirements**:
- Given tenant mode, `getVisibleProviders()` should return only providers in `ONPREM_ALLOWED_PROVIDERS`
- Given onprem mode, `getVisibleProviders()` should continue returning only `ONPREM_ALLOWED_PROVIDERS` (no regression)
- Given cloud mode, `getVisibleProviders()` should return the full `AI_PROVIDERS` set
- Given tenant mode + external provider key save request, `isProviderBlocked()` should return true
- Given cloud mode + external provider key save request, `isProviderBlocked()` should return false

---
