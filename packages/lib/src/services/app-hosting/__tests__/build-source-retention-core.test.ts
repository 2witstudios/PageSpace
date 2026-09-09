import { describe, it, expect } from 'vitest';
import { planBuildSourceRetention } from '../build-source-retention-core';

describe('planBuildSourceRetention', () => {
  it('keeps only the newest N when nothing must be force-kept', () => {
    const result = planBuildSourceRetention({
      sourceRefsNewestFirst: ['app/5', 'app/4', 'app/3', 'app/2', 'app/1'],
      keepNewest: 3,
      mustKeep: null,
    });
    expect(result.keep).toEqual(['app/5', 'app/4', 'app/3']);
    expect(result.remove).toEqual(['app/2', 'app/1']);
  });

  it('force-keeps the reconciler-named ref even if older than the cutoff', () => {
    const result = planBuildSourceRetention({
      sourceRefsNewestFirst: ['app/5', 'app/4', 'app/3', 'app/2', 'app/1'],
      keepNewest: 2,
      mustKeep: 'app/1',
    });
    expect(result.keep).toEqual(expect.arrayContaining(['app/5', 'app/4', 'app/1']));
    expect(result.remove).toEqual(['app/3', 'app/2']);
  });

  it('is a no-op when everything already fits within the keep window', () => {
    const result = planBuildSourceRetention({
      sourceRefsNewestFirst: ['app/2', 'app/1'],
      keepNewest: 3,
      mustKeep: null,
    });
    expect(result.keep).toEqual(['app/2', 'app/1']);
    expect(result.remove).toEqual([]);
  });

  it('ignores a mustKeep ref that is not in the candidate list', () => {
    const result = planBuildSourceRetention({
      sourceRefsNewestFirst: ['app/2', 'app/1'],
      keepNewest: 1,
      mustKeep: 'app/gone',
    });
    expect(result.keep).toEqual(['app/2']);
    expect(result.remove).toEqual(['app/1']);
  });
});
