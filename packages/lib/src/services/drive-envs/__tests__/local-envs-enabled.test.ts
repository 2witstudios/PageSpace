import { describe, it, expect } from 'vitest';
import { isLocalEnvsEnabled, LOCAL_ENVS_ENABLED_VAR } from '../local-envs-enabled';

describe('isLocalEnvsEnabled — cloud opt-in for local environments (invariant 11)', () => {
  it("given the exact string 'true', should be on", () => {
    expect(isLocalEnvsEnabled({ LOCAL_ENVS_ENABLED: 'true' })).toBe(true);
  });

  it('given unset, or any other value (1, yes, TRUE, true with whitespace), should be OFF — exposing personal hardware is never a default', () => {
    for (const value of [undefined, '', '1', 'yes', 'TRUE', ' true', 'false']) {
      expect(isLocalEnvsEnabled({ LOCAL_ENVS_ENABLED: value }), `value ${JSON.stringify(value)}`).toBe(false);
    }
    expect(isLocalEnvsEnabled({})).toBe(false);
  });

  it('should name the variable operators set', () => {
    expect(LOCAL_ENVS_ENABLED_VAR).toBe('LOCAL_ENVS_ENABLED');
  });
});
