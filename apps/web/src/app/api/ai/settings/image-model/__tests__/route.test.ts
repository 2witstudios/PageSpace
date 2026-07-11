import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/ai-settings-repository', () => ({
  aiSettingsRepository: {
    getUserSettings: vi.fn(),
    updateImageGenerationModel: vi.fn(async () => {}),
  },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));
vi.mock('@/lib/ai/core/model-capabilities', () => ({
  fetchOpenRouterImageModels: vi.fn(async () => [{ id: 'google/gemini-3.1-flash-image-preview', displayName: 'G' }]),
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: vi.fn(() => false) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })) } },
}));

import { PATCH } from '../route';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const asMock = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

function req(body: unknown) {
  return new Request('http://x/api/ai/settings/image-model', { method: 'PATCH', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(isAuthError).mockReturnValue(false);
  asMock(authenticateRequestWithOptions).mockResolvedValue({ userId: 'u1', role: 'user' });
});

describe('PATCH /api/ai/settings/image-model', () => {
  it('persists a valid model for a Pro user', async () => {
    asMock(aiSettingsRepository.getUserSettings).mockResolvedValue({ id: 'u1', subscriptionTier: 'pro', imageGenerationModel: null });
    const res = await PATCH(req({ imageGenerationModel: 'google/gemini-3.1-flash-image-preview' }));
    expect(res.status).toBe(200);
    expect(asMock(aiSettingsRepository.updateImageGenerationModel)).toHaveBeenCalledWith('u1', 'google/gemini-3.1-flash-image-preview');
  });

  it('rejects a free user with 403', async () => {
    asMock(aiSettingsRepository.getUserSettings).mockResolvedValue({ id: 'u1', subscriptionTier: 'free', imageGenerationModel: null });
    const res = await PATCH(req({ imageGenerationModel: 'google/gemini-3.1-flash-image-preview' }));
    expect(res.status).toBe(403);
    expect(asMock(aiSettingsRepository.updateImageGenerationModel)).not.toHaveBeenCalled();
  });

  it('rejects an unknown model with 400', async () => {
    asMock(aiSettingsRepository.getUserSettings).mockResolvedValue({ id: 'u1', subscriptionTier: 'pro', imageGenerationModel: null });
    const res = await PATCH(req({ imageGenerationModel: 'made/up-model' }));
    expect(res.status).toBe(400);
  });

  it('allows clearing with null', async () => {
    asMock(aiSettingsRepository.getUserSettings).mockResolvedValue({ id: 'u1', subscriptionTier: 'pro', imageGenerationModel: 'x' });
    const res = await PATCH(req({ imageGenerationModel: null }));
    expect(res.status).toBe(200);
    expect(asMock(aiSettingsRepository.updateImageGenerationModel)).toHaveBeenCalledWith('u1', null);
  });
});
