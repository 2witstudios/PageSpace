import { describe, it, expect } from 'vitest';
import { applyImplicitStepArgs } from './implicit-step-args';

describe('applyImplicitStepArgs', () => {
  it('injects driveId for create_page', () => {
    expect(applyImplicitStepArgs('create_page', { title: 'x' }, 'drive_1')).toEqual({
      title: 'x',
      driveId: 'drive_1',
    });
  });

  it('overwrites any stored driveId with the current one (never trust a stale stored value)', () => {
    expect(applyImplicitStepArgs('create_page', { title: 'x', driveId: 'stale' }, 'drive_1')).toEqual({
      title: 'x',
      driveId: 'drive_1',
    });
  });

  it('leaves other tools unchanged', () => {
    const args = { pageId: 'p1', content: 'hi' };
    expect(applyImplicitStepArgs('insert_content', args, 'drive_1')).toBe(args);
  });

  it('does not mutate the input args object', () => {
    const args = { title: 'x' };
    applyImplicitStepArgs('create_page', args, 'drive_1');
    expect(args).toEqual({ title: 'x' });
  });
});
