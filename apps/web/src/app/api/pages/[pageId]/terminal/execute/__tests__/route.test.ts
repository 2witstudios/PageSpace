/**
 * Contract tests for POST /api/pages/[pageId]/terminal/execute
 *
 * Verifies:
 * - Kill-switch gate (503 when disabled)
 * - Auth errors (401 when unauthenticated)
 * - Permission gate (403 when viewer)
 * - Body validation (400 on missing/invalid command)
 * - 404 when page not found
 * - Quota denial (429)
 * - Concurrency slot unavailable (429)
 * - Sandbox acquire failure (500)
 * - Happy path → 200 with { output, exitCode, durationMs }
 * - releaseCodeExecutionSlot always called in finally
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ─── Mock all external boundaries before importing the route ───────────────

vi.mock('@pagespace/lib/services/sandbox/can-run-code', () => ({
  isCodeExecutionEnabled: vi.fn().mockReturnValue(true),
  canRunCode: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
  canPrincipalEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId' },
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' },
}));

vi.mock('@pagespace/lib/services/sandbox/quota', () => ({
  checkCodeExecutionQuota: vi.fn().mockResolvedValue({ allowed: true }),
  acquireCodeExecutionSlot: vi.fn().mockReturnValue(true),
  releaseCodeExecutionSlot: vi.fn(),
  chargeCodeExecutionBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/services/sandbox/terminal-session-manager', () => ({
  acquireTerminalSandbox: vi.fn(),
  createDbTerminalSessionStore: vi.fn().mockResolvedValue({}),
}));

vi.mock('@pagespace/lib/services/sandbox/session-manager', () => ({
  getSandboxSessionSecret: vi.fn().mockReturnValue('test-secret'),
}));

vi.mock('@/lib/sandbox/sprites-client', () => ({
  createProductionSpritesSandboxClient: vi.fn(),
}));

vi.mock('@pagespace/lib/services/sandbox/output-limit', () => ({
  truncateToBytes: vi.fn(({ text }: { text: string }) => ({ text, truncated: false, originalBytes: text.length })),
}));

vi.mock('@pagespace/lib/services/sandbox/audit', () => ({
  writeCodeExecutionAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

// ─── Import SUT and mocked modules ────────────────────────────────────────

import { POST } from '../route';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { authenticateRequestWithOptions, canPrincipalEditPage } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { checkCodeExecutionQuota, acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { acquireTerminalSandbox, createDbTerminalSessionStore } from '@pagespace/lib/services/sandbox/terminal-session-manager';
import { createProductionSpritesSandboxClient } from '@/lib/sandbox/sprites-client';
import { loggers } from '@pagespace/lib/logging/logger-config';

// ─── Type helpers ──────────────────────────────────────────────────────────

function asMock<T>(fn: T): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

// ─── Test fixtures ────────────────────────────────────────────────────────

const mockPageId = 'page_123';
const mockDriveId = 'drive_123';
const mockTenantId = 'tenant_123';
const mockUserId = 'user_123';

const mockSessionAuth = {
  userId: mockUserId,
  tokenType: 'session' as const,
  sessionId: 'sess_1',
  role: 'admin' as const,
  tokenVersion: 1,
  adminRoleVersion: 1,
};

function makeRequest(body: unknown = { command: 'echo hello' }): Request {
  return new Request(`http://localhost/api/pages/${mockPageId}/terminal/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(pageId = mockPageId): { params: Promise<{ pageId: string }> } {
  return { params: Promise.resolve({ pageId }) };
}

/** Sets up db.select to return real rows for page, then drive+user in parallel. */
function setupDbMocks({
  page = { driveId: mockDriveId } as Record<string, unknown> | null,
  drive = { ownerId: mockTenantId } as Record<string, unknown>,
  user = { subscriptionTier: 'free', email: 'actor@example.com', name: 'Test Actor' } as Record<string, unknown>,
} = {}) {
  asMock(db.select).mockImplementation((fields?: Record<string, unknown>) => {
    const fieldKeys = fields ? Object.keys(fields) : [];
    const isDriveQuery = fieldKeys.includes('ownerId');
    const isUserQuery = fieldKeys.includes('subscriptionTier');

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            isDriveQuery ? (drive ? [drive] : [])
            : isUserQuery ? (user ? [user] : [])
            : (page ? [page] : [])
          ),
        }),
      }),
    };
  });
}

function makeSprite() {
  return {
    sandboxId: 'sprite-123',
    runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'hello\n', stderr: '' }),
    writeFiles: vi.fn(),
    readFileToBuffer: vi.fn(),
  };
}

