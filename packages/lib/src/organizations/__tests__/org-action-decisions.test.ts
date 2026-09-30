import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import {
  agentsAutonomousDecision,
  crossDriveAgentsDecision,
  environmentsDecision,
  integrationDecision,
  modelDecision,
  orgActorDecision,
  publishedAppsDecision,
  sandboxDecision,
} from '../org-action-decisions';

const p = (over: Partial<typeof DEFAULT_ORG_POLICIES>) => ({ ...DEFAULT_ORG_POLICIES, ...over });

describe('orgActorDecision (who can invite / who can create org drives)', () => {
  it.each([
    ['admins', 'OWNER', true],
    ['admins', 'ADMIN', true],
    ['admins', 'MEMBER', false],
    ['members', 'OWNER', true],
    ['members', 'ADMIN', true],
    ['members', 'MEMBER', true],
  ] as const)('POL-5 (partial) under %s a %s is %s', (setting, role, allowed) => {
    expect(orgActorDecision(setting, role, 'invite').ok).toBe(allowed);
  });

  it('POL-5 (partial) a refusal names what was refused and is a 403', () => {
    expect(orgActorDecision('admins', 'MEMBER', 'create_drive')).toMatchObject({ ok: false, status: 403, code: 'org_policy', policy: 'whoCanCreateDrives', message: expect.stringContaining('create drives') });
    expect(orgActorDecision('admins', 'MEMBER', 'invite')).toMatchObject({ ok: false, policy: 'whoCanInvite', message: expect.stringContaining('invite') });
  });

  it('POL-5 (partial) an unknown setting or role fails closed to refuse', () => {
    expect(orgActorDecision('everyone' as never, 'MEMBER', 'invite').ok).toBe(false);
    expect(orgActorDecision('members', 'STRANGER' as never, 'invite').ok).toBe(false);
  });
});

describe('modelDecision', () => {
  it('POL-8 (partial) no allowlists allow every model and provider', () => {
    expect(modelDecision(p({}), { modelId: 'anthropic/claude-x', provider: 'openrouter' }).ok).toBe(true);
  });

  it('POL-8 (partial) a model allowlist allows only the models named', () => {
    const pol = p({ modelAllowlist: ['a/fast'] });
    expect(modelDecision(pol, { modelId: 'a/fast', provider: 'x' }).ok).toBe(true);
    expect(modelDecision(pol, { modelId: 'b/slow', provider: 'x' })).toMatchObject({ ok: false, status: 403, policy: 'modelAllowlist' });
  });

  it('POL-8 (partial) a provider allowlist allows only the providers named, independently of the model list', () => {
    const pol = p({ providerAllowlist: ['openrouter'] });
    expect(modelDecision(pol, { modelId: 'any', provider: 'openrouter' }).ok).toBe(true);
    expect(modelDecision(pol, { modelId: 'any', provider: 'google' })).toMatchObject({ ok: false, policy: 'providerAllowlist' });
  });

  it('POL-8 (partial) BOTH lists must allow; an EMPTY list allows nothing, never everything', () => {
    expect(modelDecision(p({ modelAllowlist: ['m'], providerAllowlist: ['other'] }), { modelId: 'm', provider: 'x' }).ok).toBe(false);
    expect(modelDecision(p({ modelAllowlist: [] }), { modelId: 'm', provider: 'x' }).ok).toBe(false);
    expect(modelDecision(p({ providerAllowlist: [] }), { modelId: 'm', provider: 'x' }).ok).toBe(false);
  });

  it('POL-8 (partial) a call with no org policies (a personal drive, the global assistant) is never restricted', () => {
    expect(modelDecision(null, { modelId: 'm', provider: 'x' }).ok).toBe(true);
  });
});

describe('switch decisions', () => {
  it.each([
    ['agents autonomous', agentsAutonomousDecision, 'agentsAutonomous'],
    ['cross-drive agents', crossDriveAgentsDecision, 'crossDriveAgents'],
    ['cloud sandbox', sandboxDecision, 'cloudSandbox'],
    ['persistent environments', environmentsDecision, 'persistentEnvironments'],
    ['published apps', publishedAppsDecision, 'publishedApps'],
  ] as const)('POL-9 POL-10 (partial) %s: on allows, off refuses naming its policy, no org allows', (_name, decide, key) => {
    expect(decide(p({ [key]: true }))).toEqual({ ok: true });
    expect(decide(p({ [key]: false }))).toMatchObject({ ok: false, status: 403, code: 'org_policy', policy: key });
    expect(decide(null)).toEqual({ ok: true });
  });
});

describe('integrationDecision', () => {
  it('POL-11 (partial) no allowlist allows every service; a list allows only the services named; an empty list allows none', () => {
    expect(integrationDecision(p({}), 'github').ok).toBe(true);
    expect(integrationDecision(p({ integrationsAllowlist: ['github'] }), 'github').ok).toBe(true);
    expect(integrationDecision(p({ integrationsAllowlist: ['github'] }), 'slack')).toMatchObject({ ok: false, status: 403, policy: 'integrationsAllowlist' });
    expect(integrationDecision(p({ integrationsAllowlist: [] }), 'github').ok).toBe(false);
  });

  it('POL-11 (partial) a drive with no org is never restricted', () => {
    expect(integrationDecision(null, 'slack').ok).toBe(true);
  });
});
