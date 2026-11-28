// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { HOTKEY_REGISTRY } from '@/retained/lib/hotkeys/registry';
import { useHotkeyStore } from '@/retained/stores/useHotkeyStore';
import HotkeysSettingsPage from './page';

const spies = vi.hoisted(() => ({
  deleteHotkeyPreference: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@/retained/hooks/useHotkeyPreferences', () => ({
  useHotkeyPreferences: () => ({ preferences: [], isLoading: false, mutate: spies.mutate }),
  updateHotkeyPreference: vi.fn(),
  deleteHotkeyPreference: spies.deleteHotkeyPreference,
  fetchHotkeyPreferences: vi.fn(async () => []),
  unusablePreferences: () => [],
}));
vi.mock('@/retained/hooks/useIsMac', () => ({ useIsMac: () => false }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const labelOf = (id: string): string => HOTKEY_REGISTRY.find((h) => h.id === id)!.label;
const keyButton = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="Change shortcut for ${label}"]`);

beforeEach(() => {
  spies.deleteHotkeyPreference.mockReset().mockResolvedValue(true);
  spies.mutate.mockReset().mockResolvedValue(undefined);
  useHotkeyStore.setState({ userBindings: new Map([[HOTKEY_REGISTRY[0].id, 'Meta+Shift+K']]) });
});

afterEach(() => {
  unmountAll();
  useHotkeyStore.setState({ userBindings: new Map() });
});

describe('HotkeysSettingsPage', () => {
  test('renders categories whose key buttons are labelled for each shortcut', () => {
    const container = mount(<HotkeysSettingsPage />);
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    assert({
      given: 'the hotkey registry and no filter',
      should: 'render a section heading for each category that has shortcuts, and none for an empty one',
      actual: headings,
      expected: ['Navigation', 'Tabs', 'Editing'],
    });
    assert({
      given: 'a registry shortcut',
      should: "label its key button 'Change shortcut for {label}'",
      actual: keyButton(container, labelOf(HOTKEY_REGISTRY[0].id)) !== null,
      expected: true,
    });
  });

  test('highlights a custom binding and offers Reset to the default', () => {
    const container = mount(<HotkeysSettingsPage />);
    const custom = keyButton(container, labelOf(HOTKEY_REGISTRY[0].id));
    const resetButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('Reset to'));
    assert({
      given: 'one shortcut with a custom binding',
      should: "show exactly one 'Reset to {default}' action and highlight the custom key button",
      actual: {
        resets: resetButtons.length,
        highlighted: custom?.className.includes('text-primary') ?? false,
      },
      expected: { resets: 1, highlighted: true },
    });
  });

  test('filters rows by the Filter shortcuts input', () => {
    const container = mount(<HotkeysSettingsPage />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]')!;
    typeInto(input, 'zzz-no-match');
    assert({
      given: 'a filter that matches no shortcut',
      should: 'show the empty-match message and no key buttons',
      actual: {
        keyButtons: container.querySelectorAll('button[aria-label^="Change shortcut for"]').length,
        message: container.textContent?.includes('No shortcuts match') ?? false,
      },
      expected: { keyButtons: 0, message: true },
    });
  });

  test('Reset all deletes every customised binding', async () => {
    const container = mount(<HotkeysSettingsPage />);
    const resetAll = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reset all')!;
    click(resetAll);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert({
      given: 'one customised binding and Reset all pressed',
      should: 'delete that binding',
      actual: spies.deleteHotkeyPreference.mock.calls.map((call) => call[0]),
      expected: [HOTKEY_REGISTRY[0].id],
    });
  });

  test('recording: pressing a key button swaps that row for the key input', () => {
    const container = mount(<HotkeysSettingsPage />);
    const label = labelOf(HOTKEY_REGISTRY[0].id);
    click(keyButton(container, label)!);
    assert({
      given: 'a key button pressed to record a new shortcut',
      should: 'replace that key button with the recording input',
      actual: keyButton(container, label),
      expected: null,
    });
  });
});
