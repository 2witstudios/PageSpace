import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Security Test Suite for MCP Documents API
 *
 * Tests cover OWASP vulnerabilities:
 * - A01: Broken Access Control (IDOR)
 * - A04: Insecure Design (Zero Trust violations)
 *
 * This test suite validates that:
 * 1. View permissions are explicitly checked for read operations
 * 2. Edit permissions are explicitly checked for write operations
 * 3. Permission boundaries are enforced (Zero Trust)
 */

// Mock dependencies
const mockAuthenticateMCPRequest = vi.fn();
const mockGetUserAccessLevel = vi.fn();
const mockApplyPageMutation = vi.fn();
const mockBroadcastPageEvent = vi.fn();
const mockCreatePageEventPayload = vi.fn();
const mockGetActorInfo = vi.fn();

vi.mock('@/lib/auth', () => ({
  authenticateMCPRequest: (...args: unknown[]) => mockAuthenticateMCPRequest(...args),
  isAuthError: (result: unknown) => 'error' in (result as object),
  isMCPAuthResult: (result: unknown) => !('error' in (result as object)) && (result as { tokenType?: string }).tokenType === 'mcp',
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserAccessLevel: (...args: unknown[]) => mockGetUserAccessLevel(...args),
  PageType: {},
  isSheetType: vi.fn(() => false),
  parseSheetContent: vi.fn(),
  serializeSheetContent: vi.fn(),
  updateSheetCells: vi.fn(),
  isValidCellAddress: vi.fn(() => true),
  loggers: {
    api: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'page_123',
          title: 'Test Page',
          content: 'line 1\nline 2\nline 3',
          type: 'DOCUMENT',
          revision: 1,
          parentId: null,
          drive: { id: 'drive_123', ownerId: 'owner_123' },
        }),
      },
    },
  },
  pages: { id: 'pages.id' },
  eq: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: (...args: unknown[]) => mockBroadcastPageEvent(...args),
  createPageEventPayload: (...args: unknown[]) => mockCreatePageEventPayload(...args),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
  PageRevisionMismatchError: class extends Error {
    currentRevision: number;
    expectedRevision: number;
    constructor(message: string, current: number, expected: number) {
      super(message);
      this.currentRevision = current;
      this.expectedRevision = expected;
    }
  },
}));

vi.mock('prettier', () => ({
  default: {
    format: vi.fn((content: string) => Promise.resolve(content)),
  },
}));

describe('MCP Documents API - Security Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default successful auth
    mockAuthenticateMCPRequest.mockResolvedValue({
      userId: 'user_123',
      tokenType: 'mcp',
      tokenId: 'token_123',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 0,
      allowedDriveIds: [], // Empty array means no drive restrictions
    });

    // Default actor info
    mockGetActorInfo.mockResolvedValue({
      actorEmail: 'user@example.com',
      actorDisplayName: 'Test User',
    });
  });

  describe('A01 - Broken Access Control (IDOR)', () => {
    it('should deny read access when user has no permissions', async () => {
      // User has no access to the page at all
      mockGetUserAccessLevel.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(403);
      expect(mockGetUserAccessLevel).toHaveBeenCalledWith('user_123', 'page_123');
    });

    it('should deny read access when user has canView=false', async () => {
      // User has permissions record but canView is false
      // This is the IDOR vulnerability we're fixing
      mockGetUserAccessLevel.mockResolvedValue({
        canView: false,
        canEdit: true, // Even with edit permission, view should be required
        canShare: false,
        canDelete: false,
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(403);
    });

    it('should allow read access when user has canView=true', async () => {
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.pageId).toBe('page_123');
    });

    it('should deny write access when user has canView=true but canEdit=false', async () => {
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'replace',
          pageId: 'page_123',
          startLine: 1,
          content: 'new content',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe('Write permission required');
    });

    it('should allow write access when user has canView=true and canEdit=true', async () => {
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      mockApplyPageMutation.mockResolvedValue(undefined);
      mockCreatePageEventPayload.mockReturnValue({});

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'replace',
          pageId: 'page_123',
          startLine: 1,
          content: 'new content',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).toHaveBeenCalled();
    });
  });

  describe('A04 - Insecure Design (Zero Trust)', () => {
    it('should explicitly check canView before returning document content', async () => {
      // This test verifies that we follow Zero Trust principles
      // by explicitly checking the view permission, not just checking
      // that some permission exists
      mockGetUserAccessLevel.mockResolvedValue({
        canView: true,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      await POST(request);

      // Verify the permission check was called with correct parameters
      expect(mockGetUserAccessLevel).toHaveBeenCalledWith('user_123', 'page_123');
    });

    it('should log security events when access is denied', async () => {
      const { loggers } = await import('@pagespace/lib/server');

      mockGetUserAccessLevel.mockResolvedValue({
        canView: false,
        canEdit: false,
        canShare: false,
        canDelete: false,
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'MCP document access denied - no view permission',
        expect.objectContaining({
          userId: 'user_123',
          pageId: 'page_123',
          canView: false,
        })
      );
    });

    it('should deny access when permission check returns null access level', async () => {
      mockGetUserAccessLevel.mockResolvedValue(null);

      const { loggers } = await import('@pagespace/lib/server');

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(403);
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'MCP document access denied - no view permission',
        expect.objectContaining({
          userId: 'user_123',
          pageId: 'page_123',
          hasAccessLevel: false,
        })
      );
    });

    it('should validate permissions for each write operation type', async () => {
      const writeOperations = ['replace', 'insert', 'delete'];

      for (const operation of writeOperations) {
        vi.clearAllMocks();

        mockAuthenticateMCPRequest.mockResolvedValue({
          userId: 'user_123',
          tokenType: 'mcp',
          tokenId: 'token_123',
          role: 'user',
          tokenVersion: 1,
          adminRoleVersion: 0,
          allowedDriveIds: [], // Empty array means no drive restrictions
        });

        mockGetUserAccessLevel.mockResolvedValue({
          canView: true,
          canEdit: false, // No edit permission
          canShare: false,
          canDelete: false,
        });

        const { POST } = await import('../route');
        const body: Record<string, unknown> = {
          operation,
          pageId: 'page_123',
          startLine: 1,
        };

        if (operation !== 'delete') {
          body.content = 'test content';
        }

        const request = new NextRequest('http://localhost/api/mcp/documents', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        const response = await POST(request);

        expect(response.status).toBe(403);
        const data = await response.json();
        expect(data.error).toBe('Write permission required');
        expect(data.details).toContain(operation);
      }
    });
  });

  describe('Authentication Boundary', () => {
    it('should reject requests without valid MCP token', async () => {
      mockAuthenticateMCPRequest.mockResolvedValue({
        error: NextResponse.json({ error: 'MCP token required' }, { status: 401 }),
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/mcp/documents', {
        method: 'POST',
        body: JSON.stringify({
          operation: 'read',
          pageId: 'page_123',
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      // Permission check should not be called for unauthenticated requests
      expect(mockGetUserAccessLevel).not.toHaveBeenCalled();
    });
  });
});
