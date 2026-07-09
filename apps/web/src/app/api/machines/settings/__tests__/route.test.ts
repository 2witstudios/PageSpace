/**
 * Contract tests for GET/PATCH/DELETE /api/machines/settings
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCanAccessMachine,
  mockCanViewMachine,
  mockCreateDbMachineSettingsStore,
  mockCreateMachineSpriteTeardown,
  mockCreateMachineDependentsPurge,
  mockGetMachineSettings,
  mockUpdateMachineSettings,
  mockDeleteMachine,
  mockAuditRequest,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockCanAccessMachine: vi.fn(),
  mockCanViewMachine: vi.fn(),
  mockCreateDbMachineSettingsStore: vi.fn(),
  mockCreateMachineSpriteTeardown: vi.fn(),
  mockCreateMachineDependentsPurge: vi.fn(),
  mockGetMachineSettings: vi.fn(),
  mockUpdateMachineSettings: vi.fn(),
  mockDeleteMachine: vi.fn(),
  mockAuditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));

vi.mock('@/lib/machines/machine-settings-runtime', () => ({
  canAccessMachine: (...args: unknown[]) => mockCanAccessMachine(...args),
  canViewMachine: (...args: unknown[]) => mockCanViewMachine(...args),
  createDbMachineSettingsStore: (...args: unknown[]) => mockCreateDbMachineSettingsStore(...args),
  createMachineSpriteTeardown: (...args: unknown[]) => mockCreateMachineSpriteTeardown(...args),
  createMachineDependentsPurge: (...args: unknown[]) => mockCreateMachineDependentsPurge(...args),
}));

vi.mock('@pagespace/lib/services/machines/machine-settings', () => ({
  getMachineSettings: (...args: unknown[]) => mockGetMachineSettings(...args),
  updateMachineSettings: (...args: unknown[]) => mockUpdateMachineSettings(...args),
  deleteMachine: (...args: unknown[]) => mockDeleteMachine(...args),
}));

import { GET, PATCH, DELETE } from '../route';

const AUTH_OK = { userId: 'user-1' };
const AUTH_DENIED = { error: new Response(null, { status: 401 }) };

const SETTINGS = {
  name: 'My Machine',
  description: 'build box',
  visibleToGlobalAssistant: true,
  allowPageAgents: false,
};

const FAKE_STORE = {} as never;
const FAKE_SPRITE = {} as never;
const FAKE_DEPENDENTS = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateRequest.mockResolvedValue(AUTH_OK);
  mockCreateDbMachineSettingsStore.mockReturnValue(FAKE_STORE);
  mockCreateMachineSpriteTeardown.mockReturnValue(FAKE_SPRITE);
  mockCreateMachineDependentsPurge.mockReturnValue(FAKE_DEPENDENTS);
});

describe('GET /api/machines/settings', () => {
  it('given no auth, returns the auth error', async () => {
    mockAuthenticateRequest.mockResolvedValue(AUTH_DENIED);
    const res = await GET(new Request('https://x.test/api/machines/settings?terminalId=t1'));
    expect(res.status).toBe(401);
  });

  it('given no terminalId, returns 400', async () => {
    const res = await GET(new Request('https://x.test/api/machines/settings'));
    expect(res.status).toBe(400);
    expect(mockCanViewMachine).not.toHaveBeenCalled();
  });

  it('given no view access, returns 403 without reading settings and audits the denial', async () => {
    mockCanViewMachine.mockResolvedValue(false);
    const res = await GET(new Request('https://x.test/api/machines/settings?terminalId=t1'));
    expect(res.status).toBe(403);
    expect(mockGetMachineSettings).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', userId: 'user-1', resourceId: 't1' }),
    );
  });

  it('given view access, returns the settings', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockGetMachineSettings.mockResolvedValue(SETTINGS);
    const res = await GET(new Request('https://x.test/api/machines/settings?terminalId=t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual(SETTINGS);
    expect(mockCanViewMachine).toHaveBeenCalledWith('user-1', 't1');
  });

  it('given the machine no longer exists, returns 404', async () => {
    mockCanViewMachine.mockResolvedValue(true);
    mockGetMachineSettings.mockResolvedValue(null);
    const res = await GET(new Request('https://x.test/api/machines/settings?terminalId=t1'));
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/machines/settings', () => {
  function req(body: unknown) {
    return new Request('https://x.test/api/machines/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('given no terminalId, returns 400 without checking access', async () => {
    const res = await PATCH(req({ name: 'x' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given an empty patch, returns 400', async () => {
    const res = await PATCH(req({ terminalId: 't1' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given a blank name, returns 400', async () => {
    const res = await PATCH(req({ terminalId: 't1', name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('given a non-boolean toggle, returns 400', async () => {
    const res = await PATCH(req({ terminalId: 't1', allowPageAgents: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('given no edit access, returns 403 without updating and audits the denial', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await PATCH(req({ terminalId: 't1', name: 'Renamed' }));
    expect(res.status).toBe(403);
    expect(mockUpdateMachineSettings).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', userId: 'user-1', resourceId: 't1' }),
    );
  });

  it('given edit access, updates and returns the settings and audits the write', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockUpdateMachineSettings.mockResolvedValue({ ...SETTINGS, name: 'Renamed', description: null });
    const res = await PATCH(req({ terminalId: 't1', name: 'Renamed', description: null, allowPageAgents: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.name).toBe('Renamed');
    expect(mockUpdateMachineSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: 't1',
        patch: { name: 'Renamed', description: null, allowPageAgents: true },
      }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.write', userId: 'user-1', resourceId: 't1' }),
    );
  });

  it('given the machine no longer exists, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockUpdateMachineSettings.mockResolvedValue(null);
    const res = await PATCH(req({ terminalId: 't1', name: 'Renamed' }));
    expect(res.status).toBe(404);
  });

  it('given invalid JSON, returns 400', async () => {
    const res = await PATCH(
      new Request('https://x.test/api/machines/settings', {
        method: 'PATCH',
        body: '{not json',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/machines/settings', () => {
  it('given no terminalId, returns 400', async () => {
    const res = await DELETE(new Request('https://x.test/api/machines/settings', { method: 'DELETE' }));
    expect(res.status).toBe(400);
    expect(mockCanAccessMachine).not.toHaveBeenCalled();
  });

  it('given the machine does not exist, returns 404', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockDeleteMachine.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await DELETE(new Request('https://x.test/api/machines/settings?terminalId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('given a successful delete, returns 200 with the teardown outcome and audits the delete', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockDeleteMachine.mockResolvedValue({ ok: true, spriteTornDown: true });
    const res = await DELETE(new Request('https://x.test/api/machines/settings?terminalId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, spriteTornDown: true });
    expect(mockDeleteMachine).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 't1', store: FAKE_STORE, sprite: FAKE_SPRITE, dependents: FAKE_DEPENDENTS }),
    );
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'data.delete',
        userId: 'user-1',
        resourceId: 't1',
        details: { spriteTornDown: true },
      }),
    );
  });

  it('given no edit access, returns 403 and audits the denial without deleting', async () => {
    mockCanAccessMachine.mockResolvedValue(false);
    const res = await DELETE(new Request('https://x.test/api/machines/settings?terminalId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(mockDeleteMachine).not.toHaveBeenCalled();
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'authz.access.denied', userId: 'user-1', resourceId: 't1' }),
    );
  });

  it('given a delete where Sprite teardown failed, still returns 200 (page trashed)', async () => {
    mockCanAccessMachine.mockResolvedValue(true);
    mockDeleteMachine.mockResolvedValue({ ok: true, spriteTornDown: false });
    const res = await DELETE(new Request('https://x.test/api/machines/settings?terminalId=t1', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, spriteTornDown: false });
  });
});
