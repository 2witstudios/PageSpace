/**
 * POL-11 (partial): the org's service allowlist is judged where an integration call is about to happen.
 * Every case stops before the provider is reached, so none needs the HTTP pipeline: a call that clears the
 * policy lands on the NEXT check ("Provider config not found") instead of the policy refusal.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeToolSaga, type ExecuteToolDependencies } from './execute-tool';
import { DEFAULT_ORG_POLICIES, type OrgPolicies } from '../../organizations/policies-core';

const policies = (integrationsAllowlist: string[] | null): OrgPolicies => ({ ...DEFAULT_ORG_POLICIES, integrationsAllowlist });

const connection = (over: Record<string, unknown> = {}) => ({
  id: 'conn-1',
  providerId: 'p-github',
  name: 'GitHub',
  status: 'active',
  credentials: {},
  driveId: 'drive-1',
  suspendedByPolicy: null,
  provider: { id: 'p-github', slug: 'github', name: 'GitHub', config: undefined as never },
  ...over,
});

function run(opts: { conn: ReturnType<typeof connection>; policies: OrgPolicies | null; requestDriveId?: string | null }) {
  const logAudit = vi.fn(async () => undefined);
  const getDriveOrgPolicies = vi.fn(async () => opts.policies);
  const deps: ExecuteToolDependencies = { loadConnection: async () => opts.conn, logAudit, getDriveOrgPolicies };
  const result = executeToolSaga(
    { connectionId: 'conn-1', toolName: 'list_repos', input: {}, driveId: opts.requestDriveId === undefined ? 'drive-1' : opts.requestDriveId } as never,
    deps,
  );
  return { result, logAudit, getDriveOrgPolicies };
}

describe('integration calls follow the org allowlist', () => {
  it('POL-11 refuses a provider that is off the allowlist, and audits the refusal', async () => {
    const { result, logAudit } = run({ conn: connection(), policies: policies(['slack']) });
    expect(await result).toMatchObject({ success: false, errorType: 'validation', error: expect.stringContaining("doesn't allow that service") });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorType: 'INTEGRATION_ORG_POLICY' }));
  });

  it('POL-11 an empty allowlist allows nothing (never everything)', async () => {
    const { result } = run({ conn: connection(), policies: policies([]) });
    expect(await result).toMatchObject({ success: false, error: expect.stringContaining("doesn't allow that service") });
  });

  it('POL-11 refuses a SUSPENDED connection even when the provider is allowed again (marker not yet reconciled)', async () => {
    const { result } = run({ conn: connection({ suspendedByPolicy: 'integrations' }), policies: policies(['github']) });
    expect(await result).toMatchObject({ success: false, error: expect.stringContaining('right now') });
  });

  it('POL-11 refuses a suspended connection in a drive with no org too (a marker is never ignored)', async () => {
    const { result } = run({ conn: connection({ suspendedByPolicy: 'integrations' }), policies: null });
    expect(await result).toMatchObject({ success: false, error: expect.stringContaining('right now') });
  });

  it('POL-11 allows a listed provider, a null allowlist, and a drive with no org: the call proceeds past the policy', async () => {
    for (const p of [policies(['github']), policies(null), null]) {
      const { result } = run({ conn: connection(), policies: p });
      expect(await result).toMatchObject({ success: false, error: 'Provider config not found' });
    }
  });

  it('POL-11 judges the drive the call runs IN, so a connection of another drive cannot carry a call past this org', async () => {
    const { result, getDriveOrgPolicies } = run({ conn: connection({ driveId: 'other-drive' }), policies: policies(['slack']), requestDriveId: 'drive-1' });
    expect(await result).toMatchObject({ success: false, error: expect.stringContaining("doesn't allow that service") });
    expect(getDriveOrgPolicies).toHaveBeenCalledWith('drive-1');
  });

  it('POL-11 a call with no drive at all, on a personal connection, reads no policy', async () => {
    const { result, getDriveOrgPolicies } = run({ conn: connection({ driveId: null }), policies: policies([]), requestDriveId: null });
    expect(await result).toMatchObject({ error: 'Provider config not found' });
    expect(getDriveOrgPolicies).not.toHaveBeenCalled();
  });
});
