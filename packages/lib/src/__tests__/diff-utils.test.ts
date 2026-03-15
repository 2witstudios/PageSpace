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
      it('given_identicalContent_returnsIsIdenticalWithSingleUnchangedChunk', () => {
        const result = diffContent('Hello World', 'Hello World');

        expect(result.isIdentical).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].type).toBe('unchanged');
        expect(result.changes[0].value).toBe('Hello World');
      });

      it('given_addedSuffix_reportsExactAdditionCount', () => {
        const result = diffContent('Hello', 'Hello World');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(6);
        const addChange = result.changes.find((c) => c.type === 'add');
        expect(addChange).toEqual(expect.objectContaining({ type: 'add' }));
        expect(addChange!.value).toContain('World');
      });

      it('given_removedSuffix_reportsExactDeletionCount', () => {
        const result = diffContent('Hello World', 'Hello');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.deletions).toBe(6);
        const removeChange = result.changes.find((c) => c.type === 'remove');
        expect(removeChange).toEqual(expect.objectContaining({ type: 'remove' }));
        expect(removeChange!.value).toContain('World');
      });

      it('given_modifiedSuffix_reportsSymmetricAdditionsAndDeletions', () => {
        const result = diffContent('Hello World', 'Hello There');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(5);
        expect(result.stats.deletions).toBe(5);
      });

      it('given_emptyStrings_returnsIdenticalWithNoChanges', () => {
        const result = diffContent('', '');

        expect(result.isIdentical).toBe(true);
        expect(result.changes).toHaveLength(0);
      });

      it('given_emptyToNonEmpty_reportsAllAsAdditions', () => {
        const result = diffContent('', 'Hello');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(5);
        expect(result.stats.deletions).toBe(0);
      });

      it('given_nonEmptyToEmpty_reportsAllAsDeletions', () => {
        const result = diffContent('Hello', '');

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(0);
        expect(result.stats.deletions).toBe(5);
      });

      it('given_nullUndefinedInputs_treatsAsEmptyStrings', () => {
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
      it('given_plainText_detectsTextFormat', () => {
        const result = diffContent('Plain text content', 'Plain text modified');

        expect(result.format).toBe('text');
      });

      it('given_htmlContent_detectsHtmlFormat', () => {
        const oldHtml = '<div><p>Hello</p></div>';
        const newHtml = '<div><p>World</p></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.format).toBe('html');
      });

      it('given_jsonContent_detectsJsonFormat', () => {
        const oldJson = '{"key": "value1"}';
        const newJson = '{"key": "value2"}';
        const result = diffContent(oldJson, newJson);

        expect(result.format).toBe('json');
      });

      it('given_tiptapContent_detectsTiptapFormat', () => {
        const oldTiptap = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
        const newTiptap = JSON.stringify({ type: 'doc', content: [{ type: 'heading' }] });
        const result = diffContent(oldTiptap, newTiptap);

        expect(result.format).toBe('tiptap');
      });

      it('given_explicitFormatOption_usesProvidedFormat', () => {
        const result = diffContent('Hello', 'World', { format: 'html' });

        expect(result.format).toBe('html');
      });
    });

    describe('HTML diffing', () => {
      it('given_htmlWithTextChange_detectsNonIdentical', () => {
        const oldHtml = '<div><p>Hello World</p></div>';
        const newHtml = '<div><p>Hello There</p></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.format).toBe('html');
        expect(result.isIdentical).toBe(false);
      });

      it('given_nestedHtmlChange_reportsExactAdditions', () => {
        const oldHtml = '<div><span>Text</span></div>';
        const newHtml = '<div><span><strong>Text</strong></span></div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(21);
      });

      it('given_attributeChange_detectsNonIdentical', () => {
        const oldHtml = '<div class="old">Content</div>';
        const newHtml = '<div class="new">Content</div>';
        const result = diffContent(oldHtml, newHtml);

        expect(result.isIdentical).toBe(false);
      });
    });

    describe('JSON diffing', () => {
      it('given_jsonValueChange_detectsNonIdentical', () => {
        const oldJson = JSON.stringify({ name: 'John', age: 30 });
        const newJson = JSON.stringify({ name: 'John', age: 31 });
        const result = diffContent(oldJson, newJson);

        expect(result.format).toBe('json');
        expect(result.isIdentical).toBe(false);
      });

      it('given_nestedJsonChange_detectsNonIdentical', () => {
        const oldJson = JSON.stringify({ user: { name: 'John' } });
        const newJson = JSON.stringify({ user: { name: 'Jane' } });
        const result = diffContent(oldJson, newJson);

        expect(result.isIdentical).toBe(false);
      });

      it('given_prettyPrintOption_detectsNonIdentical', () => {
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

      it('given_tiptapTextChange_detectsNonIdentical', () => {
        const oldDoc = createTiptapDoc(['Hello', 'World']);
        const newDoc = createTiptapDoc(['Hello', 'There']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.format).toBe('tiptap');
        expect(result.isIdentical).toBe(false);
      });

      it('given_paragraphAddition_reportsExactAdditionCount', () => {
        const oldDoc = createTiptapDoc(['Hello']);
        const newDoc = createTiptapDoc(['Hello', 'World']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(64);
        expect(result.stats.deletions).toBe(0);
      });

      it('given_paragraphDeletion_reportsExactDeletionCount', () => {
        const oldDoc = createTiptapDoc(['Hello', 'World']);
        const newDoc = createTiptapDoc(['Hello']);
        const result = diffContent(oldDoc, newDoc);

        expect(result.isIdentical).toBe(false);
        expect(result.stats.deletions).toBe(64);
        expect(result.stats.additions).toBe(0);
      });
    });

    describe('line mode', () => {
      it('given_lineModeDiff_detectsNonIdentical', () => {
        const oldText = 'Line 1\nLine 2\nLine 3';
        const newText = 'Line 1\nModified Line\nLine 3';
        const result = diffContent(oldText, newText, { lineMode: true });

        expect(result.isIdentical).toBe(false);
      });

      it('given_largeLineModeDiff_reportsExactStats', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n');
        const modifiedLines = lines.replace('Line 50', 'Modified Line 50');

        const result = diffContent(lines, modifiedLines, { lineMode: true });

        expect(result.isIdentical).toBe(false);
        expect(result.stats.additions).toBe(17);
        expect(result.stats.deletions).toBe(8);
      });
    });

    describe('timeout handling', () => {
      it('given_timeoutOption_returnsNonIdenticalResult', () => {
        const largeContent1 = 'a'.repeat(1000);
        const largeContent2 = 'b'.repeat(1000);

        const result = diffContent(largeContent1, largeContent2, { timeout: 100 });

        expect(result.isIdentical).toBe(false);
      });
    });

    describe('position tracking', () => {
      it('given_deletion_tracksOriginalPositions', () => {
        const result = diffContent('Hello World', 'Hello');

        const deleteChange = result.changes.find((c) => c.type === 'remove');
        expect(deleteChange).toEqual(expect.objectContaining({ type: 'remove' }));
        expect(deleteChange!.originalStart).toBe(5);
        expect(deleteChange!.originalEnd).toBe(11);
      });

      it('given_addition_tracksNewPositions', () => {
        const result = diffContent('Hello', 'Hello World');

        const addChange = result.changes.find((c) => c.type === 'add');
        expect(addChange).toEqual(expect.objectContaining({ type: 'add' }));
        expect(addChange!.newStart).toBe(5);
        expect(addChange!.newEnd).toBe(11);
      });

      it('given_modification_tracksUnchangedPositions', () => {
        const result = diffContent('Hello World', 'Hello There');

        const unchangedChange = result.changes.find((c) => c.type === 'unchanged');
        expect(unchangedChange).toEqual(expect.objectContaining({ type: 'unchanged' }));
        expect(unchangedChange!.originalStart).toBe(0);
        expect(unchangedChange!.originalEnd).toBe(6);
        expect(unchangedChange!.newStart).toBe(0);
        expect(unchangedChange!.newEnd).toBe(6);
      });
    });

    describe('statistics', () => {
      it('given_modification_calculatesExactStats', () => {
        const result = diffContent('Hello World', 'Hello There');

        expect(result.stats.additions).toBe(5);
        expect(result.stats.deletions).toBe(5);
        expect(result.stats.unchanged).toBe(6);
        expect(result.stats.totalChanges).toBe(
          result.changes.filter(c => c.type === 'add' || c.type === 'remove').length
        );
      });

      it('given_modification_totalChangesEquals2', () => {
        const result = diffContent('Hello World', 'Hello There');

        expect(result.stats.totalChanges).toBe(2);
      });
    });
  });

  describe('generateUnifiedDiff', () => {
    it('given_textChange_generatesUnifiedFormat', () => {
      const patch = generateUnifiedDiff('Hello World', 'Hello There');

      expect(patch).toContain('---');
      expect(patch).toContain('+++');
    });

    it('given_customLabels_includesLabelsInHeaders', () => {
      const patch = generateUnifiedDiff('Hello', 'World', 'version1.txt', 'version2.txt');

      expect(patch).toContain('--- version1.txt');
      expect(patch).toContain('+++ version2.txt');
    });

    it('given_identicalContent_generatesHeadersOnly', () => {
      const patch = generateUnifiedDiff('Hello', 'Hello');

      expect(patch).toContain('---');
      expect(patch).toContain('+++');
    });

    it('given_nullInput_returnsNonEmptyPatch', () => {
      const patch = generateUnifiedDiff(null as unknown as string, 'Hello');

      expect(typeof patch).toBe('string');
      expect(patch.length).toBe(49);
    });
  });

  describe('applyDiff', () => {
    it('given_validPatch_restoresModifiedContent', () => {
      const original = 'Hello World';
      const modified = 'Hello There';
      const patch = generateUnifiedDiff(original, modified);

      const result = applyDiff(original, patch);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('given_roundTripDiff_restoresExactContent', () => {
      const version1 = 'Line 1\nLine 2\nLine 3';
      const version2 = 'Line 1\nModified\nLine 3';

      const patch = generateUnifiedDiff(version1, version2);
      const result = applyDiff(version1, patch);

      expect(result.success).toBe(true);
      expect(result.content).toBe(version2);
    });

    it('given_invalidPatch_returnsFalseSuccess', () => {
      const result = applyDiff('Hello', 'not a valid patch');

      expect(result.success).toBe(false);
    });

    it('given_nullBaseContent_returnsSuccessWithContent', () => {
      const patch = generateUnifiedDiff('', 'Hello');
      const result = applyDiff(null as unknown as string, patch);

      expect(result.success).toBe(true);
      expect(result.content).toBeTruthy();
    });
  });

  describe('summarizeDiff', () => {
    it('given_identicalContent_returnsNoChangesMessage', () => {
      const result = diffContent('Hello', 'Hello');
      const summary = summarizeDiff(result);

      expect(summary).toBe('No changes detected');
    });

    it('given_modification_showsAdditionsAndDeletions', () => {
      const result = diffContent('Hello World', 'Hello There');
      const summary = summarizeDiff(result);

      expect(summary).toContain('+');
      expect(summary).toContain('-');
      expect(summary).toContain('characters');
    });

    it('given_additionOnly_showsOnlyAdditions', () => {
      const result = diffContent('Hello', 'Hello World');
      const summary = summarizeDiff(result);

      expect(summary).toContain('+');
      expect(summary).toContain('characters');
    });

    it('given_deletionOnly_showsOnlyDeletions', () => {
      const result = diffContent('Hello World', 'Hello');
      const summary = summarizeDiff(result);

      expect(summary).toContain('-');
      expect(summary).toContain('characters');
    });

    it('given_changes_includesPercentages', () => {
      const result = diffContent('Hello', 'Hello World');
      const summary = summarizeDiff(result);

      expect(summary).toMatch(/\d+\.\d+%/);
    });
  });

  describe('extractSections', () => {
    describe('text content', () => {
      it('given_multiParagraphText_extractsEachParagraph', () => {
        const content = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3';
        const sections = extractSections(content);

        expect(sections).toHaveLength(3);
        expect(sections[0].content).toBe('Paragraph 1');
        expect(sections[1].content).toBe('Paragraph 2');
        expect(sections[2].content).toBe('Paragraph 3');
      });

      it('given_singleParagraph_returnsSingleSection', () => {
        const sections = extractSections('Just one paragraph');

        expect(sections).toHaveLength(1);
        expect(sections[0].content).toBe('Just one paragraph');
      });

      it('given_emptyContent_returnsNoSections', () => {
        const sections = extractSections('');

        expect(sections).toHaveLength(0);
      });

      it('given_whitespaceOnly_returnsNoSections', () => {
        const sections = extractSections('   \n\n   ');

        expect(sections).toHaveLength(0);
      });

      it('given_multipleParagraphs_assignsUniqueIds', () => {
        const content = 'Para 1\n\nPara 2\n\nPara 3';
        const sections = extractSections(content);

        const ids = sections.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      });
    });

    describe('tiptap content', () => {
      it('given_tiptapDoc_extractsNodesWithTypes', () => {
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

      it('given_emptyTiptapDoc_returnsNoSections', () => {
        const tiptapDoc = JSON.stringify({ type: 'doc', content: [] });
        const sections = extractSections(tiptapDoc);

        expect(sections).toHaveLength(0);
      });

      it('given_invalidJson_fallsBackToTextExtraction', () => {
        const sections = extractSections('not valid json');

        expect(sections).toHaveLength(1);
        expect(sections[0].type).toBe('paragraph');
      });

      it('given_tiptapDocWithoutContentArray_returnsNoSections', () => {
        const tiptapDoc = JSON.stringify({ type: 'doc' });
        const sections = extractSections(tiptapDoc);

        expect(sections).toHaveLength(0);
      });

      it('given_tiptapDocWithNonArrayContent_returnsNoSections', () => {
        const tiptapDoc = JSON.stringify({ type: 'doc', content: 'not-an-array' });
        const sections = extractSections(tiptapDoc);

        expect(sections).toHaveLength(0);
      });
    });

    describe('HTML content', () => {
      it('given_htmlWithDoubleNewlines_splitsByParagraphs', () => {
        const html = '<div>Para 1</div>\n\n<div>Para 2</div>';
        const sections = extractSections(html);

        expect(sections).toHaveLength(2);
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

    it('given_addedNode_detectsAddWithCorrectNodeType', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([
        { type: 'paragraph', text: 'Hello' },
        { type: 'paragraph', text: 'World' },
      ]);

      const changes = diffTiptapNodes(oldDoc, newDoc);
      const addedChange = changes.find((c) => c.type === 'add');

      expect(addedChange).toEqual(expect.objectContaining({ type: 'add', nodeType: 'paragraph' }));
    });

    it('given_removedNode_detectsRemoveWithCorrectNodeType', () => {
      const oldDoc = createDoc([
        { type: 'paragraph', text: 'Hello' },
        { type: 'paragraph', text: 'World' },
      ]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);
      const removedChange = changes.find((c) => c.type === 'remove');

      expect(removedChange).toEqual(expect.objectContaining({ type: 'remove', nodeType: 'paragraph' }));
    });

    it('given_modifiedNode_detectsModifyWithCorrectNodeType', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'World' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);
      const modifiedChange = changes.find((c) => c.type === 'modify');

      expect(modifiedChange).toEqual(expect.objectContaining({ type: 'modify', nodeType: 'paragraph' }));
    });

    it('given_identicalDocs_allChangesAreUnchanged', () => {
      const doc = createDoc([{ type: 'paragraph', text: 'Hello' }]);

      const changes = diffTiptapNodes(doc, doc);

      expect(changes.every((c) => c.type === 'unchanged')).toBe(true);
    });

    it('given_nodeTypeChange_reportsNewNodeType', () => {
      const oldDoc = createDoc([{ type: 'heading', text: 'Title' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'Title' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes[0].nodeType).toBe('paragraph');
    });

    it('given_modification_includesContentPath', () => {
      const oldDoc = createDoc([{ type: 'paragraph', text: 'Hello' }]);
      const newDoc = createDoc([{ type: 'paragraph', text: 'World' }]);

      const changes = diffTiptapNodes(oldDoc, newDoc);

      expect(changes[0].path).toBe('content[0]');
    });

    it('given_emptyDocuments_returnsNoChanges', () => {
      const emptyDoc = JSON.stringify({ type: 'doc', content: [] });
      const changes = diffTiptapNodes(emptyDoc, emptyDoc);

      expect(changes).toHaveLength(0);
    });

    it('given_nullInput_returnsSingleModifyChange', () => {
      const changes = diffTiptapNodes(null as unknown as string, 'invalid');

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('modify');
    });

    it('given_invalidJson_returnsSingleModifyChange', () => {
      const changes = diffTiptapNodes('not json', 'also not json');

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe('modify');
    });
  });

  describe('edge cases', () => {
    it('given_veryLongContent_detectsNonIdentical', () => {
      const longContent = 'a'.repeat(100000);
      const modifiedContent = longContent.substring(0, 50000) + 'X' + longContent.substring(50001);

      const result = diffContent(longContent, modifiedContent);

      expect(result.isIdentical).toBe(false);
    });

    it('given_specialCharacters_detectsNonIdentical', () => {
      const content1 = 'Hello\t\n\rWorld';
      const content2 = 'Hello\t\n\rThere';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
    });

    it('given_unicodeCharacters_reportsExactStats', () => {
      const content1 = '你好世界';
      const content2 = '你好宇宙';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
      expect(result.stats.additions).toBe(2);
      expect(result.stats.deletions).toBe(2);
    });

    it('given_emojiContent_detectsNonIdentical', () => {
      const content1 = 'Hello 🌍 World';
      const content2 = 'Hello 🌎 World';

      const result = diffContent(content1, content2);

      expect(result.isIdentical).toBe(false);
    });

    it('given_mixedNewlineStyles_handlesGracefully', () => {
      const content1 = 'Line 1\nLine 2\r\nLine 3';
      const content2 = 'Line 1\r\nLine 2\nLine 3';

      const result = diffContent(content1, content2);

      expect(typeof result.isIdentical).toBe('boolean');
    });
  });

  describe('integration', () => {
    it('given_fullWorkflow_diffPatchAndVerifyRoundTrip', () => {
      const original = 'The quick brown fox\njumps over\nthe lazy dog';
      const modified = 'The quick red fox\nleaps over\nthe lazy cat';

      const diffResult = diffContent(original, modified);
      expect(diffResult.isIdentical).toBe(false);

      const patch = generateUnifiedDiff(original, modified);

      const applied = applyDiff(original, patch);
      expect(applied.success).toBe(true);
      expect(applied.content).toBe(modified);

      const summary = summarizeDiff(diffResult);
      expect(summary).toContain('characters');
    });

    it('given_tiptapSelectiveRollback_detectsExactModifiedAndUnchangedNodes', () => {
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

      const sections1 = extractSections(version1);
      const sections2 = extractSections(version2);

      expect(sections1).toHaveLength(3);
      expect(sections2).toHaveLength(3);

      const nodeChanges = diffTiptapNodes(version1, version2);

      const modifiedNodes = nodeChanges.filter((c) => c.type === 'modify');
      expect(modifiedNodes).toHaveLength(2);

      const unchangedNodes = nodeChanges.filter((c) => c.type === 'unchanged');
      expect(unchangedNodes).toHaveLength(1);
    });
  });

  describe('summarizeDiff edge cases', () => {
    it('given_zeroAdditionsAndDeletionsButNotIdentical_returnsNoSignificantChanges', () => {
      const result = summarizeDiff({
        format: 'text',
        changes: [],
        stats: { additions: 0, deletions: 0, unchanged: 100, totalChanges: 0 },
        isIdentical: false,
      });

      expect(result).toBe('No significant changes');
    });
  });

  describe('extractSections edge cases', () => {
    it('given_brokenJsonDetectedAsJson_fallsBackToTextSections', () => {
      const brokenJson = '{"type": "doc", invalid json here';
      const sections = extractSections(brokenJson);
      expect(sections).toHaveLength(1);
    });

    it('given_tiptapDocWithoutContent_returnsEmptySections', () => {
      const docWithoutContent = JSON.stringify({ type: 'doc' });
      const sections = extractSections(docWithoutContent);
      expect(sections).toEqual([]);
    });

    it('given_tiptapDocWithNonArrayContent_returnsEmptySections', () => {
      const docWithBadContent = JSON.stringify({ type: 'doc', content: 'not-an-array' });
      const sections = extractSections(docWithBadContent);
      expect(sections).toEqual([]);
    });
  });

  describe('diffContent prettyPrint fallback', () => {
    it('given_prettyPrintWithInvalidJson_fallsBackToRawDiff', () => {
      const oldContent = '{"valid": true}';
      const newContent = '{"valid": true, broken}';

      const result = diffContent(oldContent, newContent, { prettyPrint: true });

      expect(result.isIdentical).toBe(false);
      expect(result.changes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
