/**
 * Unit tests for CodeBlockShikiExtension.
 *
 * All TipTap / ProseMirror dependencies are fully mocked.
 * The extension calls CodeBlock.extend() at module-load time, so we capture
 * the config object via the mock and exercise its methods directly.
 */
import { describe, it, expect, vi } from 'vitest';

// vi.hoisted runs in the hoisted scope alongside vi.mock factories
const shared = vi.hoisted(() => ({
  capturedConfig: null as Record<string, (...args: unknown[]) => unknown> | null,
}));

// vi.mock() calls MUST come before other imports
vi.mock('@tiptap/extension-code-block', () => ({
  default: {
    extend(config: Record<string, unknown>) {
      shared.capturedConfig = config as Record<string, (...args: unknown[]) => unknown>;
      return {
        name: 'codeBlock',
        _extensionConfig: config,
        configure: vi.fn(),
      };
    },
    name: 'codeBlock',
  },
}));

vi.mock('@tiptap/react', () => ({
  ReactNodeViewRenderer: vi.fn((component: unknown) => component),
}));

vi.mock('@tiptap/pm/state', () => {
  const mockPlugin = vi.fn().mockImplementation((spec: Record<string, unknown>) => ({
    spec,
    key: 'mockPluginInstance',
  }));
  const mockPluginKey = vi.fn().mockImplementation((name: string) => ({
    key: name,
    getState: vi.fn(),
  }));
  return { Plugin: mockPlugin, PluginKey: mockPluginKey };
});

vi.mock('@tiptap/pm/view', () => ({
  Decoration: { inline: vi.fn() },
  DecorationSet: { empty: [], create: vi.fn() },
}));

vi.mock('@tiptap/pm/model', () => ({}));

vi.mock('../shiki-highlighter', () => ({
  tokenizeCode: vi.fn().mockResolvedValue([]),
}));

vi.mock('../token-decorations', () => ({
  tokensToDecorationSpecs: vi.fn().mockReturnValue([]),
  specsToDecorations: vi.fn().mockReturnValue([]),
}));

vi.mock('../LanguageSelector', () => ({
  LanguageSelector: vi.fn(),
}));

import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { LanguageSelector } from '../LanguageSelector';
import { CodeBlockShiki } from '../CodeBlockShikiExtension';

// Non-null helper so every test doesn't need to guard
function config() {
  if (!shared.capturedConfig) throw new Error('capturedConfig was not set');
  return shared.capturedConfig;
}

describe('CodeBlockShikiExtension', () => {
  describe('extension definition', () => {
    it('should be defined', () => {
      expect(CodeBlockShiki).toBeDefined();
    });

    it('should have the name "codeBlock"', () => {
      expect(CodeBlockShiki.name).toBe('codeBlock');
    });

    it('should have captured the extension config via CodeBlock.extend', () => {
      expect(shared.capturedConfig).toBeDefined();
      expect(typeof config().addAttributes).toBe('function');
      expect(typeof config().addNodeView).toBe('function');
      expect(typeof config().addProseMirrorPlugins).toBe('function');
    });
  });

  describe('addAttributes', () => {
    function getAttrs(parentReturn: unknown = {}) {
      const parentFn = vi.fn().mockReturnValue(parentReturn);
      return config().addAttributes.call({ parent: parentFn });
    }

    it('should define a language attribute', () => {
      const attrs = getAttrs();
      expect(attrs).toHaveProperty('language');
    });

    it('should set language default to null', () => {
      const attrs = getAttrs();
      expect(attrs.language.default).toBeNull();
    });

    it('should merge parent attributes', () => {
      const attrs = getAttrs({ existingAttr: { default: 'test' } });
      expect(attrs).toHaveProperty('existingAttr');
      expect(attrs.existingAttr.default).toBe('test');
    });

    it('should handle missing parent gracefully', () => {
      const attrs = config().addAttributes.call({ parent: undefined });
      expect(attrs).toHaveProperty('language');
    });

    describe('parseHTML', () => {
      function getParseHTML() {
        return getAttrs().language.parseHTML;
      }

      it('should extract language from code child element class', () => {
        const el = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-typescript';
        el.appendChild(code);
        expect(getParseHTML()(el)).toBe('typescript');
      });

      it('should fall back to element className when no code child', () => {
        const el = document.createElement('pre');
        el.className = 'language-python';
        expect(getParseHTML()(el)).toBe('python');
      });

      it('should return null when no language class is found', () => {
        const el = document.createElement('pre');
        const code = document.createElement('code');
        el.appendChild(code);
        expect(getParseHTML()(el)).toBeNull();
      });

      it('should return null for empty class', () => {
        const el = document.createElement('pre');
        el.className = '';
        expect(getParseHTML()(el)).toBeNull();
      });

      it('should match the first language-* token', () => {
        const el = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'some-class language-rust other-class';
        el.appendChild(code);
        expect(getParseHTML()(el)).toBe('rust');
      });
    });

    describe('renderHTML', () => {
      function getRenderHTML() {
        return getAttrs().language.renderHTML;
      }

      it('should return class with language prefix when language is set', () => {
        expect(getRenderHTML()({ language: 'javascript' })).toEqual({
          class: 'language-javascript',
        });
      });

      it('should return empty object when language is null', () => {
        expect(getRenderHTML()({ language: null })).toEqual({});
      });

      it('should return empty object when language is falsy empty string', () => {
        expect(getRenderHTML()({ language: '' })).toEqual({});
      });
    });
  });

  describe('addNodeView', () => {
    it('should use ReactNodeViewRenderer with LanguageSelector', () => {
      config().addNodeView();
      expect(ReactNodeViewRenderer).toHaveBeenCalledWith(LanguageSelector);
    });
  });

  describe('addProseMirrorPlugins', () => {
    it('should return an array containing parent plugins plus highlight plugin', () => {
      const parentPlugins = [{ key: 'parent-plugin' }];
      const parentFn = vi.fn().mockReturnValue(parentPlugins);
      const plugins = config().addProseMirrorPlugins.call({ parent: parentFn });

      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins.length).toBe(2);
      expect(plugins[0]).toBe(parentPlugins[0]);
    });

    it('should handle missing parent gracefully', () => {
      const plugins = config().addProseMirrorPlugins.call({ parent: undefined });
      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins.length).toBe(1);
    });

    it('should create a Plugin via the Plugin constructor', () => {
      const callsBefore = (Plugin as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      config().addProseMirrorPlugins.call({
        parent: vi.fn().mockReturnValue([]),
      });
      const callsAfter = (Plugin as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter - callsBefore).toBe(1);
    });
  });
});
