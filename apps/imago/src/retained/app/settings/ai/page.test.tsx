// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '@/ui/test-support/dom';
import AiSettingsPage from './page';

const spies = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), onPrem: { value: false } }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  patch: vi.fn(),
}));
vi.mock('@/retained/lib/deployment-mode', () => ({
  isOnPrem: () => spies.onPrem.value,
  isBillingEnabled: () => false,
  isCloud: () => true,
  isTenantMode: () => false,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix measures its selects with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const PROVIDERS = {
  openai: { isAvailable: true },
  anthropic: { isAvailable: false },
  ollama: { isAvailable: false },
};

const settings = (overrides: Partial<{ providers: Record<string, { isAvailable: boolean }>; isAdmin: boolean }> = {}) => ({
  currentProvider: 'openai',
  currentModel: 'openai/gpt-6-luna',
  userSubscriptionTier: 'pro',
  isAdmin: overrides.isAdmin ?? false,
  imageGenerationModel: null,
  providers: overrides.providers ?? PROVIDERS,
  isAnyProviderConfigured: Object.values(overrides.providers ?? PROVIDERS).some((p) => p.isAvailable),
});

const useSettings = (body: ReturnType<typeof settings>) =>
  spies.fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/api/ai/settings') return Promise.resolve(Response.json(body));
    if (url === '/api/ai/image-models') return Promise.resolve(Response.json({ models: [] }));
    return Promise.resolve(Response.json({}));
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  spies.onPrem.value = false;
  spies.fetchWithAuth.mockReset();
});

afterEach(() => unmountAll());

describe('AiSettingsPage', () => {
  test('shows n of m providers available, with a dot per provider', async () => {
    useSettings(settings());
    const container = mount(<AiSettingsPage />);
    await flush();
    await flush();
    assert({
      given: 'OpenAI available and two other providers not',
      should: "render '1 of 3 available' and a dot for each provider",
      actual: {
        count: container.textContent?.replace(/\s+/g, ' ').includes('1 of 3 available') ?? false,
        dots: container.querySelectorAll('[aria-label="Available"], [aria-label="Unavailable"]').length,
      },
      expected: { count: true, dots: 3 },
    });
  });

  test('renders the chat model select with the saved model', async () => {
    useSettings(settings());
    const container = mount(<AiSettingsPage />);
    await flush();
    await flush();
    const trigger = container.querySelector('[aria-label="Chat model"]');
    assert({
      given: 'a saved OpenAI model',
      should: 'show that model in the Chat model select as Provider · Model',
      actual: trigger?.textContent,
      expected: 'OpenAI · GPT-6 Luna',
    });
  });

  test('shows the unavailable state when no provider is configured', async () => {
    useSettings(settings({ providers: { openai: { isAvailable: false } } }));
    const container = mount(<AiSettingsPage />);
    await flush();
    await flush();
    const text = container.textContent?.replace(/\s+/g, ' ') ?? '';
    assert({
      given: 'no configured provider',
      should: "say 'Unavailable', show '0 of 1 available' and offer no chat model",
      actual: {
        unavailable: text.includes('Unavailable'),
        count: text.includes('0 of 1 available'),
        placeholder: text.includes('No provider available'),
      },
      expected: { unavailable: true, count: true, placeholder: true },
    });
  });

  test('restricts image generation for non-admins', async () => {
    useSettings(settings({ isAdmin: false }));
    const container = mount(<AiSettingsPage />);
    await flush();
    await flush();
    assert({
      given: 'a non-admin viewer',
      should: 'show the image-generation restriction instead of its select',
      actual: container.textContent?.includes('Restricted to app administrators.') ?? false,
      expected: true,
    });
  });

  test('shows the on-prem note only on self-hosted installs', async () => {
    useSettings(settings());
    spies.onPrem.value = true;
    const container = mount(<AiSettingsPage />);
    await flush();
    await flush();
    assert({
      given: 'an on-prem deployment',
      should: 'show the local-providers note',
      actual: container.textContent?.includes('On self-hosted installs only local providers can be used') ?? false,
      expected: true,
    });
  });
});
