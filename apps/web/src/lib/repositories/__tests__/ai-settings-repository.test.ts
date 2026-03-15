/**
 * Tests for ai-settings-repository.ts
 * Repository for AI settings-related user operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSelectFrom = vi.hoisted(() => vi.fn());
const mockSelectWhere = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
  users: {
    id: 'id',
    currentAiProvider: 'currentAiProvider',
    currentAiModel: 'currentAiModel',
    subscriptionTier: 'subscriptionTier',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
}));

import { aiSettingsRepository } from '../ai-settings-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
});

// ---------------------------------------------------------------------------
// getUserSettings
// ---------------------------------------------------------------------------

describe('aiSettingsRepository.getUserSettings', () => {
  it('should return user settings when found', async () => {
    const userRecord = {
      id: 'user-1',
      currentAiProvider: 'anthropic',
      currentAiModel: 'claude-3-5-sonnet',
      subscriptionTier: 'pro',
    };
    mockSelectWhere.mockResolvedValue([userRecord]);

    const result = await aiSettingsRepository.getUserSettings('user-1');
    expect(result).toEqual(userRecord);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should return null when user not found', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const result = await aiSettingsRepository.getUserSettings('nonexistent');
    expect(result).toBeNull();
  });

  it('should select only the relevant AI columns', async () => {
    mockSelectWhere.mockResolvedValue([{
      id: 'user-1',
      currentAiProvider: null,
      currentAiModel: null,
      subscriptionTier: null,
    }]);
    const result = await aiSettingsRepository.getUserSettings('user-1');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('user-1');
  });

  it('should handle user with null provider and model', async () => {
    mockSelectWhere.mockResolvedValue([{
      id: 'user-2',
      currentAiProvider: null,
      currentAiModel: null,
      subscriptionTier: null,
    }]);
    const result = await aiSettingsRepository.getUserSettings('user-2');
    expect(result?.currentAiProvider).toBeNull();
    expect(result?.currentAiModel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateProviderSettings
// ---------------------------------------------------------------------------

describe('aiSettingsRepository.updateProviderSettings', () => {
  it('should update provider and model when both are provided', async () => {
    await aiSettingsRepository.updateProviderSettings('user-1', {
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAiProvider: 'openai',
        currentAiModel: 'gpt-4o',
      })
    );
  });

  it('should update only provider when model is not provided', async () => {
    await aiSettingsRepository.updateProviderSettings('user-1', {
      provider: 'ollama',
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ currentAiProvider: 'ollama' })
    );
    // model should NOT be in the update object
    const callArg = mockUpdateSet.mock.calls[0][0];
    expect(callArg.currentAiModel).toBeUndefined();
  });

  it('should update model when model is an empty string (falsy - skipped)', async () => {
    // Empty string is falsy, so model should NOT be included
    await aiSettingsRepository.updateProviderSettings('user-1', {
      provider: 'lmstudio',
      model: '',
    });

    const callArg = mockUpdateSet.mock.calls[0][0];
    expect(callArg.currentAiModel).toBeUndefined();
  });

  it('should call where with userId eq condition', async () => {
    await aiSettingsRepository.updateProviderSettings('user-5', {
      provider: 'anthropic',
      model: 'claude-opus',
    });

    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});
