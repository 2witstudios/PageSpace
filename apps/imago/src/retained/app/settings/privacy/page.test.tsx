// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import PrivacySettingsPage from './page';

const spies = vi.hoisted(() => ({
  saveCustom: vi.fn(),
  rejectNonEssential: vi.fn(),
  native: { isNative: false },
  consent: {
    categories: { analytics: false, preferences: true },
    decidedAt: null as number | null,
  },
}));

vi.mock('@/retained/hooks/useCapacitor', () => ({ useCapacitor: () => spies.native }));
vi.mock('@/retained/stores/useConsentStore', () => ({
  useConsentStore: <T,>(selector: (s: unknown) => T): T =>
    selector({
      hydrate: vi.fn(),
      state: spies.consent,
      saveCustom: spies.saveCustom,
      rejectNonEssential: spies.rejectNonEssential,
    }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix measures its switches with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const switchFor = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);

afterEach(() => {
  unmountAll();
  spies.native.isNative = false;
  spies.consent.categories = { analytics: false, preferences: true };
  spies.saveCustom.mockReset();
});

describe('PrivacySettingsPage', () => {
  test('renders the three cookie switches, with strictly necessary disabled', () => {
    const container = mount(<PrivacySettingsPage />);
    assert({
      given: 'the privacy route on web',
      should: 'render the strictly necessary, analytics and preference switches',
      actual: {
        necessary: switchFor(container, 'Strictly necessary cookies')?.getAttribute('aria-disabled'),
        analytics: switchFor(container, 'Analytics cookies')?.getAttribute('aria-checked'),
        preferences: switchFor(container, 'Preference cookies')?.getAttribute('aria-checked'),
      },
      expected: { necessary: 'true', analytics: 'false', preferences: 'true' },
    });
  });

  test('links Profile and Personalization from Your data, and the policy pages', () => {
    const container = mount(<PrivacySettingsPage />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    assert({
      given: 'the Your data rows and the legal sentence',
      should: 'link Profile, Personalization, the Privacy Policy and the Terms of Service',
      actual: ['/account/account', '/account/personalization', '/privacy', '/terms'].map((href) => hrefs.includes(href)),
      expected: [true, true, true, true],
    });
  });

  test('saves the analytics switch as the user set it', () => {
    const container = mount(<PrivacySettingsPage />);
    click(switchFor(container, 'Analytics cookies')!);
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save preferences')!;
    click(save);
    assert({
      given: 'analytics switched on and Save preferences pressed',
      should: 'save both optional categories',
      actual: spies.saveCustom.mock.calls[0]?.[0],
      expected: { analytics: true, preferences: true },
    });
  });

  test('shows analytics on when the stored consent has it on', () => {
    spies.consent.categories = { analytics: true, preferences: false };
    const container = mount(<PrivacySettingsPage />);
    assert({
      given: 'a stored consent with analytics on',
      should: 'seed the analytics switch on',
      actual: switchFor(container, 'Analytics cookies')?.getAttribute('aria-checked'),
      expected: 'true',
    });
  });

  test('renders nothing on a native app', () => {
    spies.native.isNative = true;
    const container = mount(<PrivacySettingsPage />);
    assert({
      given: 'the privacy route in a native app',
      should: 'hide the page (classic nativeHidden)',
      actual: container.innerHTML,
      expected: '',
    });
  });
});
