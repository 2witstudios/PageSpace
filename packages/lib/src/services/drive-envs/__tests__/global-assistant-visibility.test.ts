/**
 * Leaf A — environment visibility to the GLOBAL ASSISTANT: a per-environment
 * toggle, DEFAULT OFF.
 *
 * The global assistant's context spans every drive a person belongs to, so
 * what it may reach is a deliberate choice rather than a consequence of
 * ownership. Every row below is a Given/Should from the leaf's own page.
 */
import { describe, it, expect } from 'vitest';
import { createDriveEnv, setGlobalAssistantVisibility, type LocalEnvIdentityDeps } from '../drive-envs';
import { conversationMayReachPersistentEnvironments, decideEnvReach, ENV_REACH_DENY_ORDER, ENV_UNREACHABLE_MESSAGE } from '../../../env-bridge/decide-env-reach';
import { decideBind } from '../../../env-bridge/decide-bind';
import type { CanRunCodeResult } from '../../sandbox/can-run-code';
import { makeDriveEnvStore, DRIVE_ID, PAYER_ID, NOW } from './fakes';

const identity: LocalEnvIdentityDeps = {
  random: (length) => new Uint8Array(length),
  hash: () => 'hash',
  fingerprint: () => 'fp',
  isEd25519PublicKey: () => true,
  verify: () => true,
  newEnrollmentId: () => 'enr-1',
  signingKey: { keyId: 'srv-k1', publicKey: new Uint8Array(32) },
};

async function harness() {
  const fake = makeDriveEnvStore([], () => NOW);
  const deps = { store: fake.store, resolvePayer: async () => ({ payerId: PAYER_ID, tier: 'pro' as const }), now: () => NOW, identity };
  const created = await createDriveEnv({ driveId: DRIVE_ID, name: 'mac', createdBy: 'owner-1', local: { label: 'mac', ownerId: 'owner-1', serverPolicy: { ops: ['exec'], checkpoint: false } }, deps });
  if (!created.ok) throw new Error(created.reason);
  const later = new Date(NOW.getTime() + 60_000);
  const set = (requesterId: string, visible: boolean) =>
    setGlobalAssistantVisibility({ envId: created.env.id, requesterId, visible, deps: { store: fake.store, now: () => later } });
  return { fake, envId: created.env.id, set, later };
}

