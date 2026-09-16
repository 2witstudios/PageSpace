import { describe, expect, it } from 'vitest';
import { applyThemeColor, THEME_COLORS } from '../theme-color';

const serverTags = () => [{ content: THEME_COLORS.light }, { content: THEME_COLORS.dark }];

describe('applyThemeColor', () => {
  it('should paint both scheme tags light when the user picks light on a dark OS', () => {
    const metas = serverTags();
    applyThemeColor(metas, 'light');
    expect(metas.map((m) => m.content)).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
  });

  it('should paint both scheme tags dark when the user picks dark on a light OS', () => {
    const metas = serverTags();
    applyThemeColor(metas, 'dark');
    expect(metas.map((m) => m.content)).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
  });

  it('should leave the server tags alone before the theme resolves', () => {
    const metas = serverTags();
    applyThemeColor(metas, undefined);
    expect(metas.map((m) => m.content)).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });

  it('should leave the server tags alone for an unrecognised theme value', () => {
    // "system" is a theme choice, never a resolved theme; if it ever arrives
    // here, the OS media queries are still the right answer.
    const metas = serverTags();
    applyThemeColor(metas, 'system');
    expect(metas.map((m) => m.content)).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });
});
