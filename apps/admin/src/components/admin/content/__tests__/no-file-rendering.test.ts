/**
 * The content-safety console must never display or link to a file: admins act
 * on suspected CSAM, and must not be shown it.
 *
 * The API routes already return metadata only (asserted in their own tests).
 * This is the second lock, on the UI side: none of the console's components
 * may contain an element or attribute that could render or navigate to
 * content. If you need one of these, the answer is no — show the ID as text.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const SOURCES = [
  ...readdirSync(path.resolve(__dirname, '..'))
    .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
    .map((name) => path.resolve(__dirname, '..', name)),
  path.resolve(__dirname, '../../../../app/(admin)/content/page.tsx'),
];

const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ['an <img> element', /<img\b/i],
  ['a Next <Image>', /<Image\b/],
  ['an <a> element', /<a\s/i],
  ['a Next <Link>', /<Link\b/],
  ['an href attribute', /\bhref\s*=/],
  ['a src attribute', /\bsrc\s*=/],
  ['a <video>, <audio>, <iframe>, <embed> or <object>', /<(video|audio|iframe|embed|object)\b/i],
  ['a CSS background image', /background(Image)?\s*:\s*[`'"]?url\(/i],
  ['window.open', /window\.open\(/],
  ['an avatar component', /<Avatar(Image)?\b/],
  ['a file-serving route', /\/api\/(files|avatar)\//],
];

describe('content-safety console never renders or links to a file', () => {
  it('covers every component of the console', () => {
    const names = SOURCES.map((file) => path.basename(file));
    expect(names).toEqual(
      expect.arrayContaining(['target-panel.tsx', 'case-list.tsx', 'blocked-uploads.tsx', 'takedown-dialog.tsx', 'report-queue.tsx', 'scan-verdicts.tsx', 'page.tsx']),
    );
  });

  it.each(SOURCES.map((file) => [path.basename(file), file]))('%s contains nothing that could display or open content', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN) {
      expect(pattern.test(source), `${path.basename(file)} must not contain ${label}`).toBe(false);
    }
  });
});
