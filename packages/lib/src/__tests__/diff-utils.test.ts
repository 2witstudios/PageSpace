import { describe, it, expect } from 'vitest';
import {
  diffContent,
  generateUnifiedDiff,
  applyDiff,
  summarizeDiff,
  extractSections,
  diffTiptapNodes,
  DiffResult,
  DiffChange,
  DiffStats,
} from '../content/diff-utils';

describe('diff-utils', () => {
  describe('diffContent', () => {
    describe('basic text diffing', () => {
      it('detects no changes for identical content', () => {
        const result = diffContent('Hello World', 'Hello World');

        expect(result.isIdentical).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].type).toBe('unchanged');
        expect(result.changes[0].value).toBe('Hello World');
      });

      it('detects additions', () => {
        const result = diffContent('Hello', 'Hello World');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBeGreaterThan(0);
        expect(result.changes.some((c) => c.type === 'add' && c.value.includes('World'))).toBe(true);
      });

      it('detects deletions', () => {
        const result = diffContent('Hello World', 'Hello');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.deletions).toBeGreaterThan(0);
        expect(result.changes.some((c) => c.type === 'remove' && c.value.includes('World'))).toBe(
          true
        );
      });

      it('detects modifications', () => {
        const result = diffContent('Hello World', 'Hello There');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBeGreaterThan(0);
        expect(result.stats.deletions).toBeGreaterThan(0);
      });

      it('handles empty strings', () => {
        const result = diffContent('', '');

        expect(result.isIdentical).toBe(true);
        expect(result.changes).toHaveLength(0);
      });

      it('handles empty to non-empty', () => {
        const result = diffContent('', 'Hello');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(5);
        expect(result.stats.deletions).toBe(0);
      });

      it('handles non-empty to empty', () => {
        const result = diffContent('Hello', '');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(0);
        expect(result.stats.deletions).toBe(5);
      });

      it('handles null/undefined inputs gracefully', () => {
        const result1 = diffContent(null as unknown as string, 'Hello');
        expect(result1.isIdentical).toBe(false);
        expect(result1.stats.additions).toBe(5);

        const result2 = diffContent('Hello', undefined as unknown as string);
        expect(result2.isIdentical).toBe(false);
        expect(result2.stats.deletions).toBe(5);

        const result3 = diffContent(null as unknown as string, undefined as unknown as string);
        expect(result3.isIdentical).toBe(true);
      });
    });

    describe('format detection', () => {
      it('detects text format', () => {
        const result = diffContent('Plain text content', 'Plain text modified');

        expect(result.format).toBe('text');
      });

      it('detects HTML format', () => {
        const oldHtml = '<div><p>Hello</p></div>';
        const newHtml = '<div><p>World</p></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.format).toBe('html');
      });

      it('detects JSON format', () => {
        const oldJson = '{"key": "value1"}';
        const newJson = '{"key": "value2"}';
        const result = diffContent(oldJson, newJson);

        expect(result.format).toBe('json');
      });

      it('detects tiptap format', () => {
        const oldTiptap = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
        const newTiptap = JSON.stringify({ type: 'doc', content: [{ type: 'heading' }] });
        const result = diffContent(oldTiptap, newTiptap);

        expect(result.format).toBe('tiptap');
      });

      it('respects explicit format option', () => {
        const result = diffContent('Hello', 'World', { format: 'html' });

        expect(result.format).toBe('html');
      });
    });

    describe('HTML diffing', () => {
      it('diffs HTML content correctly', () => {
        const oldHtml = '<div><p>Hello World</p></div>';
        const newHtml = '<div><p>Hello There</p></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.format).toBe('html');
        expect(result.isIdentical).toBe(false);
      });

      it('handles nested HTML changes', () => {
        const oldHtml = '<div><span>Text</span></div>';
        const newHtml = '<div><span><strong>Text</strong></span></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBeGreaterThan(0);
      });

      it('handles attribute changes', () => {
        const oldHtml = '<div class="old">Content</div>';
        const newHtml = '<div class="new">Content</div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.isIdentical).toBe(false);
      });
    });

    describe('JSON diffing', () => {
      it('diffs JSON content correctly', () => {
        const oldJson = JSON.stringify({ name: 'John', age: 30 });
        const newJson = JSON.stringify({ name: 'John', age: 31 });
        const result = diffContent(oldJson, newJson);

        expect(result.format).toBe('json');
        expect(result.isIdentical).toBe(false);
      });

      it('handles nested JSON changes', () => {
        const oldJson = JSON.stringify({ user: { name: 'John' } });
        const newJson = JSON.stringify({ user: { name: 'Jane' } });
        const result = diffContent(oldJson, newJson);

        expect(result.isIdentical).toBe(false);
      });

      it('supports pretty-print option', () => {
        const oldJson = '{"key":"value1"}';
        const newJson = '{"key":"value2"}';
        const result = diffContent(oldJson, newJson, { prettyPrint: true });

        expect(result.isIdentical).toBe(false);
      });
    });

    describe('tiptap diffing', () => {
      const createTiptapDoc = (paragraphs: string[]) =>
        JSON.stringify({
          type: 'doc',
          content: paragraphs.map((text) => ({
            type: 'paragraph',
            content: [{ type: 'text', text }],
          })),
        });

      it('diffs tiptap documents correctly', () => {
        const oldDoc = createTiptapDoc(['Hello', 'World']);
        const newDoc = createTiptapDoc(['Hello', 'There']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.format).toBe('tiptap');
        expect(result.isIdentical).toBe(false);
      });

      it('detects paragraph additions', () => {
        const oldDoc = createTiptapDoc(['Hello']);
        const newDoc = createTiptapDoc(['Hello', 'World']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBeGreaterThan(0);
      });

      it('detects paragraph deletions', () => {
        const oldDoc = createTiptapDoc(['Hello', 'World']);
        const newDoc = createTiptapDoc(['Hello']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.deletions).toBeGreaterThan(0);
      });
    });

    describe('line mode', () => {
      it('diffs by lines when lineMode is true', () => {
        const oldText = 'Line 1\nLine 2\nLine 3';
        const newText = 'Line 1\nModified Line\nLine 3';
        const result = diffContent(oldText, newText, { lineMode: true });

        expect(result.isIdentical).toBe(false);
      });

      it('is more efficient for large texts', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n');
        const modifiedLines = lines.replace('Line 50', 'Modified Line 50');

        const start = Date.now();
        const result = diffContent(lines, modifiedLines, { lineMode: true });
        const duration = Date.now() - start;

        expect(result.isIdentical).toBe(false);
        expect(duration).toBeLessThan(1000); // Should complete quickly
      });
    });

    describe('timeout handling', () => {
      it('respects timeout option', () => {
        // Create content that takes a while to diff
        const largeContent1 = 'a'.repeat(1000);
        const largeContent2 = 'b'.repeat(1000);

        const result = diffContent(largeContent1, largeContent2, { timeout: 100 });

        // Should still return a result (may be approximate due to timeout)
        expect(result).toBeDefined();
        expect(result.isIdentical).toBe(false);
      });
    });

    describe('position tracking', () => {
      it('tracks original positions for deletions', () => {
        const result = diffContent('Hello World', 'Hello');

        const deleteChange = result.changes.find((c) => c.type === 'remove');
        expect(deleteChange).toBeDefined();
        expect(deleteChange?.originalStart).toBeDefined();
        expect(deleteChange?.originalEnd).toBeDefined();
      });

      it('tracks new positions for additions', () => {
        const result = diffContent('Hello', 'Hello World');

        const addChange = result.changes.find((c) => c.type === 'add');
        expect(addChange).toBeDefined();
        expect(addChange?.newStart).toBeDefined();
        expect(addChange?.newEnd).toBeDefined();
      });

      it('tracks both positions for unchanged content', () => {
        const result = diffContent('Hello World', 'Hello There');

        const unchangedChange = result.changes.find((c) => c.type === 'unchanged');
        expect(unchangedChange).toBeDefined();
        expect(unchangedChange?.originalStart).toBeDefined();
        expect(unchangedChange?.originalEnd).toBeDefined();
        expect(unchangedChange?.newStart).toBeDefined();
        expect(unchangedChange?.newEnd).toBeDefined();
      });
    });

    describe('statistics', () => {
      it('calculates correct statistics', () => {
        const result = diffContent('Hello World', 'Hello There');

        expect(result.stats.additions).toBeGreaterThan(0);
        expect(result.stats.deletions).toBeGreaterThan(0);
        expect(result.stats.unchanged).toBeGreaterThan(0);
        expect(result.stats.totalChanges).toBeGreaterThan(0);
      });

      it('totalChanges counts add and remove operations', () => {
        const result = diffContent('Hello World', 'Hello There');

        // totalChanges should be at least 2 (one add, one remove)
        expect(result.stats.totalChanges).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('generateUnifiedDiff', () => {
    it('generates unified diff format', () => {
      const patch = generateUnifiedDiff('Hello World', 'Hello There');

      expect(patch).toContain('---');
      expect(patch).toContain('+++');
    });

    it('uses custom labels', () => {
      const patch = generateUnifiedDiff('Hello', 'World', 'version1.txt', 'version2.txt');

      expect(patch).toContain('--- version1.txt');
      expect(patch).toContain('+++ version2.txt');
    });

    it('returns empty diff for identical content', () => {
      const patch = generateUnifiedDiff('Hello', 'Hello');

      // Should have headers but minimal content
      expect(patch).toContain('---');
      expect(patch).toContain('+++');
    });

    it('handles null/undefined inputs', () => {
      const patch = generateUnifiedDiff(null as unknown as string, 'Hello');

      expect(patch).toBeDefined();
    });
  });

  describe('applyDiff', () => {
    it('applies a patch to restore content', () => {
      const original = 'Hello World';
      const modified = 'Hello There';
      const patch = generateUnifiedDiff(original, modified);

      const result = applyDiff(original, patch);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('handles round-trip diffing', () => {
      const version1 = 'Line 1\nLine 2\nLine 3';
      const version2 = 'Line 1\nModified\nLine 3';

      const patch = generateUnifiedDiff(version1, version2);
      const result = applyDiff(version1, patch);

      expect(result.success).toBe(true);
      expect(result.content).toBe(version2);
    });

    it('returns false success for invalid patch', () => {
      const result = applyDiff('Hello', 'not a valid patch');

      expect(result.success).toBe(false);
    });

    it('handles null base content', () => {
      const patch = generateUnifiedDiff('', 'Hello');
      const result = applyDiff(null as unknown as string, patch);

      expect(result).toBeDefined();
    });
  });

  describe('summarizeDiff', () => {
    it('returns "No changes" for identical content', () => {
      const result = diffContent('Hello', 'Hello');
      const summary = summarizeDiff(result);

      expect(summary).toBe('No changes detected');
    });

    it('shows additions and deletions', () => {
      const result = diffContent('Hello World', 'Hello There');
      const summary = summarizeDiff(result);

      expect(summary).toContain('+');
      expect(summary).toContain('-');
      expect(summary).toContain('characters');
    });

    it('shows only additions when no deletions', () => {
      const result = diffContent('Hello', 'Hello World');
      const summary = summarizeDiff(result);

      expect(summary).toContain('+');
      expect(summary).toContain('characters');
    });

    it('shows only deletions when no additions', () => {
      const result = diffContent('Hello World', 'Hello');
      const summary = summarizeDiff(result);

      expect(summary).toContain('-');
      expect(summary).toContain('characters');
    });

    it('includes percentages', () => {
      const result = diffContent('Hello', 'Hello World');
      const summary = summarizeDiff(result);

      expect(summary).toMatch(/\d+\.\d+%/);
    });
  });

  describe('extractSections', () => {
    describe('text content', () => {
      it('extracts paragraphs from text', () => {
        const content = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3';
        const sections = extractSections(content);

        expect(sections).toHaveLength(3);
        expect(sections[0].content).toBe('Paragraph 1');
        expect(sections[1].content).toBe('Paragraph 2');
        expect(sections[2].content).toBe('Paragraph 3');
      });

      it('handles single paragraph', () => {
        const sections = extractSections('Just one paragraph');

        expect(sections).toHaveLength(1);
        expect(sections[0].content).toBe('Just one paragraph');
      });

      it('handles empty content', () => {
        const sections = extractSections('');

        expect(sections).toHaveLength(0);
      });

      it('handles whitespace-only content', () => {
        const sections = extractSections('   \n\n   ');

        expect(sections).toHaveLength(0);
      });

      it('assigns unique IDs to sections', () => {
        const content = 'Para 1\n\nPara 2\n\nPara 3';
        const sections = extractSections(content);

        const ids = sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      });
    });

    describe('tiptap content', () => {
      it('extracts nodes from tiptap document', () => {
        const tiptapDoc = JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
            { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
          ],
        });

        const sections = extractSections(tiptapDoc);

        expect(sections).toHaveLength(2);
        expect(sections[0].type).toBe('paragraph');
        expect(sections[1].type).toBe('heading');
      });

      it('handles empty tiptap document', () => {
        const tiptapDoc = JSON.stringify({ type: 'doc', content: [] });
        const sections = extractSections(tiptapDoc);

        expect(sections).toHaveLength(0);
      });

      it('handles invalid JSON gracefully', () => {
        const sections = extractSections('not valid json');

        // Falls back to text extraction
        expect(sections).toHaveLength(1);
        expect(sections[0].type).toBe('paragraph');
      });
    });

    describe('HTML content', () => {
      it('treats HTML as text for section extraction', () => {
        const html = '<div>Para 1</div>\n\n<div>Para 2</div>';
        const sections = extractSections(html);

        // Should split by double newlines
        expect(sections.length).toBeGreaterThan(0);
      });
    });
  });

  describe('diffTiptapNodes', () => {
    const createDoc = (nodes: Array<{ type: string; text?: string }>) =>
      JSON.stringify({
        type: 'doc',
        content: nodes.map((n) => ({
          type: n.type,
          content: n.text ? [{ type: 'text', text: n.text }] : undefined,
        })),
      });

    it('detects added nodes', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([
        { type: 'paragraph', text: 'Hello' },
        { type: 'paragraph', text: 'World' },
      ]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes.some((c) => c.type === 'add')).toBe(true);
    });

    it('detects removed nodes', () => {
      const oldDoc = createDoc([
        { type: 'paragraph', text: 'Hello' },
        { type: 'paragraph', text: 'World' },
      ]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes.some((c) => c.type === 'remove')).toBe(true);
    });

    it('detects modified nodes', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'World' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes.some((c) => c.type === 'modify')).toBe(true);
    });

    it('detects unchanged nodes', () => {
      const doc = createDoc([{ type: 'paragraph', text: 'Hello' }]);

      const changes = diffTiptapNodes(doc, doc);

      expect(changes.every((c) => c.type === 'unchanged')).toBe(true);
    });

    it('includes node type in changes', () => {
      const oldDoc = createDoc([{ type: 'heading', text: 'Title' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'Title' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes[0].nodeType).toBeDefined();
    });

    it('includes path in changes', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'World' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes[0].path).toBe('content[0]');
    });

    it('handles empty documents', () => {
      const emptyDoc = JSON.stringify({ type: 'doc', content: [] });
      const changes = diffTiptapNodes(emptyDoc, emptyDoc);

      expect(changes).toHaveLength(0);
    });

    it('handles null/undefined content', () => {
      const changes = diffTiptapNodes(null as unknown as string, 'invalid');

      expect(changes).toBeDefined();
      expect(changes.length).toBeGreaterThan(0);
    });

    it('handles invalid JSON gracefully', () => {
      const changes = diffTiptapNodes('not json', 'also not json');

      expect(changes).toBeDefined();
      expect(changes.length).toBe(1);
      expect(changes[0].type).toBe('modify');
    });
  });

  describe('edge cases', () => {
    it('handles very long content', () => {
      const longContent = 'a'.repeat(100000);
      const modifiedContent = longContent.substring(0, 50000) + 'X' + longContent.substring(50001);

      const result = diffContent(longContent, modifiedContent);

      expect(result).toBeDefined();
      expect(result.isIdentical).toBe(false);
    });

    it('handles special characters', () => {
      const content1 = 'Hello\t\n\rWorld';
      const content2 = 'Hello\t\n\rThere';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
    });

    it('handles unicode characters', () => {
      const content1 = '你好世界';
      const content2 = '你好宇宙';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
      expect(result.stats.additions).toBeGreaterThan(0);
      expect(result.stats.deletions).toBeGreaterThan(0);
    });

    it('handles emoji content', () => {
      const content1 = 'Hello 🌍 World';
      const content2 = 'Hello 🌎 World';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
    });

    it('handles mixed newline styles', () => {
      const content1 = 'Line 1\nLine 2\r\nLine 3';
      const content2 = 'Line 1\r\nLine 2\nLine 3';

      const result = diffContent(content1, content2);

      // Content differs due to newline differences
      expect(result).toBeDefined();
    });
  });

  describe('integration', () => {
    it('full workflow: diff, patch, and verify', () => {
      const original = 'The quick brown fox\njumps over\nthe lazy dog';
      const modified = 'The quick red fox\nleaps over\nthe lazy cat';

      // Generate diff
      const diffResult = diffContent(original, modified);
      expect(diffResult.isIdentical).toBe(false);

      // Generate patch
      const patch = generateUnifiedDiff(original, modified);

      // Apply patch
      const applied = applyDiff(original, patch);
      expect(applied.success).toBe(true);
      expect(applied.content).toBe(modified);

      // Summarize
      const summary = summarizeDiff(diffResult);
      expect(summary).toContain('characters');
    });

    it('selective rollback workflow with tiptap', () => {
      const version1 = JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 1' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 2' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 3' }] },
        ],
      });

      const version2 = JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 1 MODIFIED' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 2' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph 3 MODIFIED' }] },
        ],
      });

      // Extract sections
      const sections1 = extractSections(version1);
      const sections2 = extractSections(version2);

      expect(sections1).toHaveLength(3);
      expect(sections2).toHaveLength(3);

      // Diff nodes
      const nodeChanges = diffTiptapNodes(version1, version2);

      // Should identify modified nodes
      const modifiedNodes = nodeChanges.filter((c) => c.type === 'modify');
      expect(modifiedNodes.length).toBe(2); // First and third paragraphs

      // Unchanged node
      const unchangedNodes = nodeChanges.filter((c) => c.type === 'unchanged');
      expect(unchangedNodes.length).toBe(1); // Second paragraph
    });
  });
});
