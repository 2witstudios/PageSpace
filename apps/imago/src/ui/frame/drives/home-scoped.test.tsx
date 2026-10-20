// @vitest-environment jsdom
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { HomeDriveProvider } from './home-drive-context';
import { HomeScoped } from './home-scoped';

afterEach(unmountAll);

const at = (driveId: string, homeDriveId: string | null) =>
  mount(
    <HomeDriveProvider value={homeDriveId}>
      <HomeScoped driveId={driveId} home={<p>every drive</p>} drive={<p>this drive</p>} />
    </HomeDriveProvider>,
  ).textContent;

describe('HomeScoped', () => {
  test('Home, another drive, and no Home yet', () => {
    assert({
      given: 'the viewer’s Home, another drive, and a viewer with no Home drive',
      should: 'render the every-drive middle only on Home',
      actual: [at('home', 'home'), at('d1', 'home'), at('d1', null)],
      expected: ['every drive', 'this drive', 'this drive'],
    });
  });
});
