// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { DRIVE_READONLY_NOTICE } from '@/retained/lib/commands/command-form-core';
import DriveCommandsSettingsPage from './page';

const drive = vi.hoisted(() => ({ current: { id: 'd1', name: 'Studio', isOwned: true, role: 'MEMBER' } as Record<string, unknown> }));

vi.mock('@/retained-adapters/navigation', () => ({ useParams: () => ({ driveId: 'd1' }) }));
vi.mock('@/retained/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, isLoading: false }) }));
vi.mock('@/retained/hooks/useDrive', () => ({
  useDriveStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ drives: [drive.current], isLoading: false, fetchDrives: () => undefined }),
}));
vi.mock('@/retained/components/commands/CommandsSettings', () => ({
  CommandsSettings: () => <div data-testid="commands-list">list</div>,
}));

afterEach(unmountAll);

describe('Drive Commands settings page', () => {
  test('shows the read-only notice to a member who cannot manage commands', () => {
    drive.current = { id: 'd1', name: 'Studio', isOwned: false, role: 'MEMBER' };
    const container = mount(<DriveCommandsSettingsPage />);
    assert({
      given: 'a plain member of the drive',
      should: 'show the drive read-only notice above the list and no Back button',
      actual: {
        notice: container.textContent?.includes(DRIVE_READONLY_NOTICE),
        back: container.textContent?.includes('Back to Settings'),
        heading: container.querySelector('h1')?.textContent,
      },
      expected: { notice: true, back: false, heading: 'Commands' },
    });
  });

  test('omits the read-only notice for the drive owner', () => {
    drive.current = { id: 'd1', name: 'Studio', isOwned: true, role: 'ADMIN' };
    const container = mount(<DriveCommandsSettingsPage />);
    assert({
      given: 'the drive owner',
      should: 'not show the read-only notice',
      actual: container.textContent?.includes(DRIVE_READONLY_NOTICE),
      expected: false,
    });
  });
});
