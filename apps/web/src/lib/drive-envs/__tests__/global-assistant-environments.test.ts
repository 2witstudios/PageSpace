/**
 * `LOCAL_ENVS_ENABLED` gates LOCAL MACHINES ONLY.
 *
 * Driven through the flag's REAL reader (`process.env.LOCAL_ENVS_ENABLED`),
 * never an injected `isEnabled` stub — the defect these rows exist for was
 * invisible to every test that injected one, because the injected value was
 * always `true` while the deployed value is always off.
 *
 * The failing case is the one the founder's ruling exists for: a person whose
 * OWN tier cannot run a personal sandbox, but who has edit access to a PAID
 * team drive, can run code in that drive — so their global assistant must be
 * able to as well, flag or no flag. `LOCAL_ENVS_ENABLED` is about exposing
 * personal hardware; it has nothing to say about a drive's own cloud sandbox.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockListVisibleByOwner, mockListSpriteEnvs, mockCanRunCode } = vi.hoisted(() => ({
  mockListVisibleByOwner: vi.fn(),
  mockListSpriteEnvs: vi.fn(),
  mockCanRunCode: vi.fn<(input: { userId: string; driveId?: string }) => Promise<{ ok: boolean; reason?: string }>>(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/services/sandbox/can-run-code', async (orig) => ({
  ...(await orig<typeof import('@pagespace/lib/services/sandbox/can-run-code')>()),
  canRunCode: mockCanRunCode,
}));
vi.mock('@pagespace/lib/services/drive-envs/drive-envs-store', () => ({
  createDbDriveEnvStore: async () => ({
    listVisibleToGlobalAssistantByOwner: mockListVisibleByOwner,
    listSpriteEnvsInUserDrives: mockListSpriteEnvs,
  }),
}));

import { listGlobalAssistantEnvironments } from '../drive-envs-runtime';

const PAID_DRIVE = 'drive-paid';
const CLOUD_ENV = { id: 'j945few5ssv75k5ad0bowbb4', name: 'staging', substrate: 'sprite' as const, driveId: PAID_DRIVE };
const LOCAL_ROW = {
  env: { id: 'dw9jthqyaza6ga3b6m5nmpqw', name: 'mac', substrate: 'local' as const, driveId: 'drive-mine' },
  local: { label: 'jono-macstudio' },
};

let originalFlag: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalFlag = process.env.LOCAL_ENVS_ENABLED;
  mockListSpriteEnvs.mockResolvedValue([CLOUD_ENV]);
  mockListVisibleByOwner.mockResolvedValue([LOCAL_ROW]);
  // The founder's case: this user's OWN tier is irrelevant; the PAID drive's
  // payer is what `canRunCode` resolves, and it passes.
  mockCanRunCode.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.LOCAL_ENVS_ENABLED;
  else process.env.LOCAL_ENVS_ENABLED = originalFlag;
});

describe('LOCAL_ENVS_ENABLED gates local machines only', () => {
  it('given the flag OFF (production today), should STILL list the cloud env of a drive the user can run code in', async () => {
    delete process.env.LOCAL_ENVS_ENABLED;
    const listed = await listGlobalAssistantEnvironments('free-tier-user');
    expect(listed.map((row) => row.id)).toEqual([CLOUD_ENV.id]);
    expect(listed[0]).toMatchObject({ substrate: 'sprite', driveId: PAID_DRIVE, label: 'staging' });
    // The authority is the DRIVE's, asked for that drive.
    expect(mockCanRunCode).toHaveBeenCalledWith(expect.objectContaining({ userId: 'free-tier-user', driveId: PAID_DRIVE }));
  });

  it('given the flag OFF, a visible LOCAL machine should be neither listed nor even read', async () => {
    delete process.env.LOCAL_ENVS_ENABLED;
    const listed = await listGlobalAssistantEnvironments('free-tier-user');
    expect(listed.some((row) => row.substrate === 'local')).toBe(false);
    // Nothing about someone's personal hardware is read while the opt-in is off.
    expect(mockListVisibleByOwner).not.toHaveBeenCalled();
  });

  it('given the flag ON, should list BOTH the cloud env and the visible local machine', async () => {
    process.env.LOCAL_ENVS_ENABLED = 'true';
    const listed = await listGlobalAssistantEnvironments('free-tier-user');
    expect(listed.map((row) => row.substrate).sort()).toEqual(['local', 'sprite']);
  });

  it('the cloud half still answers to canRunCode — a VIEWER in that drive gets nothing, flag or no flag', async () => {
    mockCanRunCode.mockResolvedValue({ ok: false, reason: 'insufficient_role' });
    for (const flag of [undefined, 'true']) {
      if (flag === undefined) delete process.env.LOCAL_ENVS_ENABLED;
      else process.env.LOCAL_ENVS_ENABLED = flag;
      const listed = await listGlobalAssistantEnvironments('viewer');
      expect(listed.some((row) => row.substrate === 'sprite'), `flag=${flag}`).toBe(false);
    }
  });
});
