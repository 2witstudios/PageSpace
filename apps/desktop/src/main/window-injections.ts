import { mainWindow } from './state';

export function injectDesktopStyles(): void {
  if (!mainWindow) return;

  const isMacOS = process.platform === 'darwin';
  const trafficLightPadding = isMacOS ? 'padding-left: 80px !important;' : '';

  const css = `
    header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    [role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"]),
    .navbar:not([class*="sidebar"]):not([class*="breadcrumb"]),
    .header:not([class*="sidebar"]):not([class*="breadcrumb"]) {
      -webkit-app-region: drag;
      ${trafficLightPadding}
    }

    header a, header button, header input, header select, header textarea,
    nav a, nav button, nav input, nav select, nav textarea,
    [role="banner"] a, [role="banner"] button, [role="banner"] input,
    .navbar a, .navbar button, .navbar input, .navbar select,
    .header a, .header button, .header input, .header select {
      -webkit-app-region: no-drag;
    }

    [role="menu"], [role="dialog"], [role="listbox"],
    .dropdown, .menu, .popover, .modal {
      -webkit-app-region: no-drag;
    }

    button, a, input, select, textarea, [role="button"] {
      -webkit-app-region: no-drag;
    }
  `;

  mainWindow.webContents.insertCSS(css);
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
