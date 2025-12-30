/**
 * PageSpace Mobile App Entry Point
 *
 * This file initializes the Capacitor bridge when the app loads.
 * It's bundled and injected into the WebView.
 */

import { initializeMobileBridge } from './bridge';

// Initialize the bridge when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeMobileBridge();
  });
} else {
  initializeMobileBridge();
}
