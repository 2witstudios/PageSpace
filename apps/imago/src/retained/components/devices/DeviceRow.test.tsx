// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll, click } from '@/ui/test-support/dom';
import type { Device } from '@/retained/hooks/useDevices';
import { DeviceRow } from './DeviceRow';

afterEach(unmountAll);

const device = (overrides: Partial<Device>): Device => ({
  id: 'd1',
  platform: 'web',
  deviceName: 'Chrome on macOS',
  deviceId: 'device-0123456789abcdef',
  lastUsedAt: new Date().toISOString(),
  trustScore: 0.9,
  suspiciousActivityCount: 0,
  ipAddress: null,
  lastIpAddress: null,
  location: 'San Francisco',
  userAgent: null,
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-04-01T00:00:00Z',
  isCurrent: false,
  ...overrides,
});

const spansWithText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('span')].filter((s) => s.textContent === text).length;

describe('DeviceRow', () => {
  test('marks the current device with a "This device" badge and no Revoke button', () => {
    const container = mount(<DeviceRow device={device({ isCurrent: true })} onRevoke={vi.fn()} />);
    assert({
      given: 'the device the session is running on',
      should: 'show a "This device" badge and offer no revoke control for it',
      actual: {
        badges: spansWithText(container, 'This device'),
        revoke: container.querySelector('button[aria-label^="Revoke"]'),
      },
      expected: { badges: 1, revoke: null },
    });
  });

  test('labels the revoke button with the device name for other devices', () => {
    const onRevoke = vi.fn();
    const other = device({ id: 'd2', deviceName: 'Windows laptop', platform: 'desktop', isCurrent: false });
    const container = mount(<DeviceRow device={other} onRevoke={onRevoke} />);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Windows laptop"]');
    assert({
      given: 'a signed-in device that is not the current one',
      should: 'show a "Revoke <name>" button and no "This device" badge',
      actual: {
        buttonText: button?.textContent,
        badges: spansWithText(container, 'This device'),
      },
      expected: { buttonText: 'Revoke', badges: 0 },
    });
    if (button) click(button);
    assert({
      given: 'the revoke button for that device',
      should: 'hand that device to onRevoke',
      actual: onRevoke.mock.calls[0]?.[0]?.id,
      expected: 'd2',
    });
  });

  test('falls back to "Unknown <platform>" when the device has no name', () => {
    const container = mount(<DeviceRow device={device({ deviceName: null, platform: 'ios' })} onRevoke={vi.fn()} />);
    assert({
      given: 'an iOS device without a name',
      should: 'label the row "Unknown iOS" and its revoke button with the same name',
      actual: {
        name: container.querySelector('span.truncate')?.textContent,
        revoke: container.querySelector('button[aria-label="Revoke Unknown iOS"]') !== null,
      },
      expected: { name: 'Unknown iOS', revoke: true },
    });
  });

  test('shows a trust badge that matches the trust score', () => {
    const trusted = mount(<DeviceRow device={device({ trustScore: 0.9 })} onRevoke={vi.fn()} />);
    const suspicious = mount(<DeviceRow device={device({ trustScore: 0.1 })} onRevoke={vi.fn()} />);
    assert({
      given: 'a trust score of 0.9 and one of 0.1',
      should: 'label them "Trusted" and "Suspicious"',
      actual: {
        trusted: trusted.textContent?.includes('Trusted'),
        suspicious: suspicious.textContent?.includes('Suspicious'),
      },
      expected: { trusted: true, suspicious: true },
    });
  });
});
