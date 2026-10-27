import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import {
  agentsAutonomousDecision,
  crossDriveAgentsDecision,
  environmentsDecision,
  agentModelSaveDecision,
  allowedModelCatalog,
  drivesAllowingModel,
  integrationDecision,
  modelDecision,
  orgActorDecision,
  publishedAppsDecision,
  sandboxDecision,
  toolModelDecision,
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

describe('toolModelDecision (a model run\'s tools reading org content)', () => {
  it('POL-8 (partial) the run\'s resolved provider and model are judged like any model use', () => {
    const pol = p({ modelAllowlist: ['a/fast'] });
    expect(toolModelDecision(pol, { provider: 'x', modelId: 'a/fast' }).ok).toBe(true);
    expect(toolModelDecision(pol, { provider: 'x', modelId: 'b/slow' })).toMatchObject({ ok: false, status: 403, policy: 'modelAllowlist' });
  });

  it('POL-8 (partial) a run that names no resolved provider or model fails closed in an org drive, even one with no allowlist', () => {
    expect(toolModelDecision(p({}), {})).toMatchObject({ ok: false, status: 403, code: 'org_policy', policy: 'modelAllowlist' });
    expect(toolModelDecision(p({}), { provider: 'x' }).ok).toBe(false);
    expect(toolModelDecision(p({}), { modelId: 'a/fast' }).ok).toBe(false);
  });

  it('POL-8 (partial) content with no org (null policies) is never restricted', () => {
    expect(toolModelDecision(null, {}).ok).toBe(true);
  });
});

describe('agentModelSaveDecision (saving an agent page\'s provider/model)', () => {
  it('POL-8 (partial) only what the save sets is judged: a set model off the list is refused, an unset one is not', () => {
    const pol = p({ modelAllowlist: ['a/fast'] });
    expect(agentModelSaveDecision(pol, { provider: 'openrouter', modelId: 'b/slow' })).toMatchObject({ ok: false, status: 403, code: 'org_policy', policy: 'modelAllowlist' });
    expect(agentModelSaveDecision(pol, { provider: 'openrouter', modelId: 'a/fast' })).toEqual({ ok: true });
    expect(agentModelSaveDecision(pol, { provider: 'openrouter', modelId: null })).toEqual({ ok: true });
  });

  it('POL-8 (partial) a set provider off the provider list is refused even with no model set', () => {
    const pol = p({ providerAllowlist: ['openrouter'] });
    expect(agentModelSaveDecision(pol, { provider: 'google', modelId: null })).toMatchObject({ ok: false, policy: 'providerAllowlist' });
    expect(agentModelSaveDecision(pol, { provider: null, modelId: 'x' })).toEqual({ ok: true });
  });

  it('POL-8 (partial) no org policies never restrict a save', () => {
    expect(agentModelSaveDecision(null, { provider: 'google', modelId: 'b/slow' })).toEqual({ ok: true });
  });
});

describe('allowedModelCatalog (the model list offered in a drive)', () => {
  const catalog = [
    { provider: 'openrouter', dynamic: false, models: ['a/fast', 'b/slow'] },
    { provider: 'google', dynamic: false, models: ['g/one'] },
    { provider: 'ollama', dynamic: true, models: [] },
  ];

  it('POL-8 (partial) no org, or an org with neither allowlist set, is unrestricted (null)', () => {
    expect(allowedModelCatalog(null, catalog)).toBeNull();
    expect(allowedModelCatalog(p({}), catalog)).toBeNull();
  });

  it('POL-8 (partial) only allowed providers appear, each with only its allowed models; a dynamic provider carries the model allowlist', () => {
    expect(allowedModelCatalog(p({ providerAllowlist: ['openrouter', 'ollama'], modelAllowlist: ['b/slow', 'llama3'] }), catalog)).toEqual({
      openrouter: ['b/slow'],
      ollama: ['b/slow', 'llama3'],
    });
  });

  it('POL-8 (partial) a provider allowlist alone keeps every model of the allowed providers; dynamic providers stay open (null)', () => {
    expect(allowedModelCatalog(p({ providerAllowlist: ['google', 'ollama'] }), catalog)).toEqual({ google: ['g/one'], ollama: null });
  });

  it('POL-8 (partial) an empty allowlist offers nothing', () => {
    expect(allowedModelCatalog(p({ modelAllowlist: [] }), catalog)).toEqual({ openrouter: [], google: [], ollama: [] });
    expect(allowedModelCatalog(p({ providerAllowlist: [] }), catalog)).toEqual({});
  });
});

describe('drivesAllowingModel (whose content a background model may read)', () => {
  it('POL-8 (partial) keeps personal drives and org drives whose org allows the model; drops drives whose org does not', () => {
    const use = { modelId: 'a/fast', provider: 'openrouter' };
    expect(drivesAllowingModel([
      { driveId: 'personal', policies: null },
      { driveId: 'open-org', policies: p({}) },
      { driveId: 'strict-org', policies: p({ modelAllowlist: ['other'] }) },
      { driveId: 'provider-org', policies: p({ providerAllowlist: ['google'] }) },
    ], use)).toEqual(['personal', 'open-org']);
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
