import { describe, it, expect } from 'vitest';
import { getPageTypeConfig } from '../page-types.config';
import { PageType } from '../../utils/enums';

/**
 * The MACHINE page-type entry is a rename tripwire.
 *
 * `uiComponent` is not just a label: CenterPanel routes the Machine page by
 * comparing it against a hard-coded string (`componentName === 'MachineView'`,
 * CenterPanel.tsx). Those two literals live in different packages with nothing
 * but this test tying them together — if either side is renamed alone, a
 * Machine page silently renders nothing instead of failing to compile. The
 * Terminal→Machine sweep is exactly the kind of change that drifts them apart.
 *
 * `displayName` is the user-facing rebrand: QuickCreatePalette and PageTypeIcon
 * are config-driven, so this single value is what makes the create palette and
 * the page tree say "Machine" rather than "Terminal".
 */
describe('MACHINE page-type config', () => {
  const config = getPageTypeConfig(PageType.MACHINE);

  it('routes to MachineView — the exact literal CenterPanel dispatches on', () => {
    expect(config.uiComponent).toBe('MachineView');
  });

  it('presents as "Machine" (drives the create palette and page-tree labels)', () => {
    expect(config.displayName).toBe('Machine');
  });

  it('uses the machine layout view type', () => {
    expect(config.layoutViewType).toBe('machine');
  });

  it('carries no residual Terminal branding in its user-facing copy', () => {
    expect(config.displayName).not.toMatch(/terminal/i);
    // The description may mention terminals as a *feature* of a Machine ("open
    // terminals"), but must not name the page type itself a Terminal.
    expect(config.description).not.toMatch(/\bis an? terminal\b|^interactive terminal/i);
  });
});
