# Clean Authentication Refactor Plan

## Problem Statement

**Context**: During implementation of MCP 2.0 backend endpoints, we discovered a critical authentication architecture issue that created both security vulnerabilities and massive code duplication.

**The Issue**: PageSpace has two types of API access that require different authentication:
1. **Web Session Access**: Browser-based users with JWT tokens from login sessions
2. **MCP API Access**: External tools (Claude Code, Claude Desktop) with database-stored MCP tokens

**What Went Wrong**: As the codebase evolved, two incompatible authentication patterns emerged:
- **Legacy MCP endpoints**: Each file duplicated 40+ lines of MCP token validation code
- **Newer endpoints**: Used a shared `authenticateRequest()` function designed only for web JWT tokens
- **Recent "fix"**: Made the shared function accept both token types, creating security risks

**Security Problem**: The current "universal" authentication allows MCP tokens (intended for external API access) to access internal web features like AI conversations, user settings, and monitoring endpoints. This violates the principle of least privilege and creates audit/security concerns.

**Code Quality Problem**: 11+ files contain identical `validateMCPToken()` functions, totaling ~440 lines of duplicated code that's hard to maintain and prone to inconsistencies.

**The Solution**: A clean refactor that separates authentication by intent, eliminates code duplication, and ensures proper security boundaries between MCP API access and web session access.

---

## Current Authentication Mess

**Problems Identified:**
1. **11 files** have duplicated `validateMCPToken()` functions (copy/paste hell)
2. **25+ files** use shared `authenticateRequest()` that now accepts both token types unsafely
3. **No clear separation** between MCP API access and web session access
4. **Security risk**: MCP tokens can now access web-only features they shouldn't

## Proposed Clean Architecture

### 1. Create Dedicated Authentication Module
**File**: `/apps/web/src/lib/auth/index.ts`

```typescript
// Core token validation functions
export async function validateMCPToken(token: string): Promise<{ userId: string } | null>
export async function validateJWTToken(token: string): Promise<{ userId: string } | null>

// Specific authentication functions for different use cases
export async function authenticateMCPRequest(request: Request): Promise<AuthResult>
export async function authenticateWebRequest(request: Request): Promise<AuthResult>
export async function authenticateHybridRequest(request: Request): Promise<AuthResult>
```

### 2. Endpoint Classification & Migration

**MCP-Only Endpoints (use `authenticateMCPRequest`):**
- All search endpoints (`/drives/[id]/search/*`)
- All batch endpoints (`/pages/bulk/*`)
- All agent endpoints (`/agents/*`)
- All original MCP endpoints (`/drives`, `/pages`, `/mcp/*`)
- **Count**: ~25 endpoints

**Web-Only Endpoints (use `authenticateWebRequest`):**
- AI conversations (`/ai_conversations/*`)
- Settings (`/ai/settings`)
- Monitoring (`/monitoring/*`)
- Tracking (`/track`)
- **Count**: ~15 endpoints

**Hybrid Endpoints (rare, explicit choice):**
- AI chat (`/ai/chat`) - might need both MCP and web access
- **Count**: ~2 endpoints

### 3. Security Benefits

**Explicit Token Scope:**
- MCP tokens can ONLY access MCP API endpoints
- Web tokens can ONLY access web session endpoints
- No accidental cross-access

**Audit Trail:**
- Clear logging of token type used per request
- Separate rate limiting per token type
- Security monitoring per access pattern

**Code Clarity:**
- No more duplicated `validateMCPToken()` functions
- Clear intent: MCP vs Web vs Hybrid access
- Type-safe authentication results

### 4. Migration Strategy

**Phase 1: Create clean auth module**
- Consolidate all token validation logic
- Add comprehensive tests

**Phase 2: Migrate MCP endpoints**
- Replace all duplicated MCP validation
- Use `authenticateMCPRequest()` only

**Phase 3: Secure web endpoints**
- Change web endpoints to `authenticateWebRequest()`
- Remove MCP access from web-only features

**Phase 4: Cleanup**
- Remove old duplicated functions
- Add security tests

### 5. Code Reduction

**Before**: 11 files × ~40 lines = ~440 lines of duplicated code
**After**: 1 auth module = ~100 lines total
**Savings**: ~340 lines removed + security + maintainability

This refactor eliminates code duplication, improves security, and makes authentication intent explicit throughout the codebase.

## Implementation Details

### Authentication Module Structure

```typescript
// apps/web/src/lib/auth/index.ts

export interface AuthResult {
  userId: string;
  tokenType: 'mcp' | 'jwt';
  error?: never;
}

export interface AuthError {
  userId?: never;
  tokenType?: never;
  error: NextResponse;
}

export type AuthenticationResult = AuthResult | AuthError;

// Core validation functions
export async function validateMCPToken(token: string): Promise<{ userId: string } | null>;
export async function validateJWTToken(token: string): Promise<{ userId: string } | null>;

// Endpoint-specific authentication
export async function authenticateMCPRequest(request: Request): Promise<AuthenticationResult>;
export async function authenticateWebRequest(request: Request): Promise<AuthenticationResult>;
export async function authenticateHybridRequest(request: Request): Promise<AuthenticationResult>;
```

### Migration Checklist

**MCP Endpoints to Migrate:**
- [ ] `/api/drives/route.ts`
- [ ] `/api/drives/[driveId]/route.ts`
- [ ] `/api/drives/[driveId]/pages/route.ts`
- [ ] `/api/drives/[driveId]/trash/route.ts`
- [ ] `/api/drives/[driveId]/restore/route.ts`
- [ ] `/api/pages/route.ts`
- [ ] `/api/pages/[pageId]/route.ts`
- [ ] `/api/pages/[pageId]/restore/route.ts`
- [ ] `/api/pages/reorder/route.ts`
- [ ] `/api/trash/drives/[driveId]/route.ts`
- [ ] `/api/mcp/documents/route.ts`
- [ ] `/api/mcp/drives/route.ts`
- [ ] `/api/drives/[driveId]/search/regex/route.ts`
- [ ] `/api/drives/[driveId]/search/glob/route.ts`
- [ ] `/api/search/multi-drive/route.ts`
- [ ] `/api/pages/bulk/move/route.ts`
- [ ] `/api/pages/bulk/rename/route.ts`
- [ ] `/api/pages/bulk/delete/route.ts`
- [ ] `/api/pages/bulk/update-content/route.ts`
- [ ] `/api/pages/bulk/create-structure/route.ts`
- [ ] `/api/agents/create/route.ts`
- [ ] `/api/agents/[agentId]/config/route.ts`
- [ ] `/api/drives/[driveId]/agents/route.ts`
- [ ] `/api/agents/multi-drive/route.ts`
- [ ] `/api/agents/consult/route.ts`

**Web Endpoints to Secure:**
- [ ] `/api/ai_conversations/*`
- [ ] `/api/ai/settings/*`
- [ ] `/api/monitoring/*`
- [ ] `/api/track/route.ts`
- [ ] `/api/debug/*`

**Hybrid Endpoints (careful consideration):**
- [ ] `/api/ai/chat/route.ts` - needs analysis
- [ ] `/api/ai/chat/messages/route.ts` - needs analysis

### Security Validation

**After migration, verify:**
- [ ] MCP tokens cannot access `/ai_conversations`
- [ ] MCP tokens cannot access `/ai/settings`
- [ ] MCP tokens cannot access `/monitoring`
- [ ] Web tokens cannot access MCP-specific endpoints
- [ ] All duplicated `validateMCPToken` functions removed
- [ ] Comprehensive authentication tests added
- [ ] Security audit of token scopes completed