import { describe, it, expect } from 'vitest';
import {
  colors,
  typography,
  spacing,
  radius,
  shadows,
  emailStyles,
  divider,
} from '../shared-styles';

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------
describe('colors', () => {
  it('exports a colors object', () => {
    expect(colors).toBeDefined();
    expect(typeof colors).toBe('object');
  });

  it('has primary color as hex string', () => {
    expect(colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('has primaryLight color', () => {
    expect(colors.primaryLight).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('has primaryForeground as white', () => {
    expect(colors.primaryForeground).toBe('#FFFFFF');
  });

  it('has pageBackground color', () => {
    expect(typeof colors.pageBackground).toBe('string');
    expect(colors.pageBackground).toBeTruthy();
  });

  it('has cardBackground color', () => {
    expect(typeof colors.cardBackground).toBe('string');
  });

  it('has heading color', () => {
    expect(typeof colors.heading).toBe('string');
    expect(colors.heading).toMatch(/^#/);
  });

  it('has text color', () => {
    expect(typeof colors.text).toBe('string');
  });

  it('has mutedText color', () => {
    expect(typeof colors.mutedText).toBe('string');
  });

  it('has border color', () => {
    expect(typeof colors.border).toBe('string');
  });

  it('has divider color', () => {
    expect(typeof colors.divider).toBe('string');
  });

  it('has accent color', () => {
    expect(typeof colors.accent).toBe('string');
  });

  it('has accentBorder color', () => {
    expect(typeof colors.accentBorder).toBe('string');
  });

  it('has link color', () => {
    expect(typeof colors.link).toBe('string');
  });

  it('has linkHover color', () => {
    expect(typeof colors.linkHover).toBe('string');
  });

  it('has all expected color keys', () => {
    const expectedKeys = [
      'primary', 'primaryLight', 'primaryForeground',
      'pageBackground', 'cardBackground', 'headerGradientStart', 'headerGradientEnd',
      'heading', 'text', 'mutedText',
      'border', 'divider', 'accent', 'accentBorder', 'link', 'linkHover',
    ];
    for (const key of expectedKeys) {
      expect(colors).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// typography
// ---------------------------------------------------------------------------
describe('typography', () => {
  it('exports a typography object', () => {
    expect(typography).toBeDefined();
    expect(typeof typography).toBe('object');
  });

  it('has fontFamily string', () => {
    expect(typeof typography.fontFamily).toBe('string');
    expect(typography.fontFamily.length).toBeGreaterThan(0);
  });

  it('has h1 font size', () => {
    expect(typography.h1).toMatch(/px$/);
  });

  it('has h2 font size', () => {
    expect(typography.h2).toMatch(/px$/);
  });

  it('has h3 font size', () => {
    expect(typography.h3).toMatch(/px$/);
  });

  it('has body font size', () => {
    expect(typography.body).toMatch(/px$/);
  });

  it('has small font size', () => {
    expect(typography.small).toMatch(/px$/);
  });

  it('has tiny font size', () => {
    expect(typography.tiny).toMatch(/px$/);
  });

  it('has headingLineHeight as string number', () => {
    expect(typeof typography.headingLineHeight).toBe('string');
    expect(parseFloat(typography.headingLineHeight)).toBeGreaterThan(0);
  });

  it('has bodyLineHeight as string number', () => {
    expect(typeof typography.bodyLineHeight).toBe('string');
    expect(parseFloat(typography.bodyLineHeight)).toBeGreaterThan(0);
  });

  it('has font weight values', () => {
    expect(typography.regular).toBeDefined();
    expect(typography.medium).toBeDefined();
    expect(typography.semibold).toBeDefined();
    expect(typography.bold).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// spacing
// ---------------------------------------------------------------------------
describe('spacing', () => {
  it('exports a spacing object', () => {
    expect(spacing).toBeDefined();
    expect(typeof spacing).toBe('object');
  });

  it('has xs spacing as px value', () => {
    expect(spacing.xs).toMatch(/px$/);
  });

  it('has sm spacing', () => {
    expect(spacing.sm).toMatch(/px$/);
  });

  it('has md spacing', () => {
    expect(spacing.md).toMatch(/px$/);
  });

  it('has lg spacing', () => {
    expect(spacing.lg).toMatch(/px$/);
  });

  it('has xl spacing', () => {
    expect(spacing.xl).toMatch(/px$/);
  });

  it('has xxl spacing', () => {
    expect(spacing.xxl).toMatch(/px$/);
  });

  it('has all 6 spacing levels', () => {
    expect(Object.keys(spacing)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// radius
// ---------------------------------------------------------------------------
describe('radius', () => {
  it('exports a radius object', () => {
    expect(radius).toBeDefined();
    expect(typeof radius).toBe('object');
  });

  it('has sm border radius', () => {
    expect(radius.sm).toMatch(/px$/);
  });

  it('has md border radius', () => {
    expect(radius.md).toMatch(/px$/);
  });

  it('has lg border radius', () => {
    expect(radius.lg).toMatch(/px$/);
  });
});

// ---------------------------------------------------------------------------
// shadows
// ---------------------------------------------------------------------------
describe('shadows', () => {
  it('exports a shadows object', () => {
    expect(shadows).toBeDefined();
    expect(typeof shadows).toBe('object');
  });

  it('has sm shadow', () => {
    expect(typeof shadows.sm).toBe('string');
    expect(shadows.sm.length).toBeGreaterThan(0);
  });

  it('has md shadow', () => {
    expect(typeof shadows.md).toBe('string');
    expect(shadows.md.length).toBeGreaterThan(0);
  });

  it('has lg shadow', () => {
    expect(typeof shadows.lg).toBe('string');
    expect(shadows.lg.length).toBeGreaterThan(0);
  });

  it('has button shadow', () => {
    expect(typeof shadows.button).toBe('string');
    expect(shadows.button.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// emailStyles
// ---------------------------------------------------------------------------
describe('emailStyles', () => {
  it('exports emailStyles object', () => {
    expect(emailStyles).toBeDefined();
    expect(typeof emailStyles).toBe('object');
  });

  it('has main style with backgroundColor', () => {
    expect(emailStyles.main.backgroundColor).toBeDefined();
  });

  it('has main style with fontFamily', () => {
    expect(emailStyles.main.fontFamily).toBeDefined();
  });

  it('has container style with maxWidth', () => {
    expect(emailStyles.container.maxWidth).toBe('600px');
  });

  it('has container style with boxShadow', () => {
    expect(emailStyles.container.boxShadow).toBeDefined();
  });

  it('has header style with background gradient', () => {
    expect(emailStyles.header.background).toContain('linear-gradient');
  });

  it('has headerTitle style with color', () => {
    expect(emailStyles.headerTitle.color).toBeDefined();
  });

  it('has content style with backgroundColor', () => {
    expect(emailStyles.content.backgroundColor).toBeDefined();
  });

  it('has contentHeading style with fontSize', () => {
    expect(emailStyles.contentHeading.fontSize).toBeDefined();
  });

  it('has paragraph style', () => {
    expect(emailStyles.paragraph).toBeDefined();
    expect(emailStyles.paragraph.fontSize).toBeDefined();
  });

  it('has hint style', () => {
    expect(emailStyles.hint).toBeDefined();
    expect(emailStyles.hint.fontSize).toBeDefined();
  });

  it('has messageBox style with borderLeft', () => {
    expect(emailStyles.messageBox.borderLeft).toBeDefined();
  });

  it('has messageText style', () => {
    expect(emailStyles.messageText).toBeDefined();
  });

  it('has buttonContainer style with textAlign center', () => {
    expect(emailStyles.buttonContainer.textAlign).toBe('center');
  });

  it('has button style with background gradient', () => {
    expect(emailStyles.button.background).toContain('linear-gradient');
  });

  it('has button style with boxShadow', () => {
    expect(emailStyles.button.boxShadow).toBeDefined();
  });

  it('has link style with color', () => {
    expect(emailStyles.link.color).toBeDefined();
  });

  it('has footer style', () => {
    expect(emailStyles.footer).toBeDefined();
    expect(emailStyles.footer.backgroundColor).toBeDefined();
  });

  it('has footerText style with textAlign center', () => {
    expect(emailStyles.footerText.textAlign).toBe('center');
  });

  it('has divider style in emailStyles', () => {
    expect(emailStyles.divider).toBeDefined();
    expect(emailStyles.divider.borderTop).toBeDefined();
  });

  it('has all expected top-level emailStyles keys', () => {
    const expectedKeys = [
      'main', 'container', 'header', 'headerTitle', 'content',
      'contentHeading', 'paragraph', 'hint', 'messageBox', 'messageText',
      'buttonContainer', 'button', 'link', 'footer', 'footerText', 'divider',
    ];
    for (const key of expectedKeys) {
      expect(emailStyles).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// divider (standalone export)
// ---------------------------------------------------------------------------
describe('divider', () => {
  it('exports a divider style object', () => {
    expect(divider).toBeDefined();
    expect(typeof divider).toBe('object');
  });

  it('has borderTop property', () => {
    expect(typeof divider.borderTop).toBe('string');
    expect(divider.borderTop.length).toBeGreaterThan(0);
  });

  it('has margin property', () => {
    expect(typeof divider.margin).toBe('string');
    expect(divider.margin.length).toBeGreaterThan(0);
  });

  it('references the border color', () => {
    expect(divider.borderTop).toContain(colors.border);
  });
});
