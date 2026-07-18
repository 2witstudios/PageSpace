import { describe, it, expect } from 'vitest';
import { planResumeBootstrap } from '../planResumeBootstrap';

describe('planResumeBootstrap', () => {
  it('given no live own stream, should rejoin, reload, then stop the local transport', () => {
    expect(planResumeBootstrap(false)).toEqual(['rejoin', 'reload', 'stop']);
  });

  it('given a genuinely live own stream, should rejoin and reload but NOT stop it', () => {
    expect(planResumeBootstrap(true)).toEqual(['rejoin', 'reload']);
  });

  it('should always rejoin before reload, regardless of stream liveness', () => {
    expect(planResumeBootstrap(false).indexOf('rejoin')).toBeLessThan(
      planResumeBootstrap(false).indexOf('reload'),
    );
    expect(planResumeBootstrap(true).indexOf('rejoin')).toBeLessThan(
      planResumeBootstrap(true).indexOf('reload'),
    );
  });
});
