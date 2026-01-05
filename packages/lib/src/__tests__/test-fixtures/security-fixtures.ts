/**
 * Security Test Fixtures
 *
 * Pre-defined test data for security testing scenarios.
 * Use these to ensure consistent test cases across the codebase.
 */

// =============================================================================
// User Fixtures
// =============================================================================

export const testUsers = {
  admin: {
    id: 'user_admin_001',
    email: 'admin@test.local',
    role: 'admin' as const,
    tokenVersion: 1,
  },
  regularUser: {
    id: 'user_regular_001',
    email: 'user@test.local',
    role: 'user' as const,
    tokenVersion: 1,
  },
  suspendedUser: {
    id: 'user_suspended_001',
    email: 'suspended@test.local',
    role: 'user' as const,
    tokenVersion: 1,
    suspendedAt: new Date('2024-01-01'),
  },
  deletedUser: {
    id: 'user_deleted_001',
    email: 'deleted@test.local',
    role: 'user' as const,
    tokenVersion: 1,
    deletedAt: new Date('2024-01-01'),
  },
};

// =============================================================================
// Drive/Tenant Fixtures
// =============================================================================

export const testDrives = {
  tenantA: {
    id: 'drive_tenant_a',
    name: 'Tenant A Drive',
    ownerId: testUsers.regularUser.id,
  },
  tenantB: {
    id: 'drive_tenant_b',
    name: 'Tenant B Drive',
    ownerId: 'user_tenant_b_owner',
  },
};

export const testDriveMembers = {
  tenantAOwner: {
    driveId: testDrives.tenantA.id,
    userId: testUsers.regularUser.id,
    role: 'owner' as const,
  },
  tenantAViewer: {
    driveId: testDrives.tenantA.id,
    userId: 'user_viewer_001',
    role: 'viewer' as const,
  },
  tenantAEditor: {
    driveId: testDrives.tenantA.id,
    userId: 'user_editor_001',
    role: 'editor' as const,
  },
};

// =============================================================================
// Page Fixtures
// =============================================================================

export const testPages = {
  tenantAPage: {
    id: 'page_tenant_a_001',
    driveId: testDrives.tenantA.id,
    title: 'Tenant A Test Page',
  },
  tenantBPage: {
    id: 'page_tenant_b_001',
    driveId: testDrives.tenantB.id,
    title: 'Tenant B Test Page',
  },
};

// =============================================================================
// Token Fixtures
// =============================================================================

export const testTokens = {
  validRefreshToken: {
    id: 'rt_valid_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_valid_refresh_token',
    tokenPrefix: 'ps_rt_valid',
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: null,
  },
  expiredRefreshToken: {
    id: 'rt_expired_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_expired_refresh_token',
    tokenPrefix: 'ps_rt_expir',
    tokenVersion: 1,
    expiresAt: new Date(Date.now() - 1000),
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    revokedAt: null,
  },
  revokedRefreshToken: {
    id: 'rt_revoked_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_revoked_refresh_token',
    tokenPrefix: 'ps_rt_revok',
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: new Date(),
  },
};

// =============================================================================
// Rate Limit Test Scenarios
// =============================================================================

export const rateLimitScenarios = {
  login: {
    key: 'login:user@test.local',
    limit: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
  },
  signup: {
    key: 'signup:203.0.113.1',
    limit: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
  },
  api: {
    key: 'api:user_regular_001',
    limit: 100,
    windowMs: 60 * 1000, // 1 minute
  },
  fileUpload: {
    key: 'upload:user_regular_001',
    limit: 20,
    windowMs: 60 * 1000, // 1 minute
  },
};

// =============================================================================
// CSRF Test Data
// =============================================================================

export const csrfTestData = {
  validToken: 'csrf_valid_token_abc123',
  expiredToken: 'csrf_expired_token_xyz789',
  tamperedToken: 'csrf_tampered_token_000',
};

// =============================================================================
// Session Fixtures
// =============================================================================

export const testSessions = {
  validSession: {
    id: 'sess_valid_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_valid_session',
    tokenPrefix: 'ps_sess_val',
    type: 'user' as const,
    scopes: ['*'],
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: null,
  },
  serviceSession: {
    id: 'sess_service_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_service_session',
    tokenPrefix: 'ps_svc_ser',
    type: 'service' as const,
    scopes: ['files:read', 'files:write'],
    resourceType: 'page',
    resourceId: testPages.tenantAPage.id,
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: null,
  },
  mcpSession: {
    id: 'sess_mcp_001',
    userId: testUsers.regularUser.id,
    tokenHash: 'hash_mcp_session',
    tokenPrefix: 'ps_mcp_tok',
    type: 'mcp' as const,
    scopes: ['pages:read', 'pages:write'],
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    revokedAt: null,
  },
};

// =============================================================================
// IP Address Fixtures
// =============================================================================

export const testIPs = {
  public: '203.0.113.1',
  publicV6: '2001:db8::1',
  localhost: '127.0.0.1',
  localhostV6: '::1',
  privateA: '10.0.0.1',
  privateB: '172.16.0.1',
  privateC: '192.168.1.1',
  linkLocal: '169.254.1.1',
  awsMetadata: '169.254.169.254',
  googleMetadata: '169.254.169.254',
};

// =============================================================================
// JTI Fixtures
// =============================================================================

export const testJTIs = {
  valid: {
    jti: 'jti_valid_001',
    userId: testUsers.regularUser.id,
    status: 'valid',
    createdAt: Date.now(),
    expiresIn: 300, // 5 minutes
  },
  revoked: {
    jti: 'jti_revoked_001',
    userId: testUsers.regularUser.id,
    status: 'revoked',
    createdAt: Date.now() - 60000,
    revokedAt: Date.now(),
    reason: 'user_logout',
    expiresIn: 300,
  },
  expired: {
    jti: 'jti_expired_001',
    userId: testUsers.regularUser.id,
    status: 'valid',
    createdAt: Date.now() - 600000, // 10 minutes ago
    expiresIn: 300, // Expired 5 minutes ago
  },
};

// =============================================================================
// File Fixtures (for path traversal tests)
// =============================================================================

export const testFiles = {
  validFile: {
    id: 'file_valid_001',
    pageId: testPages.tenantAPage.id,
    name: 'document.pdf',
    path: 'uploads/user_regular_001/document.pdf',
    contentType: 'application/pdf',
    size: 1024,
  },
  sensitiveFile: {
    id: 'file_sensitive_001',
    pageId: testPages.tenantAPage.id,
    name: 'secrets.env',
    path: 'uploads/user_regular_001/secrets.env',
    contentType: 'text/plain',
    size: 256,
  },
};

// =============================================================================
// Scope Fixtures
// =============================================================================

export const testScopes = {
  allAccess: ['*'],
  readOnly: ['files:read', 'pages:read'],
  readWrite: ['files:read', 'files:write', 'pages:read', 'pages:write'],
  filesOnly: ['files:read', 'files:write', 'files:delete'],
  broadcast: ['broadcast'],
  empty: [],
};
