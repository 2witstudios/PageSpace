/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, MCPAuthResult } from '@/lib/auth';

// ============================================================================
// MCP Page Scope Enforcement Tests for GET /api/ai/chat/messages
//
// Verifies that scoped MCP tokens cannot load chat messages for pages
// outside their allowed drives. Session auth should pass through unchanged.
// ============================================================================

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesForPage: vi.fn().mockResolvedValue([]),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: any) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    ai: { info: vi.fn(), error: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

// Mock message converter (boundary)
vi.mock('@/lib/ai/core', () => ({
  convertDbMessageToUIMessage: vi.fn((msg: any) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
  })),
}));

import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockUserId = 'user_123';
const pageIdInScope = 'page_123';
const pageIdOutOfScope = 'page_456';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockMCPAuth = (userId: string, allowedDriveIds: string[]): MCPAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'mcp',
  tokenId: 'mcp-token-id',
  role: 'user',
  adminRoleVersion: 0,
  allowedDriveIds,
});

const createRequest = (pageId?: string, conversationId?: string) => {
  let url = 'https://example.com/api/ai/chat/messages';
  const params: string[] = [];
  if (pageId) params.push(`pageId=${pageId}`);
  if (conversationId) params.push(`conversationId=${conversationId}`);
  if (params.length) url += '?' + params.join('&');

  return new Request(url, { method: 'GET' });
};

// ============================================================================
// MCP Scope Enforcement Tests
// ============================================================================

describe('GET /api/ai/chat/messages - MCP page scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 403 when scoped MCP token accesses a page outside its scope', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    // checkMCPPageScope returns 403 for page outside scope
    vi.mocked(checkMCPPageScope).mockResolvedValue(
      NextResponse.json(
        { error: 'This token does not have access to this drive' },
        { status: 403 }
      )
    );

    const request = createRequest(pageIdOutOfScope);
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('token does not have access');
    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, pageIdOutOfScope);
  });

  it('should proceed when scoped MCP token accesses a page within its scope', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);

    const request = createRequest(pageIdInScope);
    const response = await GET(request);

    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, pageIdInScope);
    expect(response.status).toBe(200);
  });

  it('should pass through for session auth without scope check blocking', async () => {
    const auth = mockWebAuth(mockUserId);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(chatMessageRepository.getMessagesForPage).mockResolvedValue([]);

    const request = createRequest(pageIdInScope);
    const response = await GET(request);

    expect(checkMCPPageScope).toHaveBeenCalledWith(auth, pageIdInScope);
    expect(response.status).toBe(200);
  });

  it('should return 404 when page is not found during scope check', async () => {
    const auth = mockMCPAuth(mockUserId, ['drive_A']);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

    // checkMCPPageScope returns 404 for nonexistent page
    vi.mocked(checkMCPPageScope).mockResolvedValue(
      NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      )
    );

    const request = createRequest('nonexistent_page');
    const response = await GET(request);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Page not found');
  });
});
