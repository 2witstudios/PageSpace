# Security Hardening: Upload Cap + SIEM Error Delivery Epic

**Status**: 🔄 IN PROGRESS
**Goal**: Fix processor upload cap that blocks business-tier uploads, and wire application errors to SIEM delivery

## Overview

Business-tier users (100MB max file size) are being incorrectly rejected by the processor service's multer hard-cap of 50MB — the web layer already validated and approved their upload but the processor silently rejects it downstream. Additionally, application errors logged via `loggers.security.error()` and `loggers.api.error()` never reach the SIEM webhook; the existing SIEM infrastructure only ships structured audit log batches, leaving security-relevant runtime errors invisible to operators' alerting stack. Issues #978 (hash-chain verifier) and #989 (health endpoint) were verified already fixed during triage.

---

## Triage Verification

Document confirmed-fixed issues #978 and #989 in the PR.

**Requirements**:
- Given `apps/web/src/app/api/cron/verify-audit-chain/route.ts` exists and calls `verifyAndAlert`, should document #978 as already fixed
- Given `apps/web/src/app/api/health/route.ts` returns only structured status fields with no raw error bodies, should document #989 as already fixed

---

## Multer Upload Cap Fix (#1059)

Change processor multer default from 50MB to 100MB to match the maximum business tier.

**Requirements**:
- Given no `STORAGE_MAX_FILE_SIZE_MB` env var set, should default multer fileSize to 100MB (not 50MB, which blocks business-tier 100MB uploads)
- Given `STORAGE_MAX_FILE_SIZE_MB` is set, should use the configured value as the multer cap
- Given a configured env var value, should correctly apply that limit in bytes

---

## SIEM Error Delivery Hook (#858)

Wire logger error/fatal paths to fire-and-forget SIEM delivery via a registered hook.

**Requirements**:
- Given no SIEM hook registered, should not throw when `fireSiemErrorHook` is called
- Given a SIEM hook is registered and `logger.error()` fires, should call the hook with error payload
- Given a SIEM hook is registered and `logger.fatal()` fires, should call the hook
- Given the hook function throws, should not propagate — the logging path must survive hook failures
- Given a webhook URL + secret and `buildWebhookSiemErrorHook` is called, should POST error payload to webhook
- Given the webhook fetch rejects, should not throw (fire-and-forget)
- Given `logger.warn()` fires, should NOT trigger SIEM delivery (errors/fatals only)
- Given logger level is below ERROR, should NOT trigger SIEM delivery

---
