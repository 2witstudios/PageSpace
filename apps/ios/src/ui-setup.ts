import { StatusBar, Style } from '@capacitor/status-bar';
import { Keyboard, type KeyboardInfo } from '@capacitor/keyboard';
import type { PluginListenerHandle } from '@capacitor/core';

let keyboardShowListener: PluginListenerHandle | null = null;
let keyboardHideListener: PluginListenerHandle | null = null;

/**
 * Configure iOS-specific UI elements.
 * Sets up status bar appearance and keyboard behavior.
 */
export async function setupIOSUI(): Promise<void> {
  // Add platform class for CSS targeting (safe-area, keyboard styles)
  document.documentElement.classList.add('capacitor-ios');

  // Configure status bar for dark theme
  try {
    await StatusBar.setStyle({ style: Style.Light });
  } catch (error) {
    console.warn('[iOS UI] Failed to set status bar style:', error);
  }

  // Set up keyboard handling for form inputs
  await setupKeyboardHandling();
}

/**
 * Handle keyboard events to adjust layout when keyboard appears.
 * Updates CSS custom property for use in layouts.
 */
async function setupKeyboardHandling(): Promise<void> {
  // Clean up any existing listeners first
  await cleanupKeyboardListeners();

  keyboardShowListener = await Keyboard.addListener(
    'keyboardWillShow',
    (info: KeyboardInfo) => {
      document.body.style.setProperty(
        '--keyboard-height',
        `${info.keyboardHeight}px`
      );
      document.body.classList.add('keyboard-open');
    }
  );

  keyboardHideListener = await Keyboard.addListener('keyboardWillHide', () => {
    document.body.style.setProperty('--keyboard-height', '0px');
    document.body.classList.remove('keyboard-open');
  });
}

/**
 * Clean up keyboard event listeners.
 * Call this when the app is being destroyed or listeners need to be reset.
 */
export async function cleanupKeyboardListeners(): Promise<void> {
  await keyboardShowListener?.remove();
  await keyboardHideListener?.remove();
  keyboardShowListener = null;
  keyboardHideListener = null;
}

/**
 * Set status bar style based on theme.
 */
export async function setStatusBarStyle(isDark: boolean): Promise<void> {
  try {
    await StatusBar.setStyle({
      style: isDark ? Style.Light : Style.Dark,
    });
  } catch (error) {
    console.warn('[iOS UI] Failed to update status bar style:', error);
  }
}
