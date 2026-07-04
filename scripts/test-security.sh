#!/bin/bash
# Security Test Suite Runner
# P5-T4: Runs all security-related tests for the PageSpace codebase
#
# Usage: bun run test:security
#
# This script runs comprehensive security tests including:
# - Core security modules (rate limiting, path validation, URL validation)
# - Authentication modules (tokens, sessions, CSRF)
# - Authorization (permissions, multi-tenant isolation)
# - API route security tests
# - Processor security tests

set -e

echo "🔒 PageSpace Security Test Suite"
echo "================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILED=0
TOTAL=0

run_test_suite() {
    local name="$1"
    local filter="$2"
    local path="$3"

    TOTAL=$((TOTAL + 1))
    echo -e "${YELLOW}▶ Running: ${name}${NC}"

    if bun run --filter "$filter" test -- "$path" --reporter=dot 2>&1; then
        echo -e "${GREEN}✓ ${name} passed${NC}"
        echo ""
    else
        echo -e "${RED}✗ ${name} failed${NC}"
        echo ""
        FAILED=$((FAILED + 1))
    fi
}

# Some packages (@pagespace/cli, @pagespace/sdk) wire a `pretest: bun run
# build` hook (tsc must run before vitest sees the compiled dist types).
# `bun run --filter <pkg> test -- <args>` forwards trailing args to EVERY
# script in that chain, including pretest — so `-- src --reporter=dot` reaches
# `tsc` as stray positional args and it refuses to build ("Unknown compiler
# option '--reporter=dot'"), failing the suite before vitest ever runs a
# single test. Building explicitly first, then invoking vitest directly
# (bypassing the `test` npm-script's arg-forwarding entirely), avoids that.
run_full_package_suite() {
    local name="$1"
    local pkg_dir="$2"

    TOTAL=$((TOTAL + 1))
    echo -e "${YELLOW}▶ Running: ${name}${NC}"

    if (cd "$pkg_dir" && bun run build && bunx vitest run src --reporter=dot) 2>&1; then
        echo -e "${GREEN}✓ ${name} passed${NC}"
        echo ""
    else
        echo -e "${RED}✗ ${name} failed${NC}"
        echo ""
        FAILED=$((FAILED + 1))
    fi
}

# =============================================================================
# Core Security Module Tests (packages/lib/src/security)
# =============================================================================
echo "📦 Core Security Modules"
echo "------------------------"

run_test_suite "Distributed Rate Limiting" "@pagespace/lib" "src/security/__tests__/distributed-rate-limit.test.ts"
run_test_suite "Path Traversal Prevention" "@pagespace/lib" "src/security/__tests__/path-validator.test.ts"
run_test_suite "SSRF URL Validation" "@pagespace/lib" "src/security/__tests__/url-validator.test.ts"
run_test_suite "JTI Revocation (Integration)" "@pagespace/lib" "src/security/__tests__/jti-revocation.integration.test.ts"

# =============================================================================
# Authentication Module Tests (packages/lib/src/auth)
# =============================================================================
echo "🔐 Authentication Modules"
echo "-------------------------"

run_test_suite "Opaque Token Generation" "@pagespace/lib" "src/auth/__tests__/opaque-tokens.test.ts"
run_test_suite "Session Service" "@pagespace/lib" "src/auth/__tests__/session-service.test.ts"
run_test_suite "Exchange Codes" "@pagespace/lib" "src/auth/__tests__/exchange-codes.test.ts"

# =============================================================================
# Security Utilities Tests (packages/lib/src/__tests__)
# =============================================================================
echo "🛡️ Security Utilities"
echo "---------------------"

