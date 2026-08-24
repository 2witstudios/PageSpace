import { it, expect } from 'vitest';
import { selectLineWindow } from '../output-limit';
import { SANDBOX_MAX_OUTPUT_BYTES, MAX_LINE_BYTES } from '../execution-policy';

it('paging a huge file reconstructs it with no gaps', () => {
  const total = 5000;
  const text = Array.from({ length: total }, (_, i) => `line ${i + 1} ` + 'x'.repeat(190)).join('\n') + '\n';

  const seen: string[] = [];
  let offset = 1, pages = 0;
  for (;;) {
    const w = selectLineWindow({ text, offset, limit: 2000, maxBytes: SANDBOX_MAX_OUTPUT_BYTES, maxLineBytes: MAX_LINE_BYTES });
    if (w.lastLine < w.firstLine) break;
    pages++;
    seen.push(...w.text.replace(/\n$/, '').split('\n'));
    expect(Buffer.byteLength(w.text, 'utf8')).toBeLessThanOrEqual(SANDBOX_MAX_OUTPUT_BYTES);
    if (w.lastLine >= w.totalLines) break;
    offset = w.lastLine + 1;
  }
  console.log('pages:', pages, 'lines recovered:', seen.length, 'of', total);
  expect(seen.length).toBe(total);
  expect(seen[0]).toBe(`line 1 ` + 'x'.repeat(190));
  expect(seen[total - 1]).toBe(`line ${total} ` + 'x'.repeat(190));
});

it('a single line over the cap does not make the rest unreachable', () => {
  const text = 'A'.repeat(300 * 1024) + '\nline2\nline3\n';
  const w = selectLineWindow({ text, limit: 2000, maxBytes: SANDBOX_MAX_OUTPUT_BYTES, maxLineBytes: MAX_LINE_BYTES });
  console.log('lastLine:', w.lastLine, 'totalLines:', w.totalLines, 'lineElided:', w.lineElided);
  expect(w.lastLine).toBe(3);
  expect(w.text).toContain('line2');
  expect(w.text).toContain('line3');
});
