// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { BackupRow } from './BackupRow';
import type { SerializedBackup } from './utils';

afterEach(unmountAll);

const backup = (overrides: Partial<SerializedBackup>): SerializedBackup => ({
  id: 'bk-1234567890',
  driveId: 'd1',
  createdAt: new Date().toISOString(),
  createdBy: null,
  source: 'manual',
  status: 'ready',
  label: 'Before launch cleanup',
  reason: null,
  completedAt: null,
  failedAt: null,
  failureReason: null,
  driveName: 'Studio',
  driveSlug: 'studio',
  ...overrides,
});

const noop = () => undefined;

describe('BackupRow', () => {
  test('a ready manual backup shows its drive chip, label, drive, source, status and enabled actions', () => {
    const container = mount(
      <BackupRow backup={backup({})} downloading={false} anyDownloading={false} onView={noop} onDownload={noop} onRestore={noop} />,
    );
    assert({
      given: 'a ready manual backup on the Studio drive',
      should: 'show the label, the drive with the Manual and ready pills, and enable View, Download and Restore',
      actual: {
        chip: container.querySelector('[aria-hidden="true"]')?.textContent,
        label: container.textContent?.includes('Before launch cleanup'),
        drive: container.textContent?.includes('Studio ·'),
        pills: [...container.querySelectorAll('span')].map((node) => node.textContent).filter((text) => text === 'Manual' || text === 'ready'),
        disabled: [...container.querySelectorAll('button')].map((node) => node.disabled),
        labels: [...container.querySelectorAll('button')].map((node) => node.getAttribute('aria-label')),
      },
      expected: {
        chip: 'S',
        label: true,
        drive: true,
        pills: ['Manual', 'ready'],
        disabled: [false, false, false],
        labels: ['View snapshot', 'Download', 'Restore drive to this backup'],
      },
    });
  });

  test('a pending or failed backup keeps its three actions disabled', () => {
    const container = mount(
      <BackupRow backup={backup({ status: 'pending', source: 'pre_restore' })} downloading={false} anyDownloading={false} onView={noop} onDownload={noop} onRestore={noop} />,
    );
    assert({
      given: 'a pending safety snapshot',
      should: 'label it Safety snapshot and disable View, Download and Restore',
      actual: {
        pills: container.textContent?.includes('Safety snapshot') && container.textContent?.includes('pending'),
        disabled: [...container.querySelectorAll('button')].map((node) => node.disabled),
      },
      expected: { pills: true, disabled: [true, true, true] },
    });
  });

  test('a ready row fires its handler and renders children (the restore preview) under the row', () => {
    const onRestore = vi.fn();
    const container = mount(
      <BackupRow backup={backup({})} downloading={false} anyDownloading={false} onView={noop} onDownload={noop} onRestore={onRestore}>
        <div role="region" aria-label="Restore preview">preview</div>
      </BackupRow>,
    );
    click(container.querySelector<HTMLButtonElement>('button[aria-label="Restore drive to this backup"]')!);
    expect(onRestore).toHaveBeenCalledTimes(1);
    assert({
      given: 'a restore target row with its preview',
      should: 'render the Restore preview region inside the row',
      actual: container.querySelector('[role="region"][aria-label="Restore preview"]') !== null,
      expected: true,
    });
  });
});
