import { describe, it, expect } from 'vitest';
import { CANVAS_IFRAME_SANDBOX } from '../CanvasFrame';

/**
 * Security invariant guard for the in-app canvas iframe.
 *
 * CanvasFrame renders author HTML/JS via `srcDoc`. A `srcDoc` iframe inherits
 * the parent (app) origin, so the ONLY thing making it an opaque, isolated
 * origin is the absence of `allow-same-origin` in its sandbox. Granting
 * `allow-same-origin` together with `allow-scripts` would let author JavaScript
 * run AS the logged-in app — a full session/account compromise. This is one
 * token away, so it gets a dedicated regression test.
 */
describe('CANVAS_IFRAME_SANDBOX', () => {
  it('given the canvas iframe sandbox, should NEVER grant allow-same-origin', () => {
    expect(CANVAS_IFRAME_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin');
  });

  it('given the canvas iframe sandbox, should run author JS in an opaque origin and allow new-tab links', () => {
    const tokens = CANVAS_IFRAME_SANDBOX.split(/\s+/);
    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-popups');
    expect(tokens).toContain('allow-popups-to-escape-sandbox');
    // Must not be able to navigate the app's own (top) tab.
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens).not.toContain('allow-top-navigation-by-user-activation');
  });
});
