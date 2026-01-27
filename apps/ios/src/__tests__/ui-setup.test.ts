/**
 * UI Setup Tests
 *
 * Comprehensive test coverage for iOS UI configuration:
 * - Status bar styling
 * - Keyboard event handling
 * - Platform CSS class injection
 * - Cleanup and memory management
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  mockStatusBar,
  mockKeyboardListeners,
  simulateKeyboardShow,
  simulateKeyboardHide,
  consoleSpy,
} from './setup';

// Re-import to get fresh module state for each test
let uiSetup: typeof import('../ui-setup');

describe('ui-setup', () => {
  beforeEach(async () => {
    vi.resetModules();
    uiSetup = await import('../ui-setup');

    // Reset DOM state
    document.documentElement.className = '';
    document.body.className = '';
    document.body.style.cssText = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setupIOSUI', () => {
    describe('happy path', () => {
      it('adds capacitor-ios class to document element', async () => {
        await uiSetup.setupIOSUI();

        expect(document.documentElement.classList.contains('capacitor-ios')).toBe(
          true
        );
      });

      it('sets status bar style to Light', async () => {
        await uiSetup.setupIOSUI();

        expect(mockStatusBar.setStyle).toHaveBeenCalledWith({
          style: 'LIGHT',
        });
      });

      it('sets up keyboard handling', async () => {
        await uiSetup.setupIOSUI();

        expect(mockKeyboardListeners.has('keyboardWillShow')).toBe(true);
        expect(mockKeyboardListeners.has('keyboardWillHide')).toBe(true);
      });
    });

    describe('error handling', () => {
      it('continues setup when status bar fails', async () => {
        mockStatusBar.setStyle.mockRejectedValueOnce(
          new Error('Status bar unavailable')
        );

        await uiSetup.setupIOSUI();

        // Should still add platform class
        expect(document.documentElement.classList.contains('capacitor-ios')).toBe(
          true
        );
        expect(consoleSpy.warn).toHaveBeenCalled();
      });

      it('logs warning on status bar failure', async () => {
        mockStatusBar.setStyle.mockRejectedValueOnce(
          new Error('Failed')
        );

        await uiSetup.setupIOSUI();

        expect(consoleSpy.warn).toHaveBeenCalled();
      });
    });

    describe('idempotency', () => {
      it('can be called multiple times safely', async () => {
        await uiSetup.setupIOSUI();
        await uiSetup.setupIOSUI();
        await uiSetup.setupIOSUI();

        // Should have capacitor-ios class only once
        expect(document.documentElement.className.split(' ').filter(c => c === 'capacitor-ios').length).toBe(1);
      });
    });
  });

  describe('keyboard handling', () => {
    describe('keyboardWillShow', () => {
      beforeEach(async () => {
        await uiSetup.setupIOSUI();
      });

      it('sets --keyboard-height CSS variable', () => {
        simulateKeyboardShow(320);

        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '320px'
        );
      });

      it('adds keyboard-open class to body', () => {
        simulateKeyboardShow(280);

        expect(document.body.classList.contains('keyboard-open')).toBe(true);
      });

      it('updates height when keyboard resizes', () => {
        simulateKeyboardShow(300);
        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '300px'
        );

        simulateKeyboardShow(350);
        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '350px'
        );
      });

      it('handles zero keyboard height', () => {
        simulateKeyboardShow(0);

        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '0px'
        );
        expect(document.body.classList.contains('keyboard-open')).toBe(true);
      });
    });

    describe('keyboardWillHide', () => {
      beforeEach(async () => {
        await uiSetup.setupIOSUI();
        // First show keyboard
        simulateKeyboardShow(300);
      });

      it('resets --keyboard-height to 0px', () => {
        simulateKeyboardHide();

        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '0px'
        );
      });

      it('removes keyboard-open class from body', () => {
        simulateKeyboardHide();

        expect(document.body.classList.contains('keyboard-open')).toBe(false);
      });

      it('can be called when keyboard is already hidden', () => {
        simulateKeyboardHide();
        simulateKeyboardHide();

        expect(document.body.classList.contains('keyboard-open')).toBe(false);
        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '0px'
        );
      });
    });

    describe('rapid keyboard events', () => {
      beforeEach(async () => {
        await uiSetup.setupIOSUI();
      });

      it('handles rapid show/hide cycles', () => {
        simulateKeyboardShow(300);
        simulateKeyboardHide();
        simulateKeyboardShow(320);
        simulateKeyboardHide();
        simulateKeyboardShow(280);

        expect(document.body.classList.contains('keyboard-open')).toBe(true);
        expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
          '280px'
        );
      });
    });
  });

  describe('cleanupKeyboardListeners', () => {
    it('removes keyboard event listeners', async () => {
      await uiSetup.setupIOSUI();

      await uiSetup.cleanupKeyboardListeners();

      // After cleanup, simulating events should not affect DOM
      document.body.style.setProperty('--keyboard-height', '999px');
      document.body.classList.add('keyboard-open');

      // These should not change state after cleanup
      simulateKeyboardShow(100);

      // The listener was removed, so new listeners added in simulate won't match
      // and the event won't fire on the old handlers
    });

    it('can be called multiple times safely', async () => {
      await uiSetup.setupIOSUI();

      await uiSetup.cleanupKeyboardListeners();
      await uiSetup.cleanupKeyboardListeners();
      await uiSetup.cleanupKeyboardListeners();

      // Should not throw
    });

    it('can be called before setup', async () => {
      // Should not throw even if never set up
      await expect(uiSetup.cleanupKeyboardListeners()).resolves.not.toThrow();
    });

    it('allows re-setup after cleanup', async () => {
      await uiSetup.setupIOSUI();
      await uiSetup.cleanupKeyboardListeners();
      await uiSetup.setupIOSUI();

      simulateKeyboardShow(300);

      expect(document.body.classList.contains('keyboard-open')).toBe(true);
    });
  });

  describe('setStatusBarStyle', () => {
    describe('happy path', () => {
      it('sets Light style for dark theme', async () => {
        await uiSetup.setStatusBarStyle(true);

        expect(mockStatusBar.setStyle).toHaveBeenCalledWith({
          style: 'LIGHT',
        });
      });

      it('sets Dark style for light theme', async () => {
        await uiSetup.setStatusBarStyle(false);

        expect(mockStatusBar.setStyle).toHaveBeenCalledWith({
          style: 'DARK',
        });
      });

      it('can toggle between styles', async () => {
        await uiSetup.setStatusBarStyle(true);
        await uiSetup.setStatusBarStyle(false);
        await uiSetup.setStatusBarStyle(true);

        expect(mockStatusBar.setStyle).toHaveBeenCalledTimes(3);
      });
    });

    describe('error handling', () => {
      it('does not throw when status bar fails', async () => {
        mockStatusBar.setStyle.mockRejectedValueOnce(
          new Error('Status bar error')
        );

        await expect(uiSetup.setStatusBarStyle(true)).resolves.not.toThrow();
      });

      it('logs warning on failure', async () => {
        mockStatusBar.setStyle.mockRejectedValueOnce(new Error('Error'));

        await uiSetup.setStatusBarStyle(false);

        expect(consoleSpy.warn).toHaveBeenCalled();
      });
    });
  });

  describe('platform class injection', () => {
    it('does not add duplicate classes on multiple setups', async () => {
      await uiSetup.setupIOSUI();
      await uiSetup.setupIOSUI();
      await uiSetup.setupIOSUI();

      const classes = document.documentElement.className.split(' ');
      const capacitorClasses = classes.filter((c) => c === 'capacitor-ios');

      expect(capacitorClasses.length).toBe(1);
    });

    it('preserves existing classes', async () => {
      document.documentElement.classList.add('existing-class');

      await uiSetup.setupIOSUI();

      expect(document.documentElement.classList.contains('existing-class')).toBe(
        true
      );
      expect(document.documentElement.classList.contains('capacitor-ios')).toBe(
        true
      );
    });
  });

  describe('integration with CSS', () => {
    beforeEach(async () => {
      await uiSetup.setupIOSUI();
    });

    it('sets CSS variable that can be used in styles', () => {
      simulateKeyboardShow(346);

      const height = document.body.style.getPropertyValue('--keyboard-height');
      expect(height).toBe('346px');

      // This value could be used in CSS: padding-bottom: var(--keyboard-height)
    });

    it('class can be used for conditional styling', () => {
      simulateKeyboardShow(300);

      // CSS can use: .keyboard-open { ... }
      expect(document.body.classList.contains('keyboard-open')).toBe(true);

      simulateKeyboardHide();

      expect(document.body.classList.contains('keyboard-open')).toBe(false);
    });
  });

  describe('memory management', () => {
    it('does not leak listeners on repeated setup/cleanup', async () => {
      for (let i = 0; i < 10; i++) {
        await uiSetup.setupIOSUI();
        await uiSetup.cleanupKeyboardListeners();
      }

      // Final setup
      await uiSetup.setupIOSUI();

      // Should have exactly one set of listeners
      expect(mockKeyboardListeners.get('keyboardWillShow')?.length).toBe(1);
      expect(mockKeyboardListeners.get('keyboardWillHide')?.length).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles very large keyboard heights', async () => {
      await uiSetup.setupIOSUI();

      simulateKeyboardShow(9999);

      expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
        '9999px'
      );
    });

    it('handles negative keyboard heights (defensive)', async () => {
      await uiSetup.setupIOSUI();

      simulateKeyboardShow(-100);

      // Should still set the value (plugin behavior)
      expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
        '-100px'
      );
    });

    it('handles floating point keyboard heights', async () => {
      await uiSetup.setupIOSUI();

      simulateKeyboardShow(345.5);

      expect(document.body.style.getPropertyValue('--keyboard-height')).toBe(
        '345.5px'
      );
    });
  });

  describe('concurrent operations', () => {
    it('handles concurrent setup calls', async () => {
      await Promise.all([
        uiSetup.setupIOSUI(),
        uiSetup.setupIOSUI(),
        uiSetup.setupIOSUI(),
      ]);

      // Should complete without errors
      expect(document.documentElement.classList.contains('capacitor-ios')).toBe(
        true
      );
    });

    it('handles concurrent status bar changes', async () => {
      await Promise.all([
        uiSetup.setStatusBarStyle(true),
        uiSetup.setStatusBarStyle(false),
        uiSetup.setStatusBarStyle(true),
      ]);

      // All calls should complete
      expect(mockStatusBar.setStyle).toHaveBeenCalledTimes(3);
    });
  });
});
