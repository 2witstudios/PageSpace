export function remapDocumentSelectors(css: string): string {
  if (!css) return '';

  return css
    .replace(/(^|[{},;\s])body(?=\s*[{,\s*>+~:[.])/gm, '$1.canvas-root')
    .replace(/(^|[{},;\s])html(?=\s*[{,\s*>+~:[.])/gm, '$1.canvas-root')
    .replace(/(^|[{},;\s]):root(?=\s*[{,\s])/gm, '$1.canvas-root');
}