function setupHappyPath() {
  setupDbMocks();
  const sprite = makeSprite();
  const mockClient = {
    getOrCreate: vi.fn(),
    get: vi.fn().mockResolvedValue(sprite),
    stop: vi.fn(),
  };
  asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
  asMock(acquireTerminalSandbox).mockResolvedValue({ ok: true, sandboxId: 'sprite-123', resumed: false });
  return { sprite, mockClient };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /api/pages/[pageId]/terminal/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(isCodeExecutionEnabled).mockReturnValue(true);
    asMock(canRunCode).mockResolvedValue({ ok: true });
    asMock(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth);
    asMock(canPrincipalEditPage).mockResolvedValue(true);
    asMock(checkCodeExecutionQuota).mockResolvedValue({ allowed: true });
    asMock(acquireCodeExecutionSlot).mockReturnValue(true);
    asMock(releaseCodeExecutionSlot).mockReturnValue(undefined);
    asMock(createDbTerminalSessionStore).mockResolvedValue({});
  });

  describe('kill-switch', () => {
    it('returns 503 when code execution is disabled', async () => {
      asMock(isCodeExecutionEnabled).mockReturnValue(false);
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain('not enabled');
    });
  });

  describe('authentication', () => {
    it('returns 401 when unauthenticated', async () => {
      const errorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      asMock(authenticateRequestWithOptions).mockResolvedValue({ error: errorResponse });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('returns 403 when a non-admin tries to execute a terminal command', async () => {
      asMock(authenticateRequestWithOptions).mockResolvedValue({
        ...mockSessionAuth,
        role: 'user',
      });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(403);
      expect(vi.mocked(canPrincipalEditPage)).not.toHaveBeenCalled();
    });

    it('returns 403 when user cannot edit page', async () => {
      asMock(canPrincipalEditPage).mockResolvedValue(false);
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(403);
    });

    it('returns 403 when shared code-execution authorization denies the user', async () => {
      setupDbMocks();
      asMock(canRunCode).mockResolvedValue({ ok: false, reason: 'app_admin_required' });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(403);
      expect(vi.mocked(acquireCodeExecutionSlot)).not.toHaveBeenCalled();
    });
  });

  describe('request body validation', () => {
    it('returns 400 when command is missing', async () => {
      const res = await POST(makeRequest({}), makeParams());
      expect(res.status).toBe(400);
    });

    it('returns 400 when command is empty string', async () => {
      const res = await POST(makeRequest({ command: '' }), makeParams());
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is not JSON', async () => {
      const req = new Request(`http://localhost/api/pages/${mockPageId}/terminal/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      });
      const res = await POST(req, makeParams());
      expect(res.status).toBe(400);
    });
  });

  describe('page lookup', () => {
    it('returns 404 when page not found', async () => {
      asMock(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(404);
    });
  });

  describe('quota', () => {
    it('returns 429 when quota is exhausted', async () => {
      setupDbMocks();
      asMock(checkCodeExecutionQuota).mockResolvedValue({ allowed: false, reason: 'rate_limited' });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(429);
    });

    it('returns 429 when concurrency slot unavailable', async () => {
      setupDbMocks();
      asMock(acquireCodeExecutionSlot).mockReturnValue(false);
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(429);
    });
  });

  describe('sandbox acquire', () => {
    it('returns 500 when sandbox acquisition fails', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn(), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: false, reason: 'provision_failed' });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(500);
      expect(vi.mocked(loggers.api.error)).toHaveBeenCalledWith(
        'Terminal sandbox acquisition failed',
        expect.objectContaining({ reason: 'provision_failed', pageId: mockPageId, driveId: mockDriveId }),
      );
    });

    it('returns 500 when sandbox acquisition fails even if logging throws', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn(), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: false, reason: 'provision_failed' });
      vi.mocked(loggers.api.error).mockImplementationOnce(() => {
        throw new Error('logger failed');
      });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Could not acquire sandbox' });
    });

    it('returns 403 when sandbox acquisition is denied and logs at warn level', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn(), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: false, reason: 'deny' });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(403);
      expect(vi.mocked(loggers.api.warn)).toHaveBeenCalledWith(
        'Terminal sandbox acquisition denied',
        expect.objectContaining({ reason: 'deny', pageId: mockPageId, driveId: mockDriveId }),
      );
      expect(vi.mocked(loggers.api.error)).not.toHaveBeenCalled();
    });

    it('returns 403 when sandbox acquisition is denied even if warn logging throws', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn(), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: false, reason: 'deny' });
      vi.mocked(loggers.api.warn).mockImplementationOnce(() => {
        throw new Error('logger failed');
      });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Could not acquire sandbox' });
    });

    it('returns 500 when sprite is gone after acquire succeeds', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn().mockResolvedValue(null), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: true, sandboxId: 'sprite-123', resumed: false });
      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(500);
      expect(vi.mocked(loggers.api.error)).toHaveBeenCalledWith(
        'Terminal sandbox reconnect returned no handle',
        expect.objectContaining({ sandboxId: 'sprite-123', pageId: mockPageId, driveId: mockDriveId }),
      );
    });

    it('returns 500 when sprite is gone after acquire succeeds even if logging throws', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn().mockResolvedValue(null), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: true, sandboxId: 'sprite-123', resumed: false });
      vi.mocked(loggers.api.error).mockImplementationOnce(() => {
        throw new Error('logger failed');
      });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Sandbox not available' });
    });
  });

  describe('happy path', () => {
    it('returns 200 with output, exitCode, durationMs on success', async () => {
      const { sprite } = setupHappyPath();
      asMock(sprite.runCommand).mockResolvedValue({ exitCode: 0, stdout: 'hello\n', stderr: '' });

      const res = await POST(makeRequest({ command: 'echo hello' }), makeParams());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toBe('hello\n');
      expect(body.exitCode).toBe(0);
      expect(typeof body.durationMs).toBe('number');
    });

    it('appends stderr to output when non-empty', async () => {
      const { sprite } = setupHappyPath();
      asMock(sprite.runCommand).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'error message' });

      const res = await POST(makeRequest({ command: 'false' }), makeParams());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toContain('error message');
      expect(body.exitCode).toBe(1);
    });

    it('passes cwd to runCommand when provided', async () => {
      const { sprite } = setupHappyPath();

      await POST(makeRequest({ command: 'pwd', cwd: '/tmp' }), makeParams());
      expect(sprite.runCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp' }),
      );
    });
  });

  describe('slot lifecycle', () => {
    it('calls releaseCodeExecutionSlot in finally even when sandbox acquire fails', async () => {
      setupDbMocks();
      const mockClient = { getOrCreate: vi.fn(), get: vi.fn(), stop: vi.fn() };
      asMock(createProductionSpritesSandboxClient).mockResolvedValue(mockClient);
      asMock(acquireTerminalSandbox).mockResolvedValue({ ok: false, reason: 'provision_failed' });

      await POST(makeRequest(), makeParams());
      expect(vi.mocked(releaseCodeExecutionSlot)).toHaveBeenCalledWith({ userId: mockUserId });
    });

    it('calls releaseCodeExecutionSlot in finally even when runCommand throws', async () => {
      const { sprite } = setupHappyPath();
      asMock(sprite.runCommand).mockRejectedValue(new Error('command error'));

      const res = await POST(makeRequest(), makeParams());
      expect(res.status).toBe(500);
      expect(vi.mocked(loggers.api.error)).toHaveBeenCalledWith(
        'Terminal command execution failed',
        expect.objectContaining({ reason: 'command_execution_failed', pageId: mockPageId, driveId: mockDriveId }),
      );
      expect(vi.mocked(releaseCodeExecutionSlot)).toHaveBeenCalledWith({ userId: mockUserId });
    });

    it('returns 500 and releases the slot when runCommand and logging both throw', async () => {
      const { sprite } = setupHappyPath();
      asMock(sprite.runCommand).mockRejectedValue(new Error('command error'));
      vi.mocked(loggers.api.error).mockImplementationOnce(() => {
        throw new Error('logger failed');
      });

      const res = await POST(makeRequest(), makeParams());

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Execution failed' });
      expect(vi.mocked(releaseCodeExecutionSlot)).toHaveBeenCalledWith({ userId: mockUserId });
    });

    it('does NOT call releaseCodeExecutionSlot when slot was never acquired (quota denied)', async () => {
      setupDbMocks();
      asMock(checkCodeExecutionQuota).mockResolvedValue({ allowed: false, reason: 'rate_limited' });

      await POST(makeRequest(), makeParams());
      expect(vi.mocked(releaseCodeExecutionSlot)).not.toHaveBeenCalled();
    });

    it('does NOT call releaseCodeExecutionSlot when acquireCodeExecutionSlot returns false', async () => {
      setupDbMocks();
      asMock(acquireCodeExecutionSlot).mockReturnValue(false);

      await POST(makeRequest(), makeParams());
      expect(vi.mocked(releaseCodeExecutionSlot)).not.toHaveBeenCalled();
    });
  });
});
