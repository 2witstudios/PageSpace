# Deployment Mode Isolation Gaps Epic

**Status**: ✅ COMPLETE
**Goal**: Close three cloud-credential leak vectors so on-prem deployments cannot call Resend, Google Calendar OAuth, or external AI providers.

## Overview

On-prem deployments were sharing cloud-only infrastructure — Resend email credentials, Google Calendar OAuth routes, and the full external AI provider set were all accessible regardless of `DEPLOYMENT_MODE`. Tenant mode is semantically cloud (managed multi-tenant SaaS) and is not restricted. Only `onprem` (self-hosted, security-tight) is gated. Each fix is a targeted `isOnPrem()` guard at the service or route boundary using utilities from `packages/lib/src/deployment-mode.ts`.

---

## Gate email-service in onprem mode

Add `isOnPrem()` guard in `packages/lib/src/services/email-service.ts`. In onprem mode skip Resend and log a warning — onprem uses password auth so magic-link emails are not needed.

**Implemented requirements**:
- Given cloud mode + `sendEmail()` call, should call Resend and send the email as before ✅
- Given tenant mode + `sendEmail()` call, should call Resend and send the email as before ✅
- Given onprem mode + `sendEmail()` call, should return without calling Resend and emit a warning log ✅
- Given onprem mode + `sendEmail()` call, should NOT throw (callers must not crash) ✅

---

## Gate Google Calendar routes with isOnPrem()

Add `if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 })` at the top of all 8 route handlers under `apps/web/src/app/api/integrations/google-calendar/` (connect, disconnect, status, callback, sync, settings GET+PATCH, calendars, webhook).

**Implemented requirements**:
- Given cloud mode + request to any calendar route, should proceed to normal handler logic ✅
- Given tenant mode + request to any calendar route, should proceed to normal handler logic ✅
- Given onprem mode + request to any calendar route, should return 404 before any DB or OAuth work ✅

---

## Gate AI provider visibility to onprem mode only

Fix two places: `getVisibleProviders()` in `apps/web/src/lib/ai/core/ai-providers-config.ts` (restrict only for onprem), and `isProviderBlocked()` in `apps/web/src/app/api/ai/settings/route.ts` (same scope — onprem only). Tenant mode retains full provider access.

**Implemented requirements**:
- Given onprem mode, `getVisibleProviders()` should return only providers in `ONPREM_ALLOWED_PROVIDERS` ✅
- Given cloud mode, `getVisibleProviders()` should return the full `AI_PROVIDERS` set ✅
- Given tenant mode, `getVisibleProviders()` should return the full `AI_PROVIDERS` set ✅
- Given onprem mode + external provider key save request, `isProviderBlocked()` should return true ✅
- Given cloud mode + external provider key save request, `isProviderBlocked()` should return false ✅

---