describe('visibility to the global assistant — default off, owner-only', () => {
  it('given an environment with no visibility recorded, should be invisible to the global assistant — the default is off and the absence of a value is never a grant', async () => {
    const h = await harness();
    // The row as MINTED, with nothing ever written to the flag.
    expect(h.fake.rows.get(h.envId)!.visibleToGlobalAssistant).toBe(false);
    expect(decideEnvReach({ actorId: 'owner-1', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: { substrate: 'local', visibleToGlobalAssistant: false, ownerId: 'owner-1' } })).toEqual({ ok: false, reason: 'not_visible' });
  });

  it('given the owner turns visibility on, should change nothing about who may drive the machine — D-6 owner-only binding is untouched', async () => {
    const h = await harness();
    expect(await h.set('owner-1', true)).toEqual({ ok: true, visibleToGlobalAssistant: true });
    const row = h.fake.local.get(h.envId)!;
    // The bind policy, the owner, the key and the server policy are all as they were.
    expect(row.bindPolicy).toBe('owner');
    expect(row.ownerId).toBe('owner-1');
    expect(row.serverPolicy).toEqual({ ops: ['exec'], checkpoint: false });
    // And the bind gate still refuses a non-owner on a fully visible env.
    const bindFacts = {
      canRunCode: { ok: true } as const,
      bindPolicy: 'owner' as const,
      env: { ownerId: 'owner-1', substrate: 'local', revokedAt: null },
      serverPolicy: { ops: ['exec'] as const, checkpoint: false },
      connected: true,
      flagEnabled: true,
    };
    expect(decideBind({ ...bindFacts, actorId: 'someone-else' })).toEqual({ ok: false, reason: 'bind_policy' });
    expect(decideBind({ ...bindFacts, actorId: 'owner-1' })).toEqual({ ok: true });
  });

  it('given a caller who is not the environment owner, should refuse — decided by drive_env_local.ownerId and never by a drive role', async () => {
    const h = await harness();
    const before = { ...h.fake.rows.get(h.envId)! };
    // `admin-2` is a drive admin in every sense that matters elsewhere; here it buys nothing.
    expect(await h.set('admin-2', true)).toEqual({ ok: false, reason: 'not_owner', ownerId: 'owner-1' });
    expect(h.fake.rows.get(h.envId)).toEqual(before);
  });

  it('given a revoked env, should refuse revoked; given an unknown env, should refuse not_found', async () => {
    const h = await harness();
    expect(await setGlobalAssistantVisibility({ envId: 'env-nope', requesterId: 'owner-1', visible: true, deps: { store: h.fake.store, now: () => NOW } })).toEqual({ ok: false, reason: 'not_found' });
    await h.fake.store.revokeLocal({ envId: h.envId, now: NOW });
    expect(await h.set('owner-1', true)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('given both substrates exist, the flag lives on drive_envs so a cloud env and a local machine answer the same question the same way', async () => {
    const h = await harness();
    await h.set('owner-1', true);
    // The value is on the ENV row, not the local sibling — one column, one read,
    // whatever runs the environment.
    expect(h.fake.rows.get(h.envId)!.visibleToGlobalAssistant).toBe(true);
    expect(h.fake.local.get(h.envId)).not.toHaveProperty('visibleToGlobalAssistant');
  });

  it('given visibility is turned OFF while a conversation already holds a session there, should refuse the NEXT call rather than honouring the earlier reach', async () => {
    const h = await harness();
    await h.set('owner-1', true);
    const reachNow = () => decideEnvReach({ actorId: 'owner-1', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: { substrate: 'local', visibleToGlobalAssistant: h.fake.rows.get(h.envId)!.visibleToGlobalAssistant, ownerId: 'owner-1' } });
    expect(reachNow()).toEqual({ ok: true });
    // The owner switches it off mid-conversation. Nothing about the session row
    // changes — the reach is re-decided from the env on the next call.
    expect(await h.set('owner-1', false)).toEqual({ ok: true, visibleToGlobalAssistant: false });
    expect(reachNow()).toEqual({ ok: false, reason: 'not_visible' });
  });
});

describe('decideEnvReach — absence is never a grant, and a refusal never leaks', () => {
  it('refuses a missing row, an ownerless LOCAL env, a non-owner and an invisible one, in the documented order', () => {
    // All LOCAL: the owner/opt-in arm. `mayRunCodeInEnvDrive: true` throughout,
    // to show that a drive permission never substitutes for either half.
    const local = (over: { visibleToGlobalAssistant: boolean; ownerId: string | null }) => ({ substrate: 'local' as const, ...over });
    const reach = (env: ReturnType<typeof local> | null) =>
      decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env });
    expect(reach(null)).toEqual({ ok: false, reason: 'not_found' });
    expect(reach(local({ visibleToGlobalAssistant: true, ownerId: null }))).toEqual({ ok: false, reason: 'not_owner' });
    expect(reach(local({ visibleToGlobalAssistant: true, ownerId: 'other' }))).toEqual({ ok: false, reason: 'not_owner' });
    expect(reach(local({ visibleToGlobalAssistant: false, ownerId: 'u' }))).toEqual({ ok: false, reason: 'not_visible' });
    expect(reach(local({ visibleToGlobalAssistant: true, ownerId: 'u' }))).toEqual({ ok: true });
    expect(ENV_REACH_DENY_ORDER).toEqual(['not_global', 'not_found', 'not_permitted', 'not_owner', 'not_visible']);
  });

  it('surfaces ONE sentence for all three refusals, so an id that does not exist and one the caller may not see are indistinguishable', () => {
    // The message is a single constant by construction — a per-reason message
    // would be the probe this refuses to answer.
    expect(ENV_UNREACHABLE_MESSAGE).toContain('list_environments');
    expect(ENV_UNREACHABLE_MESSAGE).toContain('never construct or guess one');
    expect(ENV_UNREACHABLE_MESSAGE).not.toMatch(/exist|owner|visib/i);
  });
});

describe('decideEnvReach — only the GLOBAL assistant reaches a persistent environment', () => {
  const visibleMine = { substrate: 'local', visibleToGlobalAssistant: true, ownerId: 'u' } as const;

  it('given a PAGE conversation, should refuse even an environment the actor owns and has made visible', () => {
    // The promise is specifically about the global assistant: the column is
    // `visibleToGlobalAssistant`, and the settings toggle says "Let your global
    // assistant use this machine". Switching a laptop on for the assistant you
    // talk to from the dashboard is not switching it on for every
    // sandbox-enabled agent in every drive you belong to.
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'page', mayRunCodeInEnvDrive: true, env: visibleMine })).toEqual({ ok: false, reason: 'not_global' });
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: visibleMine })).toEqual({ ok: true });
  });

  it('refuses a page conversation BEFORE the row is consulted, so the deny order leaks nothing about whether an id exists', () => {
    // Same answer for a real env, a missing one, and someone else's — a page
    // turn cannot tell them apart, which is the point.
    // A CLOUD env the user could run in is in the list too: a page turn is
    // refused the same way, and its permission never comes into it.
    const cases = [
      visibleMine,
      null,
      { substrate: 'local' as const, visibleToGlobalAssistant: true, ownerId: 'someone-else' },
      { substrate: 'sprite' as const, visibleToGlobalAssistant: false, ownerId: null },
    ];
    for (const env of cases) {
      expect(decideEnvReach({ actorId: 'u', conversationKind: 'page', mayRunCodeInEnvDrive: true, env })).toEqual({ ok: false, reason: 'not_global' });
    }
  });

  it('the rule is ONE predicate both call sites share — discovery and resolution cannot drift', () => {
    expect(conversationMayReachPersistentEnvironments('global')).toBe(true);
    expect(conversationMayReachPersistentEnvironments('page')).toBe(false);
  });
});

