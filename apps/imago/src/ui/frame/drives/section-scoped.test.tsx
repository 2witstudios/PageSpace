// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { HomeDriveProvider } from './home-drive-context';
import { SectionScoped } from './section-scoped';
import { setSectionScope } from './use-section-scope';

afterEach(unmountAll);

const at = (driveId: string, homeDriveId: string | null) =>
  mount(
    <HomeDriveProvider value={homeDriveId}>
      <SectionScoped section="calendar" driveId={driveId} all={<p>every drive</p>} drive={<p>this drive</p>} />
    </HomeDriveProvider>,
  );

describe('SectionScoped', () => {
  test('no choice yet: Home, another drive, and no Home yet', () => {
    assert({
      given: 'the viewer’s Home, another drive, and a viewer with no Home drive',
      should: 'render the every-drive middle only on Home',
      actual: [at('home', 'home').textContent, at('d1', 'home').textContent, at('d1', null).textContent],
      expected: ['every drive', 'this drive', 'this drive'],
    });
  });

  test('the section switched', () => {
    const home = at('home', 'home');
    const other = at('d1', 'home');
    act(() => setSectionScope('calendar', 'drive'));
    const toDrive = [home.textContent, other.textContent];
    act(() => setSectionScope('calendar', 'all'));
    assert({
      given: 'Calendar switched to this drive, then to All drives, while mounted',
      should: 'follow the switch on every drive',
      actual: { toDrive, toAll: [home.textContent, other.textContent] },
      expected: { toDrive: ['this drive', 'this drive'], toAll: ['every drive', 'every drive'] },
    });
  });
});
