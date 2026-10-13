/**
 * The CSS the desktop shell injects into every page. Kept free of Electron imports so the
 * selectors can be unit-tested.
 *
 * Imago marks its shell root with `data-desktop-frame` when it runs under Electron. That
 * root opts out of the generic 80px nav/header padding (the open "Desktop app" decision is
 * not resolved here) and instead takes a 44px top inset on the spine plus explicit drag
 * regions, so the hiddenInset traffic lights (16,16) sit above the drive tile.
 */

export const DESKTOP_FRAME_ATTRIBUTE = 'data-desktop-frame';
export const DESKTOP_DRAG_ATTRIBUTE = 'data-desktop-drag';

const GENERIC_CHROME = [
  'header:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
  'nav:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
  '[role="banner"]:not(aside *):not([class*="sidebar"]):not([class*="breadcrumb"])',
  '.navbar:not([class*="sidebar"]):not([class*="breadcrumb"])',
  '.header:not([class*="sidebar"]):not([class*="breadcrumb"])',
] as const;

const FRAME = `[${DESKTOP_FRAME_ATTRIBUTE}]`;
const DRAG = `[${DESKTOP_DRAG_ATTRIBUTE}]`;

/** The generic chrome rule: drag on every header/nav, with the macOS traffic-light padding outside imago. */
function genericChromeCss(isMacOS: boolean): string {
  const dragRule = `
    ${GENERIC_CHROME.join(',\n    ')} {
      -webkit-app-region: drag;
    }
  `;
  if (!isMacOS) return dragRule;
  const paddingRule = `
    ${GENERIC_CHROME.map((selector) => `${selector}:not(${FRAME} *)`).join(',\n    ')} {
      padding-left: 80px !important;
    }
  `;
  return dragRule + paddingRule;
}

/** Imago's own frame: the spine inset, and drag regions on its empty chrome. */
function imagoFrameCss(isMacOS: boolean): string {
  const inset = isMacOS
    ? `
    ${FRAME} nav[aria-label="Sections"] {
      padding-top: 44px !important;
    }
  `
    : '';
  return `${inset}
    ${FRAME} ${DRAG} {
      -webkit-app-region: drag;
    }

    ${FRAME} [role="tab"],
    ${FRAME} [role="tab"] * {
      -webkit-app-region: no-drag;
    }
  `;
}

export function buildDesktopCss(isMacOS: boolean): string {
  return `
    ${genericChromeCss(isMacOS)}

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

    ${imagoFrameCss(isMacOS)}
  `;
}