describe('decideEnvReach — a CLOUD env reaches by canRunCode parity, not by a visibility toggle', () => {
  // Founder ruling 2026-09-12: "if the user can, their global assistant should
  // be able to". For a Sprite env the DRIVE PERMISSION is the visibility —
  // there is no per-env opt-in, because there is no owner to opt in.
  const cloud = (over: Partial<Parameters<typeof decideEnvReach>[0]['env'] & object> = {}) => ({
    visibleToGlobalAssistant: false,
    ownerId: null,
    substrate: 'sprite' as const,
    ...over,
  });

  it('given a Sprite env the user may run code in, should reach it WITHOUT any visibility toggle', () => {
    expect(
      decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: cloud() }),
    ).toEqual({ ok: true });
  });

  it('given a Sprite env the user may NOT run code in, should refuse not_permitted — a VIEWER is refused exactly as in-drive', () => {
    expect(
      decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: false, env: cloud() }),
    ).toEqual({ ok: false, reason: 'not_permitted' });
  });

  it('a visibility flag on a Sprite env changes NOTHING in either direction — the drive permission is the whole answer', () => {
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: cloud({ visibleToGlobalAssistant: true }) })).toEqual({ ok: true });
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: false, env: cloud({ visibleToGlobalAssistant: true }) })).toEqual({ ok: false, reason: 'not_permitted' });
  });

  it('a PAGE conversation is still refused not_global, before the permission is even consulted', () => {
    expect(
      decideEnvReach({ actorId: 'u', conversationKind: 'page', mayRunCodeInEnvDrive: true, env: cloud() }),
    ).toEqual({ ok: false, reason: 'not_global' });
  });

  it('a LOCAL env is unchanged: owner AND visible, and code-exec permission alone is not enough', () => {
    const local = { ownerId: 'u', substrate: 'local' as const, visibleToGlobalAssistant: false };
    // Permission in the drive does not substitute for the owner's opt-in.
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: local })).toEqual({ ok: false, reason: 'not_visible' });
    expect(decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: { ...local, visibleToGlobalAssistant: true } })).toEqual({ ok: true });
    // Nor does the owner's opt-in substitute for being the owner.
    expect(decideEnvReach({ actorId: 'someone-else', conversationKind: 'global', mayRunCodeInEnvDrive: true, env: { ...local, visibleToGlobalAssistant: true } })).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('the deny order keeps not_global FIRST and names the cloud refusal', () => {
    expect(ENV_REACH_DENY_ORDER).toEqual(['not_global', 'not_found', 'not_permitted', 'not_owner', 'not_visible']);
    expect(ENV_REACH_DENY_ORDER[0]).toBe('not_global');
  });

  it('every cloud refusal still surfaces the ONE message — a real id in a drive you are not in is indistinguishable from a guess', () => {
    const notMine = decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: false, env: cloud() });
    const missing = decideEnvReach({ actorId: 'u', conversationKind: 'global', mayRunCodeInEnvDrive: false, env: null });
    expect(notMine.ok).toBe(false);
    expect(missing.ok).toBe(false);
    // Different typed reasons for the audit; one sentence for the caller.
    expect(ENV_UNREACHABLE_MESSAGE).not.toMatch(/permission|member|drive/i);
  });
});

