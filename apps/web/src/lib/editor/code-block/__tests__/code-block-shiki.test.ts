import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { assert } from '@/test/riteway';
import { CodeBlockShiki } from '../CodeBlockShikiExtension';

function createEditor(content?: string) {
  return new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockShiki,
    ],
    content: content ?? '',
  });
}

describe('CodeBlockShiki Extension', () => {
  it('has name codeBlock', () => {
    assert({
      given: 'the CodeBlockShiki extension',
      should: 'have name "codeBlock"',
      actual: CodeBlockShiki.name,
      expected: 'codeBlock',
    });
  });

  it('preserves language attribute in schema', () => {
    const editor = createEditor();
    const attrs = editor.schema.nodes.codeBlock.spec.attrs;
    expect(attrs, 'Given schema attrs, should have language property').toHaveProperty('language');
    editor.destroy();
  });

  it('setCodeBlock command works with language', () => {
    const editor = createEditor('<p>hello</p>');
    editor.commands.setCodeBlock({ language: 'sudolang' });
    const json = editor.getJSON();
    const codeBlock = json.content?.find(
      (n: { type: string }) => n.type === 'codeBlock'
    );
    expect(codeBlock, 'Given setCodeBlock command, should create a codeBlock node').toBeDefined();
    assert({
      given: 'setCodeBlock with language sudolang',
      should: 'set the language attribute to sudolang',
      actual: codeBlock?.attrs?.language,
      expected: 'sudolang',
    });
    editor.destroy();
  });

  it('toggleCodeBlock command works', () => {
    const editor = createEditor('<p>hello</p>');
    editor.commands.toggleCodeBlock();
    assert({
      given: 'toggleCodeBlock on a paragraph',
      should: 'activate codeBlock',
      actual: editor.isActive('codeBlock'),
      expected: true,
    });
    editor.commands.toggleCodeBlock();
    assert({
      given: 'toggleCodeBlock on a codeBlock',
      should: 'deactivate codeBlock',
      actual: editor.isActive('codeBlock'),
      expected: false,
    });
    editor.destroy();
  });

  it('serializes to HTML with language class', () => {
    const editor = createEditor();
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'sudolang' },
          content: [{ type: 'text', text: 'code' }],
        },
      ],
    });
    const html = editor.getHTML();
    expect(html, 'Given sudolang codeBlock, should contain language-sudolang class').toContain('language-sudolang');
    expect(html, 'Given codeBlock, should contain <pre tag').toContain('<pre');
    expect(html, 'Given codeBlock, should contain <code tag').toContain('<code');
    editor.destroy();
  });

  it('parses HTML with language class', () => {
    const editor = createEditor(
      '<pre><code class="language-javascript">const x = 1</code></pre>'
    );
    const json = editor.getJSON();
    const codeBlock = json.content?.find(
      (n: { type: string }) => n.type === 'codeBlock'
    );
    assert({
      given: 'HTML with language-javascript class',
      should: 'parse language attribute as javascript',
      actual: codeBlock?.attrs?.language,
      expected: 'javascript',
    });
    editor.destroy();
  });
});
