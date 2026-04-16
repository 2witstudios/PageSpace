const SELECTOR_LOOKAHEAD = '(?=\\s*[{,\\s*>+~:[.#])';
const SELECTOR_LOOKBEHIND = '(^|[{},;\\s])';

export function remapDocumentSelectors(css: string): string {
  if (!css) return '';

  // Collapse compound html+body selectors first to prevent
  // .canvas-root .canvas-root (which matches nothing in the shadow DOM)
  const compoundBody = new RegExp(`${SELECTOR_LOOKBEHIND}html\\s*>\\s*body${SELECTOR_LOOKAHEAD}`, 'gm');
  const descendantBody = new RegExp(`${SELECTOR_LOOKBEHIND}html\\s+body${SELECTOR_LOOKAHEAD}`, 'gm');
  const body = new RegExp(`${SELECTOR_LOOKBEHIND}body${SELECTOR_LOOKAHEAD}`, 'gm');
  const html = new RegExp(`${SELECTOR_LOOKBEHIND}html${SELECTOR_LOOKAHEAD}`, 'gm');
  const root = new RegExp(`${SELECTOR_LOOKBEHIND}:root${SELECTOR_LOOKAHEAD}`, 'gm');

  return css
    .replace(compoundBody, '$1.canvas-root')
    .replace(descendantBody, '$1.canvas-root')
    .replace(body, '$1.canvas-root')
    .replace(html, '$1.canvas-root')
    .replace(root, '$1.canvas-root');
}