run_test_suite "Secure Compare (Timing-Safe)" "@pagespace/lib" "src/__tests__/secure-compare.test.ts"
run_test_suite "CSRF Utilities" "@pagespace/lib" "src/__tests__/csrf-utils.test.ts"
run_test_suite "Token Utilities" "@pagespace/lib" "src/__tests__/token-utils.test.ts"
run_test_suite "Token Lookup" "@pagespace/lib" "src/__tests__/token-lookup.test.ts"
run_test_suite "Broadcast Auth (HMAC Signatures)" "@pagespace/lib" "src/__tests__/broadcast-auth.test.ts"
run_test_suite "Encryption Utilities" "@pagespace/lib" "src/__tests__/encryption-utils.test.ts"
run_test_suite "Device Auth Utilities" "@pagespace/lib" "src/__tests__/device-auth-utils.test.ts"
run_test_suite "Device Fingerprint Utilities" "@pagespace/lib" "src/__tests__/device-fingerprint-utils.test.ts"
run_test_suite "Rate Limit Utilities" "@pagespace/lib" "src/__tests__/rate-limit-utils.test.ts"
run_test_suite "Security Test Utilities" "@pagespace/lib" "src/__tests__/security-test-utils.test.ts"

# =============================================================================
# Authorization & Multi-Tenant Tests
# =============================================================================
echo "🏢 Authorization & Multi-Tenant Isolation"
echo "------------------------------------------"

run_test_suite "Multi-Tenant Isolation" "@pagespace/lib" "src/__tests__/multi-tenant-isolation.test.ts"
run_test_suite "Permissions" "@pagespace/lib" "src/__tests__/permissions.test.ts"

# =============================================================================
# Web App Auth Route Tests
# =============================================================================
echo "🌐 Web App Auth Routes"
echo "----------------------"

run_test_suite "Login Route" "web" "src/app/api/auth/__tests__/login.test.ts"
run_test_suite "Signup Route" "web" "src/app/api/auth/__tests__/signup.test.ts"
run_test_suite "Logout Route" "web" "src/app/api/auth/__tests__/logout.test.ts"
run_test_suite "CSRF Protection" "web" "src/app/api/auth/__tests__/csrf.test.ts"
run_test_suite "Device Token Refresh" "web" "src/app/api/auth/__tests__/device-refresh.test.ts"
run_test_suite "Session Fixation Prevention" "web" "src/app/api/auth/__tests__/session-fixation.test.ts"
run_test_suite "MCP Tokens" "web" "src/app/api/auth/__tests__/mcp-tokens.test.ts"
run_test_suite "Mobile Login" "web" "src/app/api/auth/__tests__/mobile-login.test.ts"
run_test_suite "Email Verification" "web" "src/app/api/auth/__tests__/verify-email.test.ts"

# =============================================================================
# Web App Auth Library Tests
# =============================================================================
echo "📚 Web App Auth Library"
echo "-----------------------"

run_test_suite "Auth Middleware" "web" "src/lib/auth/__tests__/auth-middleware.test.ts"
run_test_suite "Auth Fetch" "web" "src/lib/auth/__tests__/auth-fetch.test.ts"
run_test_suite "CSRF Validation" "web" "src/lib/auth/__tests__/csrf-validation.test.ts"
run_test_suite "Origin Validation" "web" "src/lib/auth/__tests__/origin-validation.test.ts"
run_test_suite "Cookie Config" "web" "src/lib/auth/__tests__/cookie-config.test.ts"
run_test_suite "Admin Role Versioning" "web" "src/lib/auth/__tests__/admin-role-version.test.ts"

# =============================================================================
# Google OAuth Security Tests
# =============================================================================
echo "🔑 Google OAuth Security"
echo "------------------------"

run_test_suite "Google One Tap" "web" "src/app/api/auth/google/__tests__/one-tap.test.ts"
run_test_suite "Open Redirect Protection" "web" "src/app/api/auth/google/__tests__/open-redirect-protection.test.ts"

# =============================================================================
# Security Headers Tests
# =============================================================================
echo "📋 Security Headers"
echo "-------------------"

run_test_suite "CSP & Security Headers" "web" "src/middleware/__tests__/security-headers.test.ts"

# =============================================================================
# MCP WebSocket Security Tests
# =============================================================================
echo "🔌 MCP WebSocket Security"
echo "-------------------------"

run_test_suite "MCP WebSocket Route Security" "web" "src/app/api/mcp-ws/__tests__/route.security.test.ts"

# =============================================================================
# AI Tool Security Tests
# =============================================================================
echo "🤖 AI Tool Security"
echo "-------------------"

