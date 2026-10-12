import { describe, expect, it } from 'vitest';
import { assertPersonalBillingCutoverOffline } from '../personal-cutover-gate';

describe('personal billing schema cutover gate', () => {
  it('refuses a populated legacy schema without an offline cutover assertion', () => {
    expect(() => assertPersonalBillingCutoverOffline(true, undefined)).toThrow(/offline/);
    expect(() => assertPersonalBillingCutoverOffline(true, 'false')).toThrow(/offline/);
  });
  it('allows the coordinated offline cutover and subsequent ordinary deploys', () => {
    expect(() => assertPersonalBillingCutoverOffline(true, 'true')).not.toThrow();
    expect(() => assertPersonalBillingCutoverOffline(false, undefined)).not.toThrow();
  });
});
