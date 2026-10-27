import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  activityQuery,
  defaultActivityRange,
  parseActivityUrl,
  withActivityFilter,
} from './activity-query';

const NOW = new Date('2026-10-12T12:00:00.000Z');

describe('parseActivityUrl', () => {
  test('defaults to the last 7 days with no filters', () => {
    assert({
      given: 'an empty query string',
      should: 'read the 7 day range and no filters',
      actual: parseActivityUrl(new URLSearchParams('')),
      expected: { range: '7d', actorId: undefined, operation: undefined, resourceType: undefined },
    });
  });

  test('keeps known filters and drops an unknown range', () => {
    assert({
      given: 'a range it does not know and a resource and operation',
      should: 'fall back to the default range and keep the rest',
      actual: parseActivityUrl(new URLSearchParams('range=1y&resourceType=page&operation=update')),
      expected: { range: defaultActivityRange, actorId: undefined, operation: 'update', resourceType: 'page' },
    });
  });
});

describe('activityQuery', () => {
  test('requests the drive with a window starting range-length before now', () => {
    assert({
      given: 'the 24 hour range',
      should: 'start the window 24 hours before now',
      actual: activityQuery({ range: '24h' }, 'd1', NOW).get('startDate'),
      expected: '2026-10-11T12:00:00.000Z',
    });
  });

  test('carries the context, drive and the chosen filters', () => {
    assert({
      given: 'an actor, operation and resource',
      should: 'name the drive context and pass each filter through',
      actual: activityQuery({ range: '30d', actorId: 'a1', operation: 'move', resourceType: 'agent' }, 'd1', NOW).toString(),
      expected: new URLSearchParams({
        context: 'drive',
        driveId: 'd1',
        startDate: '2026-09-12T12:00:00.000Z',
        actorId: 'a1',
        operation: 'move',
        resourceType: 'agent',
      }).toString(),
    });
  });

  test('no drive: the viewer’s own activity across every drive', () => {
    assert({
      given: 'no drive, as on Home (the dashboard)',
      should: 'ask for the user context with no drive',
      actual: activityQuery({ range: '24h', operation: 'create' }, null, NOW).toString(),
      expected: new URLSearchParams({
        context: 'user',
        startDate: '2026-10-11T12:00:00.000Z',
        operation: 'create',
      }).toString(),
    });
  });
});

describe('withActivityFilter', () => {
  test('sets a filter and keeps the others', () => {
    assert({
      given: 'a resource already chosen',
      should: 'add the operation beside it',
      actual: withActivityFilter(new URLSearchParams('resourceType=page'), 'operation', 'create').toString(),
      expected: 'resourceType=page&operation=create',
    });
  });

  test('clears a filter when its value is empty', () => {
    assert({
      given: 'an operation set and cleared',
      should: 'remove that key from the query',
      actual: withActivityFilter(new URLSearchParams('operation=create'), 'operation', undefined).toString(),
      expected: '',
    });
  });
});
