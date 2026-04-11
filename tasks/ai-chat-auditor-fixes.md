# AI Chat Auditor Fixes

**Status**: COMPLETED
**Branch**: pu/ai-chat-auditor
**Context**: Review findings from SecurityAuditService wiring into AI/chat routes

## Requirements

### Fix 1: Audit failure visibility ✅
- Given a securityAudit call that rejects, should log a warning via loggers.api.warn instead of silently swallowing
- Given the warning, should include the error message and the resource type for debugging

### Fix 2: Request metadata in audit events ✅
- Given a Request object, should extract ipAddress from x-forwarded-for or x-real-ip headers
- Given a Request object, should extract userAgent from user-agent header
- Given extracted metadata, should pass ipAddress and userAgent as top-level AuditEvent fields (NOT inside details)

### Fix 3: Duplicate audit in global/route.ts GET ✅
- Given the paginated and legacy branches in GET /api/ai/global, should emit a single audit call, not two identical ones

### Fix 4: Premature audit in conversations POST ✅
- Given POST /api/ai/page-agents/[agentId]/conversations, should audit after the response data is assembled, not before

### Fix 5: GDPR hash chain compliance ✅
- Given ipAddress and userAgent are PII fields excluded from hash computation per #541, should NOT place them inside the details object (which IS hashed)
- Given the logAuditEvent helper, should call logEvent() directly with top-level ipAddress/userAgent fields instead of logDataAccess() which only accepts a details bag
- Given the hash chain invariant, should have a test that explicitly verifies PII stays out of the details object
