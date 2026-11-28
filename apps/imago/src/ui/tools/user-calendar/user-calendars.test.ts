import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { getDriveCalendarColor } from '@/retained/components/calendar/calendar-types';
import { userCalendars } from './user-calendars';

describe('userCalendars()', () => {
  test('Personal, then every drive in its grid colour', () => {
    const drives = [{ id: 'd1', name: 'Studio' }, { id: 'd2', name: 'Ops' }];
    assert({
      given: 'two drives',
      should: 'list Personal first, then each drive, coloured as the grid colours its events',
      actual: userCalendars(drives),
      expected: [
        { key: 'personal', name: 'Personal', dotClass: getDriveCalendarColor(null, ['d1', 'd2']).dot },
        { key: 'd1', name: 'Studio', dotClass: getDriveCalendarColor('d1', ['d1', 'd2']).dot },
        { key: 'd2', name: 'Ops', dotClass: getDriveCalendarColor('d2', ['d1', 'd2']).dot },
      ],
    });
  });
});
