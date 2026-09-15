import { describe, it, expect } from 'vitest';
import { decideSandboxBinding } from '../../decide-sandbox-binding';
import type { SandboxBinding, SandboxGeneration, SandboxInstanceId, SpriteName } from '../../grant';

// Threat model A5, ADR 0006 §8.2, §8.8. Restore keeps the instance id;
// recreate changes it; generation catches both. The pure rows are a table
// over `decideSandboxBinding`, which `verifyGrant` consults at F9; the
// real-sprite row is G4's (relay runner) and stays `it.todo`.

const bound: SandboxBinding = { spriteName: 'ws-abc' as SpriteName, instanceId: 'sprite-111' as SandboxInstanceId, generation: 3 as SandboxGeneration };

describe('adversarial: restored-sandbox-generation', () => {
  it('given a grant bound to instanceId I and a sprite recreated under the same name, should return generation_mismatch (instance id changed)', () => {
    const actual = decideSandboxBinding({ grant: bound, observed: { instanceId: 'sprite-222' as SandboxInstanceId, generation: 3 as SandboxGeneration }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'generation_mismatch' });
  });

  it('given a grant bound to generation G and a checkpoint restore since issuance, should return generation_mismatch (generation G+1, same instance id)', () => {
    const actual = decideSandboxBinding({ grant: bound, observed: { instanceId: bound.instanceId, generation: 4 as SandboxGeneration }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'generation_mismatch' });
  });

  it('given a warm resume with unchanged id and generation, should verify ok', () => {
    const actual = decideSandboxBinding({ grant: bound, observed: { instanceId: bound.instanceId, generation: bound.generation }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: true });
  });

  it('given observed binding null (getSprite unreachable), should return generation_mismatch, never ok', () => {
    const actual = decideSandboxBinding({ grant: bound, observed: null, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'binding_unavailable' });
  });

  it('given a generation that went BACKWARDS (an older snapshot presented as current), should still return generation_mismatch (equality, not ordering)', () => {
    const actual = decideSandboxBinding({ grant: bound, observed: { instanceId: bound.instanceId, generation: 2 as SandboxGeneration }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'generation_mismatch' });
  });

  it.todo('given a real sprite deleted and recreated under the same name (integration), should deny the pre-recreate grant end to end — I/O row, owned by G4 (relay runner)');
});
