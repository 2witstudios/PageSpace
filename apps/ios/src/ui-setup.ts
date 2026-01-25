import { StatusBar, Style } from '@capacitor/status-bar';
import { Keyboard } from '@capacitor/keyboard';

/**
 * Configure iOS-specific UI elements.
 * Sets up status bar appearance and keyboard behavior.
 */
export async function setupIOSUI(): Promise<void> {
  // Configure status bar for dark theme
  try {
    await StatusBar.setStyle({ style: Style.Dark });
  } catch (error) {
    console.warn('[iOS UI] Failed to set status bar style:', error);
  }

  // Set up keyboard handling for form inputs
  setupKeyboardHandling();
}

/**
 * Handle keyboard events to adjust layout when keyboard appears.
 * Updates CSS custom property for use in layouts.
 */
function setupKeyboardHandling(): void {
  Keyboard.addListener('keyboardWillShow', (info) => {
    document.body.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
    document.body.classList.add('keyboard-open');
  });

  Keyboard.addListener('keyboardWillHide', () => {
    document.body.style.setProperty('--keyboard-height', '0px');
    document.body.classList.remove('keyboard-open');
  });
}

/**
 * Set status bar style based on theme.
 */
export async function setStatusBarStyle(isDark: boolean): Promise<void> {
  try {
    await StatusBar.setStyle({
      style: isDark ? Style.Dark : Style.Light,
    });
  } catch (error) {
    console.warn('[iOS UI] Failed to update status bar style:', error);
  }
}
