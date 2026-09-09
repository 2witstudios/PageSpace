/**
 * `GET /api/env-bridge/approvals` (GA wave 3, leaf 6) — the account page's
 * read, owner-only by construction — and THE INVARIANT the mirror rests on:
 * no code path on the server sends an approval TO a machine. The server may
 * list and revoke; the machine's file is authoritative for allow. Pinned by
 * reading the source of every approval-shaped module, not by mocking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn(() => false) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ listOwnerApprovals: vi.fn() }));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { listOwnerApprovals } from '@/lib/drive-envs/drive-envs-runtime';

const OWNER = 'user-owner';
const ROW = { id: 'ch_1', envId: 'env-1', driveId: 'drive-1', envName: 'mac', envLabel: 'jono-macstudio', userId: OWNER, op: 'exec', summary: 'exec: git status', scope: '30d', createdAt: '2026-09-09T12:00:00.000Z', expiresAt: null, revokedAt: null, revokeAcknowledgedAt: null };
const get = () => GET(new Request('http://localhost/api/env-bridge/approvals'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: OWNER } as never);
  vi.mocked(listOwnerApprovals).mockResolvedValue([ROW] as never);
});

describe('GET /api/env-bridge/approvals', () => {
  it('given the flag off, should answer 404 and read nothing', async () => {
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
    expect((await get()).status).toBe(404);
    expect(listOwnerApprovals).not.toHaveBeenCalled();
  });

  it('given a signed-in user, should list by OWNER = the caller and audit the read', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ approvals: [ROW] });
    expect(listOwnerApprovals).toHaveBeenCalledWith(OWNER);
    expect(auditRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'data.read', userId: OWNER, resourceType: 'drive_env_approval', details: expect.objectContaining({ route: 'env-bridge/approvals', operation: 'list', rows: 1 }) }));
  });
});

/**
 * THE ASYMMETRY, on the server side. Wave 2 pinned that the codec has no
 * frame that can add an approval and that the daemon only ever writes its own
 * store. This pins the server half: the modules that hold, list or revoke
 * approvals never build a grant frame, never carry an approvalIntent, and
 * the only wire frame any of them names is `revoke`.
 */
describe('no code path sends an approval TO the machine (GA wave 2 invariant, server half)', () => {
  const WEB = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const LIB = path.resolve(WEB, '..', '..', '..', 'packages', 'lib', 'src');
  const files = [
    path.join(WEB, 'app', 'api', 'env-bridge', 'approvals', 'route.ts'),
    path.join(WEB, 'app', 'api', 'drives', '[driveId]', 'envs', '[envId]', 'approvals', 'route.ts'),
    path.join(WEB, 'app', 'api', 'drives', '[driveId]', 'envs', '[envId]', 'approvals', '[approvalId]', 'route.ts'),
    path.join(WEB, 'app', 'api', 'env-bridge', 'machines', 'route.ts'),
    path.join(WEB, 'app', 'settings', 'local-envs', 'page.tsx'),
    path.join(WEB, 'components', 'settings', 'EnvApprovalsList.tsx'),
    path.join(WEB, 'hooks', 'drive-envs', 'useEnvApprovals.ts'),
    path.join(LIB, 'services', 'drive-envs', 'approval-mirror-store.ts'),
  ];

  it('every approval-shaped module exists and none builds or sends a grant, carries an approvalIntent, or names a frame other than revoke', () => {
    for (const file of files) {
      // ONE fs call per path (CodeQL js/file-system-race): a missing module throws ENOENT here, naming the file.
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch (error) {
        throw new Error(`${file}: ${String(error)}`);
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/sendGrant\(|signGrantFrame\(|approvalIntent|grant_exec|grant_fs_read|grant_fs_write|grant_pty_open|encodeFrame\(/);
      const frameTypes = [...code.matchAll(/type: '([a-z_]+)'/g)].map((m) => m[1]).filter((t) => t !== undefined);
      expect(frameTypes.filter((t) => t !== 'revoke' && t !== 'form'), file).toEqual([]);
    }
  });

  it('the mirror store exposes no write that a request body could drive into an allow: its writers are remember (the click ran), markRevoked and markAcknowledged', () => {
    const source = readFileSync(path.join(LIB, 'services', 'drive-envs', 'approval-mirror-store.ts'), 'utf8');
    const methods = [...source.matchAll(/^  (?:async )?([a-zA-Z]+)\(/gm)].map((m) => m[1]);
    expect(methods.sort()).toEqual(['findById', 'listActiveForEnv', 'listActiveForOwner', 'listUnacknowledgedRevokes', 'markAcknowledged', 'markRevoked', 'remember'].sort());
  });

  it('the replay only ever sends `revoke` frames with an approvalId, keyed on rows the mirror already holds', () => {
    const source = readFileSync(path.join(WEB, 'lib', 'env-bridge', 'revoke.ts'), 'utf8');
    const start = source.indexOf('export async function replayUnacknowledgedApprovalRevokes');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start);
    expect(body).toMatch(/listUnacknowledgedEnvApprovalRevokes\(input\.envId\)/);
    expect(body).toMatch(/notifyMachineOfApprovalRevoke\(/);
    expect(body).not.toMatch(/sendGrant\(|signGrantFrame\(|approvalIntent|remember\(/);
    // The web dir has no other file that lists env dirs by name — a sanity check the scan above is not vacuous.
    expect(readdirSync(path.join(WEB, 'app', 'api', 'env-bridge')).filter((name) => !name.startsWith('__')).sort()).toEqual(['activity', 'approvals', 'enroll', 'machines', 'token', 'ws'].sort());
  });
});
