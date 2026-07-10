/**
 * #960 — GDPR Art 44/46 (international transfers).
 *
 * Generic OAuth integration routes (which serve GitHub and other external OAuth
 * providers) must be disabled in `onprem` mode. This asserts every handler
 * applies the `isOnPrem()` 404 gate as its first action, mirroring the
 * already-gated google-calendar routes.
 *
 * The gate is the very first statement in each handler, so mocking `isOnPrem`
 * (plus the modules imported at the top of each route) is enough to exercise it
 * without touching auth/db.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIsOnPrem = vi.hoisted(() => vi.fn(() => false));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/integrations', () => ({
  integrationConnections: { id: 'id' },
}));

vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  listUserConnections: vi.fn().mockResolvedValue([]),
  createConnection: vi.fn(),
  findUserConnection: vi.fn(),
  findDriveConnection: vi.fn(),
  listDriveConnections: vi.fn().mockResolvedValue([]),
  getConnectionById: vi.fn(),
  getConnectionWithProvider: vi.fn(),
  deleteConnection: vi.fn(),
  updateConnectionCredentials: vi.fn(),
  updateConnectionStatus: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/repositories/provider-repository', () => ({
  getProviderById: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/repositories/grant-repository', () => ({
  listGrantsByAgent: vi.fn().mockResolvedValue([]),
  createGrant: vi.fn(),
  findGrant: vi.fn(),
  getGrantById: vi.fn(),
  updateGrant: vi.fn(),
  deleteGrant: vi.fn(),
  listGrantsByConnection: vi.fn().mockResolvedValue([]),
}));

vi.mock('@pagespace/lib/integrations/credentials/encrypt-credentials', () => ({
  encryptCredentials: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/oauth/oauth-handler', () => ({
  buildOAuthAuthorizationUrl: vi.fn(() => 'https://example.com/oauth'),
  exchangeOAuthCode: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/oauth/oauth-state', () => ({
  createSignedState: vi.fn(() => 'state'),
  verifySignedState: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/integrations/providers/builtin-providers', () => ({
  getBuiltinProvider: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({ isMember: true, isOwner: true, isAdmin: true }),
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn().mockResolvedValue({ userId: 'user-1' }),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/auth/url-utils', () => ({
  isSafeReturnUrl: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAgentGrantChanged: vi.fn(),
}));

const GATE_ERROR = 'Not available';

const assertModeGateBlocks = async (response: Response) => {
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error).toBe(GATE_ERROR);
};

const assertModeGatePasses = async (response: Response) => {
  // Passing the gate means we did NOT 404 with the gate sentinel.
  if (response.status === 404) {
    const body = await response.json();
    expect(body.error).not.toBe(GATE_ERROR);
  }
};

import { GET as getUserConns, POST as postUserConns } from '../user/integrations/route';
import { GET as getUserCallback } from '../user/integrations/callback/route';
import {
  GET as getUserConn,
  PATCH as patchUserConn,
  DELETE as deleteUserConn,
} from '../user/integrations/[connectionId]/route';
import { GET as getDriveConns, POST as postDriveConns } from '../drives/[driveId]/integrations/route';
import {
  GET as getDriveConn,
  DELETE as deleteDriveConn,
} from '../drives/[driveId]/integrations/[connectionId]/route';
import { GET as getAgentGrants, POST as postAgentGrant } from '../agents/[agentId]/integrations/route';
import {
  PUT as putAgentGrant,
  DELETE as deleteAgentGrant,
} from '../agents/[agentId]/integrations/[grantId]/route';
import { GET as getConnGrants } from '../integrations/connections/[connectionId]/grants/route';

const makeRequest = (method: string, body?: object) =>
  new Request('http://localhost/api/test', {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });

const p = <T>(value: T) => Promise.resolve(value);

describe('#960 generic OAuth integration routes — deployment mode gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
    process.env.OAUTH_STATE_SECRET = 'secret-32-chars-minimum-length!!';
    process.env.WEB_APP_URL = 'http://localhost:3000';
  });

  type Handler = () => Promise<Response>;

  const cases: Array<{ name: string; run: Handler }> = [
    { name: 'GET /user/integrations', run: () => getUserConns(makeRequest('GET')) },
    { name: 'POST /user/integrations', run: () => postUserConns(makeRequest('POST', {})) },
    {
      name: 'GET /user/integrations/callback',
      run: () => getUserCallback(makeRequest('GET')),
    },
    {
      name: 'GET /user/integrations/[connectionId]',
      run: () => getUserConn(makeRequest('GET'), { params: p({ connectionId: 'c1' }) }),
    },
    {
      name: 'PATCH /user/integrations/[connectionId]',
      run: () => patchUserConn(makeRequest('PATCH', {}), { params: p({ connectionId: 'c1' }) }),
    },
    {
      name: 'DELETE /user/integrations/[connectionId]',
      run: () => deleteUserConn(makeRequest('DELETE'), { params: p({ connectionId: 'c1' }) }),
    },
    {
      name: 'GET /drives/[driveId]/integrations',
      run: () => getDriveConns(makeRequest('GET'), { params: p({ driveId: 'd1' }) }),
    },
    {
      name: 'POST /drives/[driveId]/integrations',
      run: () => postDriveConns(makeRequest('POST', {}), { params: p({ driveId: 'd1' }) }),
    },
    {
      name: 'GET /drives/[driveId]/integrations/[connectionId]',
      run: () =>
        getDriveConn(makeRequest('GET'), { params: p({ driveId: 'd1', connectionId: 'c1' }) }),
    },
    {
      name: 'DELETE /drives/[driveId]/integrations/[connectionId]',
      run: () =>
        deleteDriveConn(makeRequest('DELETE'), { params: p({ driveId: 'd1', connectionId: 'c1' }) }),
    },
    {
      name: 'GET /agents/[agentId]/integrations',
      run: () => getAgentGrants(makeRequest('GET'), { params: p({ agentId: 'a1' }) }),
    },
    {
      name: 'POST /agents/[agentId]/integrations',
      run: () => postAgentGrant(makeRequest('POST', {}), { params: p({ agentId: 'a1' }) }),
    },
    {
      name: 'PUT /agents/[agentId]/integrations/[grantId]',
      run: () =>
        putAgentGrant(makeRequest('PUT', {}), { params: p({ agentId: 'a1', grantId: 'g1' }) }),
    },
    {
      name: 'DELETE /agents/[agentId]/integrations/[grantId]',
      run: () =>
        deleteAgentGrant(makeRequest('DELETE'), { params: p({ agentId: 'a1', grantId: 'g1' }) }),
    },
    {
      name: 'GET /integrations/connections/[connectionId]/grants',
      run: () => getConnGrants(makeRequest('GET'), { params: p({ connectionId: 'c1' }) }),
    },
  ];

  for (const { name, run } of cases) {
    describe(name, () => {
      it('given onprem mode, should return 404 from the deployment mode gate', async () => {
        mockIsOnPrem.mockReturnValue(true);
        await assertModeGateBlocks(await run());
      });

      it('given cloud mode, should pass the deployment mode gate', async () => {
        mockIsOnPrem.mockReturnValue(false);
        await assertModeGatePasses(await run());
      });
    });
  }
});
