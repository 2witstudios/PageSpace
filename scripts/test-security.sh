#!/bin/bash
# Security Test Suite Runner
# P5-T4: Runs all security-related tests for the PageSpace codebase
#
# Usage: pnpm test:security
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

    # Use pnpm --filter with test script, passing the path as an argument
    if pnpm --filter "$filter" test -- "$path" --reporter=dot 2>&1; then
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
run_test_suite "Security Redis (Unit)" "@pagespace/lib" "src/security/__tests__/security-redis.test.ts"

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
run_test_suite "Permissions (Cached)" "@pagespace/lib" "src/__tests__/permissions-cached.test.ts"
run_test_suite "Permission Cache" "@pagespace/lib" "src/__tests__/permission-cache.test.ts"

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
# Processor Security Tests
# =============================================================================
echo "⚙️ Processor Security"
echo "---------------------"

run_test_suite "Processor Security Utils" "processor" "tests/security-utils.test.ts"

# =============================================================================
# Database Transaction Security Tests
# =============================================================================
echo "💾 Database Transaction Security"
echo "---------------------------------"

run_test_suite "Auth Transactions (Race Conditions)" "@pagespace/db" "src/transactions/__tests__/auth-transactions.test.ts"

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
