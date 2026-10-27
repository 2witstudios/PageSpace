import { describe, test } from 'vitest';
import { assert } from './riteway';
import { resolveHoldDisposition } from '../resolve-hold-disposition';

describe('resolveHoldDisposition', () => {
  test('setup-phase failure always releases the hold (L6)', () => {
    assert({
      given: 'phase=setup — a throw before streamText took over the hold',
      should: 'release the hold outright: no provider tokens were ever billed',
      actual: resolveHoldDisposition({ phase: 'setup', aborted: false, usage: false }),
      expected: 'release',
    });
  });

  test('setup-phase release wins even if usage/abort flags are set', () => {
    assert({
      given: 'phase=setup with aborted=true and usage=true',
      should: 'still release — setup means streamText never ran, nothing to settle',
      actual: resolveHoldDisposition({ phase: 'setup', aborted: true, usage: true }),
      expected: 'release',
    });
  });

  test('consumer abort during streaming is owned by the stream lifecycle', () => {
    assert({
      given: 'phase=streaming with aborted=true and usage=true',
      should: 'return handed-off — the abort path settles burned tokens itself',
      actual: resolveHoldDisposition({ phase: 'streaming', aborted: true, usage: true }),
      expected: 'handed-off',
    });
  });

  test('abort with no usage is still handed off, not released by the error path', () => {
    assert({
      given: 'phase=streaming with aborted=true and usage=false',
      should: 'return handed-off — the error handler must not touch an aborted hold',
      actual: resolveHoldDisposition({ phase: 'streaming', aborted: true, usage: false }),
      expected: 'handed-off',
    });
  });

  test('mid-stream error with burned tokens settles partial usage before release (L7)', () => {
    assert({
      given: 'phase=streaming with aborted=false and usage=true',
      should: 'return settle-partial — bill best-effort spend instead of dropping it',
      actual: resolveHoldDisposition({ phase: 'streaming', aborted: false, usage: true }),
      expected: 'settle-partial',
    });
  });

  test('mid-stream error with nothing burned just releases the hold', () => {
    assert({
      given: 'phase=streaming with aborted=false and usage=false',
      should: 'return release — no spend to record, so free the hold directly',
      actual: resolveHoldDisposition({ phase: 'streaming', aborted: false, usage: false }),
      expected: 'release',
    });
  });
});
