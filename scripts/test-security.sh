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

# =============================================================================
# Test database provisioning
#
# Several suites below (session service, device auth, permissions, magic-link
# and other web auth routes) are DB-backed integration tests. In CI the
# security workflow provides a Postgres service; locally this script must be
# just as self-sufficient — "green means green" only holds if a clean checkout
# can run `bun run test:security` and every suite actually executes.
#
# Strategy: honour an explicit DATABASE_URL if the caller set one (and fail
# fast if it is unreachable). Otherwise use the standard dockerized test DB
# (docker-compose.test.yml, port 5433 — the same one `bun run test` uses),
# starting it if it is not already up, and run migrations so the schema is
# current. The container is intentionally left running afterwards: it is
# shared across worktrees and uses tmpfs storage; stop it with
# `docker compose -f docker-compose.test.yml down --volumes` if needed.
# =============================================================================
DEFAULT_TEST_DB_URL="postgresql://user:password@localhost:5433/pagespace_test"
EXPLICIT_DB_URL="${DATABASE_URL:-}"
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_TEST_DB_URL}"
export NODE_ENV=test

db_reachable() {
    bun -e 'const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
c.connect().then(() => c.query("select 1")).then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));' \
        >/dev/null 2>&1
}

if ! db_reachable; then
    if [ -n "$EXPLICIT_DB_URL" ]; then
        echo -e "${RED}✗ DATABASE_URL is set but not reachable: ${EXPLICIT_DB_URL}${NC}"
        echo "  Unset DATABASE_URL to let this script manage the dockerized test DB,"
        echo "  or point it at a reachable Postgres."
        exit 1
    fi
    echo "Starting dockerized test Postgres (docker-compose.test.yml, port 5433)..."
    # The container has a fixed name shared across worktrees. If another
    # checkout already created it (even stopped), `docker compose up` here
    # fails with a name conflict because compose scopes containers by project
    # directory — start the existing container by name instead.
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'pagespace-postgres-test'; then
        STARTED=$(docker start pagespace-postgres-test 2>/dev/null || true)
        if [ -z "$STARTED" ]; then
            echo -e "${RED}✗ Could not start the existing pagespace-postgres-test container.${NC}"
            echo "  Remove it (docker rm -f pagespace-postgres-test) and re-run, or check Docker."
            exit 1
        fi
    elif ! docker compose -f docker-compose.test.yml up -d postgres-test; then
        echo -e "${RED}✗ Could not start the test Postgres container.${NC}"
        echo "  The DB-backed security suites need it. Is Docker running?"
        exit 1
    fi
    WAITED=0
    until db_reachable; do
        WAITED=$((WAITED + 1))
        if [ $WAITED -gt 60 ]; then
            echo -e "${RED}✗ Test Postgres did not become ready within 60s.${NC}"
            exit 1
        fi
        sleep 1
    done
fi

echo "Running database migrations against ${DATABASE_URL}..."
if ! bun run db:migrate; then
    echo -e "${RED}✗ Database migrations failed — aborting before running suites.${NC}"
    exit 1
fi
echo ""

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

# Some DB-backed integration suites are deliberately excluded from
# @pagespace/lib's default vitest config (packages/lib/vitest.config.ts), so
# running them through the plain `test` script finds no files and vitest exits
# 1 with "No test files found". They must go through the DB-aware config
# (`test:db` → vitest.security.config.ts), exactly as the security CI workflow
# (.github/workflows/security.yml) runs them.
run_db_test_suite() {
    local name="$1"
    local filter="$2"
    local path="$3"

    TOTAL=$((TOTAL + 1))
    echo -e "${YELLOW}▶ Running: ${name}${NC}"

    if bun run --filter "$filter" test:db -- "$path" --reporter=dot 2>&1; then
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
run_db_test_suite "Session Service" "@pagespace/lib" "src/auth/__tests__/session-service.test.ts"
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
run_db_test_suite "Device Auth Utilities" "@pagespace/lib" "src/__tests__/device-auth-utils.test.ts"
run_test_suite "Device Fingerprint Utilities" "@pagespace/lib" "src/__tests__/device-fingerprint-utils.test.ts"
run_test_suite "Rate Limit Utilities" "@pagespace/lib" "src/__tests__/rate-limit-utils.test.ts"
run_test_suite "Security Test Utilities" "@pagespace/lib" "src/__tests__/security-test-utils.test.ts"

# =============================================================================
# Authorization & Multi-Tenant Tests
# =============================================================================
echo "🏢 Authorization & Multi-Tenant Isolation"
echo "------------------------------------------"

run_test_suite "Multi-Tenant Isolation" "@pagespace/lib" "src/__tests__/multi-tenant-isolation.test.ts"
run_db_test_suite "Permissions" "@pagespace/lib" "src/__tests__/permissions.test.ts"

# =============================================================================
# Web App Auth Route Tests
# =============================================================================
echo "🌐 Web App Auth Routes"
echo "----------------------"

# RETIRED (PR #861 removed all password-based authentication): the "Login
# Route" (login.test.ts), "Signup Route" (signup.test.ts) and "Mobile Login"
# (mobile-login.test.ts) suites referenced routes and tests deleted in that
# PR — vitest exited 1 with "No test files found" on every checkout. The
# sign-in surfaces that replaced password auth are covered by the suites
# below: magic-link, passkey (including passkey signup), the mobile OAuth
# exchange/refresh routes, and the Google OAuth section further down.
# Directory-prefix filters are deliberate so new route tests under those
# paths are picked up automatically instead of drifting like the retired
# entries did.
run_test_suite "Magic Link Auth Routes (send/verify/round-trip/desktop)" "web" "src/app/api/auth/magic-link"
run_test_suite "Passkey Auth Routes (register/authenticate/manage/handoff)" "web" "src/app/api/auth/passkey"
run_test_suite "Passkey Signup Routes" "web" "src/app/api/auth/signup-passkey"
run_test_suite "Mobile Auth Routes (OAuth exchange + refresh)" "web" "src/app/api/auth/__tests__/mobile-"
run_test_suite "Logout Route" "web" "src/app/api/auth/__tests__/logout.test.ts"
run_test_suite "CSRF Protection" "web" "src/app/api/auth/__tests__/csrf.test.ts"
run_test_suite "Device Token Refresh" "web" "src/app/api/auth/__tests__/device-refresh.test.ts"
run_test_suite "Session Fixation Prevention" "web" "src/app/api/auth/__tests__/session-fixation.test.ts"
run_test_suite "MCP Tokens" "web" "src/app/api/auth/__tests__/mcp-tokens.test.ts"
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
