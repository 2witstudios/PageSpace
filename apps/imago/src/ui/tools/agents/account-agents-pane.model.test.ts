import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';
import { envStatusOf } from './account-agents-pane.model';

const base = { driveId: 'd1', createdAt: '2026-10-12T10:00:00.000Z' };
const sprite = (id: string, status: 'none' | 'running' | 'stopped'): DriveEnvDTO => ({ ...base, id, name: id, substrate: 'sprite', status });
const local = (id: string, status: 'connecting' | 'connected' | 'disconnected', enrolled: boolean): DriveEnvDTO => ({
  ...base,
  id,
  name: id,
  substrate: 'local',
  status,
  label: 'MacBook',
  enrolled,
});

describe('envStatusOf (IMC-7.29)', () => {
  test('a sprite environment reads running, stopped or not started', () => {
    assert({
      given: 'sprite environments in each VM state',
      should: 'word the dot as Environment running, Environment stopped or Environment not started yet',
      actual: [
        envStatusOf(sprite('a', 'running')).label,
        envStatusOf(sprite('b', 'stopped')).label,
        envStatusOf(sprite('c', 'none')).label,
      ],
      expected: ['Environment running', 'Environment stopped', 'Environment not started yet'],
    });
  });

  test('a local environment reads its machine connection', () => {
    assert({
      given: 'an enrolled local environment in each connection state',
      should: 'word the dot as Machine connected, Machine connecting or Machine not connected',
      actual: [
        envStatusOf(local('a', 'connected', true)).label,
        envStatusOf(local('b', 'connecting', true)).label,
        envStatusOf(local('c', 'disconnected', true)).label,
      ],
      expected: ['Machine connected', 'Machine connecting', 'Machine not connected'],
    });
  });

  test('a local environment that never enrolled is not called disconnected', () => {
    assert({
      given: 'a local environment whose machine has not enrolled',
      should: 'say Awaiting enrollment, toned as a warning',
      actual: envStatusOf(local('a', 'disconnected', false)),
      expected: { label: 'Awaiting enrollment', tone: 'warning' },
    });
  });

  test('a running environment is success-toned and a stopped one warning-toned', () => {
    assert({
      given: 'a running and a stopped sprite environment',
      should: 'tone running as success and stopped as warning',
      actual: [envStatusOf(sprite('a', 'running')).tone, envStatusOf(sprite('b', 'stopped')).tone],
      expected: ['success', 'warning'],
    });
  });
});
