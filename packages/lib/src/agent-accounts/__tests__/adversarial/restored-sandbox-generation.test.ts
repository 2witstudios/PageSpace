import { describe, it } from 'vitest';

// Threat model A5, ADR 0006 §8.2, §8.8. Restore keeps the instance id; recreate changes it; generation catches both.

describe('adversarial: restored-sandbox-generation', () => {
  it.todo('given a grant bound to instanceId I and a sprite recreated under the same name, should return generation_mismatch (instance id changed)');
  it.todo('given a grant bound to generation G and a checkpoint restore since issuance, should return generation_mismatch (generation G+1, same instance id)');
  it.todo('given a warm resume with unchanged id and generation, should verify ok');
  it.todo('given observed binding null (getSprite unreachable), should return binding_unavailable, never ok [G1a review M6]');
  it.todo('given a grant for sprite A presented while the runner is bound to sprite B that happens to share instanceId and generation values, should return generation_mismatch (spriteName compared) [G1a review M6]');
  it.todo('given a real sprite deleted and recreated under the same name (integration), should deny the pre-recreate grant end to end');
});
