import { mainWindow } from './state';
import { buildDesktopCss } from './desktop-css';

export function injectDesktopStyles(): void {
  if (!mainWindow) return;

  mainWindow.webContents.insertCSS(buildDesktopCss(process.platform === 'darwin'));
}

export function injectDoubleClickHandler(): void {
  if (!mainWindow) return;

  const script = `
    (function() {
      if (window.__pagespaceDoubleClickHandlerInstalled) return;
      window.__pagespaceDoubleClickHandlerInstalled = true;

      const draggableSelectors = [
        'header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        'nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        '[role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
        '.navbar:not([class*="sidebar"]):not([class*="breadcrumb"])',
        '.header:not([class*="sidebar"]):not([class*="breadcrumb"])'
      ];

      function isDraggableArea(element) {
        const interactiveElements = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
        if (interactiveElements.includes(element.tagName)) return false;
        if (element.hasAttribute('role') && element.getAttribute('role') === 'button') return false;

        for (const selector of draggableSelectors) {
          try {
            if (element.matches(selector) || element.closest(selector)) {
              return true;
            }
          } catch (e) {}
        }
        return false;
      }

      document.addEventListener('dblclick', function(e) {
        if (isDraggableArea(e.target) && window.electron && window.electron.window) {
          window.electron.window.toggleMaximize();
        }
      });
    })();
  `;

  mainWindow.webContents.executeJavaScript(script);
}
