import { describe, it, expect } from 'vitest';
import { markdownConstructs } from '../markdown';

describe('markdownConstructs', () => {
  it('finds an image, which the schema has no node for', () => {
    expect(markdownConstructs('text\n\n![alt](https://example.test/a.png)\n')).toContain('md:image');
  });

  it('finds a task list, which the schema has no node for', () => {
    expect(markdownConstructs('- [ ] todo\n- [x] done\n')).toContain('md:task-list');
  });

  it('finds headings below level 3', () => {
    expect(markdownConstructs('# a\n#### b\n')).toContain('md:heading-4-6');
  });

  it('does not report a level 1-3 heading', () => {
    expect(markdownConstructs('### a\n')).toEqual([]);
  });

  it('finds a raw HTML block', () => {
    expect(markdownConstructs('<figure><img src="a.png"></figure>\n')).toContain('md:html-block');
  });

  it('finds highlight, footnote and strikethrough syntax', () => {
    expect(markdownConstructs('==a== ~~b~~\n\n[^1]: c\n')).toEqual(
      expect.arrayContaining(['md:highlight', 'md:strikethrough', 'md:footnote']),
    );
  });

  it('ignores syntax inside a fenced code block, which is literal text', () => {
    expect(markdownConstructs('```md\n![alt](a.png)\n- [ ] todo\n```\n')).toEqual([]);
  });

  it('closes a fence only on a fence line, so an unterminated fence swallows the rest', () => {
    expect(markdownConstructs('```\n![alt](a.png)\n')).toEqual([]);
  });

  it('returns a sorted list, so the report is stable between runs', () => {
    expect(markdownConstructs('~~a~~\n![b](c.png)\n')).toEqual(['md:image', 'md:strikethrough']);
  });

  it('returns nothing for prose the schema can hold', () => {
    expect(markdownConstructs('# Title\n\nSome **bold** text.\n')).toEqual([]);
  });
});
