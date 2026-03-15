/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for GET /api/admin/global-prompt
//
// Tests the admin global prompt viewer that returns the complete AI context.
// ============================================================================

let mockAdminUser: { id: string; role: string; tokenVersion: number; adminRoleVersion: number; authTransport: string } | null = null;

vi.mock('@/lib/auth', () => ({
  withAdminAuth: vi.fn((handler: any) => {
    return async (request: Request) => {
      if (!mockAdminUser) {
        return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return handler(mockAdminUser, request);
    };
  }),
}));

vi.mock('@/lib/ai/core', () => ({
  buildCompleteRequest: vi.fn(() => ({
    request: {
      system: 'System prompt content',
      messages: [],
    },
    formattedString: '{}',
    tokenEstimates: {
      systemPrompt: 100,
      tools: 50,
      total: 150,
    },
  })),
  buildSystemPrompt: vi.fn(() => 'System prompt content'),
  buildAgentAwarenessPrompt: vi.fn(() => 'Agent awareness prompt'),
  getPageTreeContext: vi.fn(() => null),
  getDriveListSummary: vi.fn(() => null),
  buildInlineInstructions: vi.fn(() => 'Inline instructions'),
  buildGlobalAssistantInstructions: vi.fn(() => 'Global assistant instructions'),
  getToolsSummary: vi.fn(() => ({
    allowed: ['search', 'read'],
    denied: ['delete'],
  })),
  pageSpaceTools: {
    search: { description: 'Search tool', inputSchema: {} },
    read: { description: 'Read tool', inputSchema: {} },
  },
  extractToolSchemas: vi.fn(() => [
    { name: 'search', description: 'Search', schema: {} },
    { name: 'read', description: 'Read', schema: {} },
  ]),
  calculateTotalToolTokens: vi.fn(() => 200),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
  },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role' },
  drives: { id: 'id', ownerId: 'ownerId', name: 'name', slug: 'slug', isTrashed: 'isTrashed' },
  pages: { id: 'id', title: 'title', type: 'type', parentId: 'parentId', driveId: 'driveId', isTrashed: 'isTrashed' },
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@pagespace/lib/ai-context-calculator', () => ({
  estimateSystemPromptTokens: vi.fn(() => 100),
}));

import { GET } from '../route';
import { db } from '@pagespace/db';
import { buildCompleteRequest, buildAgentAwarenessPrompt } from '@/lib/ai/core';

// ============================================================================
// Test Helpers
// ============================================================================

const setAdminAuth = (id = 'admin_1') => {
  mockAdminUser = { id, role: 'admin', tokenVersion: 1, adminRoleVersion: 0, authTransport: 'cookie' };
};

const setNoAuth = () => {
  mockAdminUser = null;
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/admin/global-prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();

    // Default: empty drives and pages
    vi.mocked(db.query.drives.findMany).mockResolvedValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);
  });

  describe('authentication & authorization', () => {
    it('should return 403 when not an admin', async () => {
      setNoAuth();

      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it('should allow admin access', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success - dashboard context (no drive/page)', () => {
    it('should return prompt data with both modes', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.promptData).toHaveProperty('fullAccess');
      expect(body.promptData).toHaveProperty('readOnly');
    });

    it('should return tool schemas', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      expect(body.toolSchemas).toBeDefined();
      expect(body.totalToolTokens).toBe(200);
    });

    it('should include available drives list', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      expect(body.availableDrives).toBeDefined();
      expect(Array.isArray(body.availableDrives)).toBe(true);
    });

    it('should include metadata', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      expect(body.metadata).toHaveProperty('generatedAt');
      expect(body.metadata).toHaveProperty('adminUser');
      expect(body.metadata).toHaveProperty('contextType');
      expect(body.metadata.contextType).toBe('dashboard');
      expect(body.metadata.adminUser.id).toBe('admin_1');
    });

    it('should include experimental context', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      expect(body.experimentalContext).toBeDefined();
      expect(body.experimentalContext.userId).toBe('admin_1');
    });
  });

  describe('success - drive context', () => {
    it('should build drive context when driveId is provided', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'drive_1', name: 'My Drive', slug: 'my-drive', isTrashed: false } as any,
      ]);

      const request = new Request('https://example.com/api/admin/global-prompt?driveId=drive_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.metadata.contextType).toBe('drive');
    });
  });

  describe('success - page context', () => {
    it('should build page context when both driveId and pageId are provided', async () => {
      vi.mocked(db.query.drives.findMany).mockResolvedValue([
        { id: 'drive_1', name: 'My Drive', slug: 'my-drive', isTrashed: false } as any,
      ]);

      // Mock pages query for the selected drive
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              { id: 'page_1', title: 'Test Page', type: 'DOCUMENT', parentId: null },
            ]),
            limit: vi.fn().mockResolvedValue([
              { id: 'page_1', title: 'Test Page', parentId: null },
            ]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/admin/global-prompt?driveId=drive_1&pageId=page_1');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
    });
  });

  describe('page tree context', () => {
    it('should not include page tree when showPageTree is not set', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      await GET(request);

      // buildCompleteRequest should still be called but without tree context
      expect(buildCompleteRequest).toHaveBeenCalled();
    });
  });

  describe('mode prompt data structure', () => {
    it('should include correct permissions for fullAccess mode', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      const fullAccess = body.promptData.fullAccess;
      expect(fullAccess.permissions.canRead).toBe(true);
      expect(fullAccess.permissions.canWrite).toBe(true);
      expect(fullAccess.permissions.canDelete).toBe(true);
      expect(fullAccess.permissions.canOrganize).toBe(true);
    });

    it('should include correct permissions for readOnly mode', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      const readOnly = body.promptData.readOnly;
      expect(readOnly.permissions.canRead).toBe(true);
      expect(readOnly.permissions.canWrite).toBe(false);
      expect(readOnly.permissions.canDelete).toBe(false);
      expect(readOnly.permissions.canOrganize).toBe(false);
    });

    it('should call buildCompleteRequest for both modes', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      await GET(request);

      // Called twice: once for fullAccess (isReadOnly=false), once for readOnly (isReadOnly=true)
      expect(buildCompleteRequest).toHaveBeenCalledTimes(2);
      expect(buildCompleteRequest).toHaveBeenCalledWith(
        expect.objectContaining({ isReadOnly: false })
      );
      expect(buildCompleteRequest).toHaveBeenCalledWith(
        expect.objectContaining({ isReadOnly: true })
      );
    });

    it('should include agent awareness prompt in sections', async () => {
      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);
      const body = await response.json();

      const fullAccess = body.promptData.fullAccess;
      const agentSection = fullAccess.sections.find((s: any) => s.name === 'Agent Awareness');
      expect(agentSection).toBeDefined();
      expect(buildAgentAwarenessPrompt).toHaveBeenCalledWith('admin_1');
    });
  });

  describe('error handling', () => {
    it('should return 500 when an error occurs', async () => {
      vi.mocked(db.query.drives.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/admin/global-prompt');
      const response = await GET(request);

      expect(response.status).toBe(500);
    });
  });
});
