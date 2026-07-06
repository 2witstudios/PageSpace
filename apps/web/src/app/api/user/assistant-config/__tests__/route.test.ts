/**
 * Security audit tests for /api/user/assistant-config
 * Verifies auditRequest is called for GET and PUT.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetOrCreateConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfig = vi.hoisted(() => vi.fn());
const mockGetAvailableTerminals = vi.hoisted(() => vi.fn());
const mockValidateMachines = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({
  getOrCreateConfig: mockGetOrCreateConfig,
  updateConfig: mockUpdateConfig,
}));

vi.mock('@/lib/repositories/global-terminal-config-repository', () => ({
  MAX_MACHINES: 20,
  globalTerminalConfigRepository: {
    getAvailableTerminals: mockGetAvailableTerminals,
    validateMachines: mockValidateMachines,
  },
}));

import { GET, PUT } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

const mockConfig = {
  enabledUserIntegrations: null,
  driveOverrides: {},
  inheritDriveIntegrations: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('GET /api/user/assistant-config audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetOrCreateConfig.mockResolvedValue(mockConfig);
    mockGetAvailableTerminals.mockResolvedValue([]);
  });

  it('logs read audit event on successful config retrieval', async () => {
    const request = new Request('http://localhost/api/user/assistant-config');
    await GET(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'assistant_config', resourceId: 'self' }
    );
  });
});

describe('GET /api/user/assistant-config terminal access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetAvailableTerminals.mockResolvedValue([{ id: 't1', title: 'Shared Terminal' }]);
  });

  it('given terminalAccess is unset (legacy row), should default to false with an empty machines array', async () => {
    mockGetOrCreateConfig.mockResolvedValue(mockConfig);
    const request = new Request('http://localhost/api/user/assistant-config');
    const response = await GET(request);
    const body = await response.json();
    expect(body.config.terminalAccess).toBe(false);
    expect(body.config.machines).toEqual([]);
  });

  it('given a configured terminalAccess/machines row, should return them plus availableTerminals', async () => {
    mockGetOrCreateConfig.mockResolvedValue({
      ...mockConfig,
      terminalAccess: true,
      machines: [{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }],
    });
    const request = new Request('http://localhost/api/user/assistant-config');
    const response = await GET(request);
    const body = await response.json();
    expect(body.config.terminalAccess).toBe(true);
    expect(body.config.machines).toEqual([{ kind: 'own' }, { kind: 'existing', terminalId: 't1' }]);
    expect(body.config.availableTerminals).toEqual([{ id: 't1', title: 'Shared Terminal' }]);
  });
});

describe('PUT /api/user/assistant-config audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockUpdateConfig.mockResolvedValue(mockConfig);
  });

  it('logs write audit event on successful config update', async () => {
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inheritDriveIntegrations: false }),
    });

    await PUT(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.write', userId: mockUserId, resourceType: 'assistant_config', resourceId: 'self' }
    );
  });
});

describe('PUT /api/user/assistant-config terminal access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('given valid machines, should validate against the Home drive and persist terminalAccess/machines', async () => {
    mockValidateMachines.mockResolvedValue({ ok: true });
    mockUpdateConfig.mockResolvedValue({
      ...mockConfig,
      terminalAccess: true,
      machines: [{ kind: 'own' }],
    });
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalAccess: true, machines: [{ kind: 'own' }] }),
    });

    const response = await PUT(request);
    const body = await response.json();

    expect(mockValidateMachines).toHaveBeenCalledWith(mockUserId, [{ kind: 'own' }]);
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.anything(),
      mockUserId,
      expect.objectContaining({ terminalAccess: true, machines: [{ kind: 'own' }] }),
    );
    expect(body.config.terminalAccess).toBe(true);
    expect(body.config.machines).toEqual([{ kind: 'own' }]);
  });

  it('given an existing terminalId outside the user\'s Home drive, should reject with 400 and not persist', async () => {
    mockValidateMachines.mockResolvedValue({ ok: false, invalidIds: ['not-mine'] });
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machines: [{ kind: 'existing', terminalId: 'not-mine' }] }),
    });

    const response = await PUT(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('not-mine');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('given a machines array over MAX_MACHINES, should reject with a validation error', async () => {
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machines: Array.from({ length: 21 }, () => ({ kind: 'own' })) }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);
    expect(mockValidateMachines).not.toHaveBeenCalled();
  });

  it('given a malformed machine entry, should reject with a validation error', async () => {
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machines: [{ kind: 'existing' }] }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);
  });
});
