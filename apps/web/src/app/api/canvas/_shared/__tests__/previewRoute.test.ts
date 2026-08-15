import { describe, it, expect } from 'vitest';
import { isCanvasPreviewRoute } from '../previewRoute';

describe('isCanvasPreviewRoute', () => {
  it('given the canvas preview path, should match', () => {
    expect(isCanvasPreviewRoute('/api/canvas/abc123/preview')).toBe(true);
  });

  it('given a deeper path under preview, should NOT match so it cannot inherit relaxed framing', () => {
    expect(isCanvasPreviewRoute('/api/canvas/abc123/preview/extra')).toBe(false);
  });

  it('given an id segment containing a slash, should NOT match', () => {
    expect(isCanvasPreviewRoute('/api/canvas/a/b/preview')).toBe(false);
  });

  it('given a path merely prefixed by the preview path, should NOT match', () => {
    expect(isCanvasPreviewRoute('/api/canvas/abc123/previewer')).toBe(false);
    expect(isCanvasPreviewRoute('/evil/api/canvas/abc123/preview')).toBe(false);
  });

  it('given other canvas routes, should NOT match', () => {
    expect(isCanvasPreviewRoute('/api/canvas/file-view-tokens')).toBe(false);
    expect(isCanvasPreviewRoute('/api/canvas/abc123')).toBe(false);
  });
});