run_test_suite "web_fetch SSRF Decision (pure)" "web" "src/lib/ai/tools/__tests__/web-fetch-ssrf.test.ts"
run_test_suite "web_fetch SSRF (redirect/rebind)" "web" "src/lib/ai/tools/__tests__/web-search-tools.test.ts"

# =============================================================================
# Processor Security Tests
# =============================================================================
echo "⚙️ Processor Security"
echo "---------------------"

run_test_suite "Processor Security Utils" "@pagespace/processor" "tests/security-utils.test.ts"

# =============================================================================
# Database Transaction Security Tests
# =============================================================================
echo "💾 Database Transaction Security"
echo "---------------------------------"

run_test_suite "Auth Transactions (Race Conditions)" "@pagespace/db" "src/transactions/__tests__/auth-transactions.test.ts"

# =============================================================================
# OAuth 2.1 Provider, SDK, CLI & MCP Adapter (SDK/CLI/OAuth epic — Phase 7
# zero-trust audit). Whole-package runs for @pagespace/cli and @pagespace/sdk
# are deliberate, not lazy: virtually every file in both packages is auth
# surface (credential storage, token exchange/rotation, the MCP adapter's
# error-formatting boundary) and the epic is still under active development —
# a per-file allowlist here would silently stop covering new auth code the
# moment a task added a file without also editing this script. Directory-glob
# runs for the oauth pure logic and API routes make new files under those
# directories covered automatically for the same reason.
# =============================================================================
echo "🔑 OAuth 2.1 Provider (packages/lib/src/auth/oauth — PKCE, scopes, code/device/refresh lifecycle, redirect_uri, clients)"
echo "-----------------------------------------------------------------------------------------------------------------------"

run_test_suite "OAuth Provider Pure Logic (PKCE/scopes/code-lifecycle/refresh-rotation/clients/user-code/authorize-request/consent/metadata)" "@pagespace/lib" "src/auth/oauth"

echo "🔑 OAuth 2.1 Provider API Routes & Repository (apps/web — authorize/token/device/revoke, atomic grant persistence)"
echo "---------------------------------------------------------------------------------------------------------------"

run_test_suite "OAuth API Routes (authorize/token/device_authorization/revoke + hardening sweep)" "web" "src/app/api/oauth"
run_test_suite "OAuth Repository (atomic code exchange/refresh rotation/device poll persistence)" "web" "src/lib/repositories/__tests__/oauth-repository"
run_test_suite "OAuth Scope Narrowing (principal-permissions dispatch, drive-scoped MCP/OAuth token enforcement)" "web" "src/lib/auth/__tests__/principal-permissions.test.ts"
run_test_suite "OAuth Scope Enforcement (mcp-scope-enforcement, drive-scope 403 boundary)" "web" "src/lib/auth/__tests__/mcp-scope-enforcement.test.ts"

echo "🔑 pagespace CLI (packages/cli — login/device-login, credential store, auth precedence, tokens, mcp adapter)"
echo "----------------------------------------------------------------------------------------------------------"

run_full_package_suite "pagespace CLI (full package — every command authenticates through the same precedence resolver)" "packages/cli"

echo "🔑 pagespace SDK (packages/sdk — auth providers, error classification, operation registry)"
echo "--------------------------------------------------------------------------------------------"

run_full_package_suite "pagespace SDK (full package — StaticTokenProvider/OAuthTokenProvider, typed error hierarchy)" "packages/sdk"

# =============================================================================
# Security Audit Coverage Gate
# =============================================================================
echo "📋 Security Audit Coverage"
echo "--------------------------"

run_test_suite "Security Audit Route Coverage" "web" "src/app/api/__tests__/security-audit-coverage.test.ts"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "================================="
echo "🔒 Security Test Suite Summary"
echo "================================="

PASSED=$((TOTAL - FAILED))

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All ${TOTAL} test suites passed${NC}"
    exit 0
else
    echo -e "${RED}✗ ${FAILED}/${TOTAL} test suites failed${NC}"
    echo -e "${GREEN}✓ ${PASSED}/${TOTAL} test suites passed${NC}"
    exit 1
fi
