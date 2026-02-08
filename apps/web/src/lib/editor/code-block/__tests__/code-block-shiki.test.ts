import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
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
    expect(CodeBlockShiki.name).toBe('codeBlock');
  });

  it('preserves language attribute in schema', () => {
    const editor = createEditor();
    const attrs = editor.schema.nodes.codeBlock.spec.attrs;
    expect(attrs).toHaveProperty('language');
    editor.destroy();
  });

  it('setCodeBlock command works with language', () => {
    const editor = createEditor('<p>hello</p>');
    editor.commands.setCodeBlock({ language: 'sudolang' });
    const json = editor.getJSON();
    const codeBlock = json.content?.find(
      (n: { type: string }) => n.type === 'codeBlock'
    );
    expect(codeBlock).toBeDefined();
    expect(codeBlock?.attrs?.language).toBe('sudolang');
    editor.destroy();
  });

  it('toggleCodeBlock command works', () => {
    const editor = createEditor('<p>hello</p>');
    editor.commands.toggleCodeBlock();
    expect(editor.isActive('codeBlock')).toBe(true);
    editor.commands.toggleCodeBlock();
    expect(editor.isActive('codeBlock')).toBe(false);
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
    expect(html).toContain('language-sudolang');
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
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
    expect(codeBlock?.attrs?.language).toBe('javascript');
    editor.destroy();
  });
});
