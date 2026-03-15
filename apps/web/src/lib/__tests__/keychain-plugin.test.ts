import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the stub is available before vi.mock hoisting executes
const mockStub = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => mockStub),
}));

import { registerPlugin } from '@capacitor/core';
import { PageSpaceKeychain } from '../keychain-plugin';

describe('keychain-plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('module registration', () => {
    it('exports PageSpaceKeychain as the registered plugin instance', () => {
      // The plugin is the object returned by registerPlugin at module init time
      expect(PageSpaceKeychain).toBeDefined();
      expect(typeof PageSpaceKeychain.get).toBe('function');
      expect(typeof PageSpaceKeychain.set).toBe('function');
      expect(typeof PageSpaceKeychain.remove).toBe('function');
    });

    it('the exported plugin is the same object returned by registerPlugin', () => {
      // PageSpaceKeychain should be the stub that registerPlugin returned
      expect(PageSpaceKeychain).toBe(mockStub);
    });
  });

  describe('PageSpaceKeychainPlugin interface methods', () => {
    it('exposes a get method', () => {
      expect(typeof PageSpaceKeychain.get).toBe('function');
    });

    it('exposes a set method', () => {
      expect(typeof PageSpaceKeychain.set).toBe('function');
    });

    it('exposes a remove method', () => {
      expect(typeof PageSpaceKeychain.remove).toBe('function');
    });

    describe('get', () => {
      it('calls get with the correct key option and returns the value', async () => {
        mockStub.get.mockResolvedValue({ value: 'stored-value' });

        const result = await PageSpaceKeychain.get({ key: 'my_key' });
        expect(mockStub.get).toHaveBeenCalledWith({ key: 'my_key' });
        expect(result).toEqual({ value: 'stored-value' });
      });

      it('returns null value when key does not exist', async () => {
        mockStub.get.mockResolvedValue({ value: null });

        const result = await PageSpaceKeychain.get({ key: 'missing_key' });
        expect(result).toEqual({ value: null });
      });

      it('propagates rejection from the underlying plugin', async () => {
        mockStub.get.mockRejectedValue(new Error('Keychain unavailable'));

        await expect(PageSpaceKeychain.get({ key: 'any_key' })).rejects.toThrow(
          'Keychain unavailable'
        );
      });
    });

    describe('set', () => {
      it('calls set with the correct key and value options', async () => {
        mockStub.set.mockResolvedValue({ success: true });

        const result = await PageSpaceKeychain.set({ key: 'my_key', value: 'my_value' });
        expect(mockStub.set).toHaveBeenCalledWith({
          key: 'my_key',
          value: 'my_value',
        });
        expect(result).toEqual({ success: true });
      });

      it('returns success false on failure', async () => {
        mockStub.set.mockResolvedValue({ success: false });

        const result = await PageSpaceKeychain.set({ key: 'my_key', value: 'my_value' });
        expect(result).toEqual({ success: false });
      });

      it('propagates rejection from the underlying plugin', async () => {
        mockStub.set.mockRejectedValue(new Error('Write failed'));

        await expect(
          PageSpaceKeychain.set({ key: 'my_key', value: 'my_value' })
        ).rejects.toThrow('Write failed');
      });
    });

    describe('remove', () => {
      it('calls remove with the correct key option', async () => {
        mockStub.remove.mockResolvedValue({ success: true });

        const result = await PageSpaceKeychain.remove({ key: 'my_key' });
        expect(mockStub.remove).toHaveBeenCalledWith({ key: 'my_key' });
        expect(result).toEqual({ success: true });
      });

      it('returns success false when key not found', async () => {
        mockStub.remove.mockResolvedValue({ success: false });

        const result = await PageSpaceKeychain.remove({ key: 'missing_key' });
        expect(result).toEqual({ success: false });
      });

      it('propagates rejection from the underlying plugin', async () => {
        mockStub.remove.mockRejectedValue(new Error('Delete failed'));

        await expect(PageSpaceKeychain.remove({ key: 'my_key' })).rejects.toThrow(
          'Delete failed'
        );
      });
    });
  });
});
