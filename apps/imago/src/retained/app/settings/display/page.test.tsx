// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import DisplaySettingsPage from './page';
import { useDisplayPreferences } from '@/retained/hooks/useDisplayPreferences';
import { useThemePreference } from '@/lib/theme/theme-provider';
import type { ThemePreference } from '@/lib/theme/theme-preference';

vi.mock('@/retained/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isLoading: false }),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: vi.fn(),
}));

vi.mock('@/lib/theme/theme-provider', () => ({
  useThemePreference: vi.fn(),
}));

const displayMock = vi.mocked(useDisplayPreferences);
const themeMock = vi.mocked(useThemePreference);

type Prefs = { showTokenCounts: boolean; showCodeToggle: boolean; defaultMarkdownMode: boolean };

const setup = ({
  prefs = { showTokenCounts: true, showCodeToggle: false, defaultMarkdownMode: false },
  theme = 'system',
}: { prefs?: Prefs; theme?: ThemePreference } = {}) => {
  const updatePreference = vi.fn(async () => undefined);
  const selectPreference = vi.fn();
  displayMock.mockReturnValue({
    preferences: prefs,
    isLoading: false,
    error: undefined,
    updatePreference,
  } as unknown as ReturnType<typeof useDisplayPreferences>);
  themeMock.mockReturnValue({ preference: theme, selectPreference });
  const view = render(<DisplaySettingsPage />);
  return { ...view, updatePreference, selectPreference };
};

describe('DisplaySettingsPage (/account/display)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders one h1, the board lede and no Back to Settings button', () => {
    setup();
    const header = screen.getByRole('heading', { level: 1 });
    expect(header.textContent).toBe('Display & pages');
    expect(screen.queryByRole('button', { name: /back to settings/i })).toBeNull();
    expect(document.querySelector('header p')?.textContent).toBe(
      'Optional interface elements, and how new pages start out.',
    );
  });

  test('keeps the saved-to-account claim off the theme', () => {
    setup();
    const appearance = screen.getByRole('region', { name: 'Appearance' });
    expect(appearance.textContent?.toLowerCase()).not.toContain('saved to your account');
    const interfaceSection = screen.getByRole('region', { name: 'Interface' });
    expect(interfaceSection.textContent).toContain('Saved to your account, so every device follows.');
  });

  test.each([
    ['System', 'system'],
    ['Light', 'light'],
    ['Dark', 'dark'],
  ] as const)('theme radio %s is checked when the preference is %s', (label, preference) => {
    setup({ theme: preference });
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    const radio = within(group).getByRole('radio', { name: label }) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    const others = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(others.filter((r) => r.checked)).toHaveLength(1);
  });

  test('choosing a theme calls selectPreference with that theme', () => {
    const { selectPreference } = setup({ theme: 'system' });
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(selectPreference).toHaveBeenCalledWith('dark');
  });

  test('renders the three board switches with their board labels', () => {
    setup();
    expect(screen.getByRole('switch', { name: 'Show AI token counts' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show Rich / Code view toggle' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Save new documents as Markdown' })).toBeTruthy();
  });

  test.each([
    ['Show AI token counts', 'SHOW_TOKEN_COUNTS', true],
    ['Show Rich / Code view toggle', 'SHOW_CODE_TOGGLE', false],
    ['Save new documents as Markdown', 'DEFAULT_MARKDOWN_MODE', false],
  ] as const)('switch "%s" reflects its stored value and persists %s on toggle', async (label, id, current) => {
    const { updatePreference } = setup({
      prefs: { showTokenCounts: true, showCodeToggle: false, defaultMarkdownMode: false },
    });
    const sw = screen.getByRole('switch', { name: label });
    expect(sw.getAttribute('aria-checked')).toBe(String(current));
    fireEvent.click(sw);
    await Promise.resolve();
    expect(updatePreference).toHaveBeenCalledWith(id, !current);
  });

  test('a switch that is on renders as checked', () => {
    setup({ prefs: { showTokenCounts: false, showCodeToggle: true, defaultMarkdownMode: true } });
    expect(screen.getByRole('switch', { name: 'Show Rich / Code view toggle' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Save new documents as Markdown' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Show AI token counts' }).getAttribute('aria-checked')).toBe('false');
  });
});