describe('PARITY DRIFT GUARD — the reach verdict for a Sprite env never diverges from in-drive canRunCode', () => {
  // The founder's ruling is a PROMISE ("if the user can, their global assistant
  // should be able to"), so it is a test rather than a comment. For every
  // combination of the inputs `canRunCode` actually varies on, the cloud reach
  // verdict must equal the code-exec verdict — no case where one allows and the
  // other refuses, in either direction.
  const cloudEnv = { substrate: 'sprite' as const, visibleToGlobalAssistant: false, ownerId: null };

  it('agrees with canRunCode on every verdict it can produce', () => {
    const codeExecVerdicts: CanRunCodeResult[] = [
      { ok: true },
      { ok: false, reason: 'kill_switch_off' },
      { ok: false, reason: 'tier_ineligible' },
      { ok: false, reason: 'no_drive_access' },
      { ok: false, reason: 'insufficient_role' },
      { ok: false, reason: 'no_agent_access' },
      { ok: false, reason: 'error' },
    ];
    for (const verdict of codeExecVerdicts) {
      const reach = decideEnvReach({
        actorId: 'u',
        conversationKind: 'global',
        // This is the ONLY thing the caller may derive it from.
        mayRunCodeInEnvDrive: verdict.ok,
        env: cloudEnv,
      });
      expect(reach.ok, `canRunCode ${verdict.ok ? 'ok' : verdict.reason} must not diverge from reach`).toBe(verdict.ok);
    }
  });

  it('a stray visibility flag cannot make the two disagree in either direction', () => {
    for (const visible of [false, true]) {
      for (const may of [false, true]) {
        const reach = decideEnvReach({
          actorId: 'u',
          conversationKind: 'global',
          mayRunCodeInEnvDrive: may,
          env: { ...cloudEnv, visibleToGlobalAssistant: visible },
        });
        expect(reach.ok, `visible=${visible} may=${may}`).toBe(may);
      }
    }
  });

  it('the actor identity cannot make them disagree either — a cloud env has no owner to privilege', () => {
    for (const actorId of ['u', 'someone-else', 'drive-owner']) {
      expect(decideEnvReach({ actorId, conversationKind: 'global', mayRunCodeInEnvDrive: true, env: cloudEnv }).ok).toBe(true);
      expect(decideEnvReach({ actorId, conversationKind: 'global', mayRunCodeInEnvDrive: false, env: cloudEnv }).ok).toBe(false);
    }
  });
});
