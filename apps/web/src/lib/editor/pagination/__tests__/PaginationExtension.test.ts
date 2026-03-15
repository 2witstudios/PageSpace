/**
 * Unit tests for PaginationExtension.
 *
 * All TipTap / ProseMirror dependencies are fully mocked.
 * Extension.create() is called at module-load time, so we capture the config
 * object and exercise its methods directly with synthetic `this` contexts.
 */
import { describe, it, expect, vi } from 'vitest';

// vi.hoisted runs in the hoisted scope alongside vi.mock factories
const shared = vi.hoisted(() => ({
  capturedConfig: null as Record<string, (...args: unknown[]) => unknown> | null,
  commandContext: null as { options: Record<string, unknown> } | null,
}));

// vi.mock() calls MUST come before other imports
vi.mock('@tiptap/core', () => ({
  Extension: {
    create(config: Record<string, unknown>) {
      shared.capturedConfig = config as Record<string, (...args: unknown[]) => unknown>;

      const options =
        typeof config.addOptions === 'function' ? config.addOptions() : {};
      const storage =
        typeof config.addStorage === 'function' ? config.addStorage() : {};

      // Build commands with a fake mutable options context
      let commands: Record<string, unknown> = {};
      shared.commandContext = { options: { ...(options as object) } };
      if (typeof config.addCommands === 'function') {
        commands = config.addCommands.call(shared.commandContext);
      }

      return {
        name: config.name,
        options,
        storage,
        commands,
        configure: vi.fn(),
      };
    },
  },
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
  return { Plugin: mockPlugin, PluginKey: mockPluginKey, EditorState: {} };
});

vi.mock('@tiptap/pm/view', () => ({
  Decoration: {
    widget: vi.fn().mockReturnValue({ type: 'widget' }),
    inline: vi.fn(),
  },
  DecorationSet: {
    empty: [],
    create: vi.fn().mockReturnValue({ type: 'decoSet' }),
  },
  EditorView: {},
}));

vi.mock('../utils', () => ({
  updateCssVariables: vi.fn(),
}));

vi.mock('../constants', () => ({}));

import { Plugin } from '@tiptap/pm/state';
import { PaginationPlus } from '../PaginationExtension';

// Helper type for the extension returned by our mock
interface MockedExtension {
  name: string;
  options: Record<string, unknown>;
  storage: Record<string, unknown>;
  commands: Record<string, (...args: unknown[]) => () => boolean>;
}

const ext = PaginationPlus as unknown as MockedExtension;

function config() {
  if (!shared.capturedConfig) throw new Error('capturedConfig was not set');
  return shared.capturedConfig;
}

function cmdCtx() {
  if (!shared.commandContext) throw new Error('commandContext was not set');
  return shared.commandContext;
}

describe('PaginationExtension', () => {
  describe('extension definition', () => {
    it('should be defined', () => {
      expect(PaginationPlus).toBeDefined();
    });

    it('should have the name "PaginationPlus"', () => {
      expect(ext.name).toBe('PaginationPlus');
    });

    it('should have captured the config via Extension.create', () => {
      expect(shared.capturedConfig).toBeDefined();
      expect(typeof config().addOptions).toBe('function');
      expect(typeof config().addStorage).toBe('function');
      expect(typeof config().addCommands).toBe('function');
      expect(typeof config().addProseMirrorPlugins).toBe('function');
      expect(typeof config().onCreate).toBe('function');
    });
  });

  describe('default options (addOptions)', () => {
    it('should set pageHeight to 800', () => {
      expect(ext.options.pageHeight).toBe(800);
    });

    it('should set pageWidth to 789', () => {
      expect(ext.options.pageWidth).toBe(789);
    });

    it('should set pageGap to 50', () => {
      expect(ext.options.pageGap).toBe(50);
    });

    it('should set pageGapBorderSize to 1', () => {
      expect(ext.options.pageGapBorderSize).toBe(1);
    });

    it('should set pageBreakBackground to #ffffff', () => {
      expect(ext.options.pageBreakBackground).toBe('#ffffff');
    });

    it('should set pageHeaderHeight to 30', () => {
      expect(ext.options.pageHeaderHeight).toBe(30);
    });

    it('should set pageFooterHeight to 30', () => {
      expect(ext.options.pageFooterHeight).toBe(30);
    });

    it('should set margin defaults', () => {
      expect(ext.options.marginTop).toBe(20);
      expect(ext.options.marginBottom).toBe(20);
      expect(ext.options.marginLeft).toBe(50);
      expect(ext.options.marginRight).toBe(50);
    });

    it('should set content margin defaults', () => {
      expect(ext.options.contentMarginTop).toBe(10);
      expect(ext.options.contentMarginBottom).toBe(10);
    });

    it('should set footer defaults', () => {
      expect(ext.options.footerRight).toBe('{page}');
      expect(ext.options.footerLeft).toBe('');
    });

    it('should set header defaults', () => {
      expect(ext.options.headerRight).toBe('');
      expect(ext.options.headerLeft).toBe('');
    });

    it('should set pageGapBorderColor to #e5e5e5', () => {
      expect(ext.options.pageGapBorderColor).toBe('#e5e5e5');
    });
  });

  describe('storage (addStorage)', () => {
    it('should initialize storage with the same values as default options', () => {
      expect(ext.storage).toEqual(ext.options);
    });
  });

  describe('addCommands', () => {
    it('should define all 11 expected commands', () => {
      const expectedCommands = [
        'updatePageBreakBackground',
        'updatePageSize',
        'updatePageHeight',
        'updatePageWidth',
        'updatePageGap',
        'updateMargins',
        'updateContentMargins',
        'updateHeaderHeight',
        'updateFooterHeight',
        'updateHeaderContent',
        'updateFooterContent',
      ];
      for (const cmd of expectedCommands) {
        expect(ext.commands).toHaveProperty(cmd);
        expect(typeof ext.commands[cmd]).toBe('function');
      }
    });

    describe('updatePageBreakBackground', () => {
      it('should mutate pageBreakBackground and return true', () => {
        const result = ext.commands.updatePageBreakBackground('#000000')();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageBreakBackground).toBe('#000000');
      });
    });

    describe('updatePageSize', () => {
      it('should set all page dimension fields from PageSize object', () => {
        const size = {
          pageHeight: 1123,
          pageWidth: 794,
          marginTop: 95,
          marginBottom: 95,
          marginLeft: 76,
          marginRight: 76,
        };
        const result = ext.commands.updatePageSize(size)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageHeight).toBe(1123);
        expect(cmdCtx().options.pageWidth).toBe(794);
        expect(cmdCtx().options.marginTop).toBe(95);
        expect(cmdCtx().options.marginBottom).toBe(95);
        expect(cmdCtx().options.marginLeft).toBe(76);
        expect(cmdCtx().options.marginRight).toBe(76);
      });
    });

    describe('updatePageWidth', () => {
      it('should mutate pageWidth and return true', () => {
        const result = ext.commands.updatePageWidth(900)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageWidth).toBe(900);
      });
    });

    describe('updatePageHeight', () => {
      it('should mutate pageHeight and return true', () => {
        const result = ext.commands.updatePageHeight(1200)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageHeight).toBe(1200);
      });
    });

    describe('updatePageGap', () => {
      it('should mutate pageGap and return true', () => {
        const result = ext.commands.updatePageGap(80)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageGap).toBe(80);
      });
    });

    describe('updateMargins', () => {
      it('should set all four margin fields and return true', () => {
        const margins = { top: 30, bottom: 40, left: 60, right: 70 };
        const result = ext.commands.updateMargins(margins)();
        expect(result).toBe(true);
        expect(cmdCtx().options.marginTop).toBe(30);
        expect(cmdCtx().options.marginBottom).toBe(40);
        expect(cmdCtx().options.marginLeft).toBe(60);
        expect(cmdCtx().options.marginRight).toBe(70);
      });
    });

    describe('updateContentMargins', () => {
      it('should set content margins and return true', () => {
        const margins = { top: 15, bottom: 25 };
        const result = ext.commands.updateContentMargins(margins)();
        expect(result).toBe(true);
        expect(cmdCtx().options.contentMarginTop).toBe(15);
        expect(cmdCtx().options.contentMarginBottom).toBe(25);
      });
    });

    describe('updateHeaderHeight', () => {
      it('should mutate pageHeaderHeight and return true', () => {
        const result = ext.commands.updateHeaderHeight(50)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageHeaderHeight).toBe(50);
      });
    });

    describe('updateFooterHeight', () => {
      it('should mutate pageFooterHeight and return true', () => {
        const result = ext.commands.updateFooterHeight(45)();
        expect(result).toBe(true);
        expect(cmdCtx().options.pageFooterHeight).toBe(45);
      });
    });

    describe('updateHeaderContent', () => {
      it('should set headerLeft and headerRight and return true', () => {
        const result = ext.commands.updateHeaderContent('Left', 'Right')();
        expect(result).toBe(true);
        expect(cmdCtx().options.headerLeft).toBe('Left');
        expect(cmdCtx().options.headerRight).toBe('Right');
      });
    });

    describe('updateFooterContent', () => {
      it('should set footerLeft and footerRight and return true', () => {
        const result = ext.commands.updateFooterContent('Page {page}', 'Title')();
        expect(result).toBe(true);
        expect(cmdCtx().options.footerLeft).toBe('Page {page}');
        expect(cmdCtx().options.footerRight).toBe('Title');
      });
    });
  });

  describe('addProseMirrorPlugins', () => {
    it('should return an array of 2 plugins', () => {
      const mockView = {
        dom: document.createElement('div'),
        state: { doc: { descendants: vi.fn() } },
      };
      const result = config().addProseMirrorPlugins.call({
        editor: { view: mockView },
        options: ext.options,
        storage: { ...ext.options },
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('should create two Plugin instances', () => {
      const mockView = {
        dom: document.createElement('div'),
        state: { doc: { descendants: vi.fn() } },
      };
      const callsBefore = (Plugin as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      config().addProseMirrorPlugins.call({
        editor: { view: mockView },
        options: ext.options,
        storage: { ...ext.options },
      });
      const callsAfter = (Plugin as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter - callsBefore).toBe(2);
    });
  });

  describe('onCreate', () => {
    it('should be defined as a function in the config', () => {
      expect(typeof config().onCreate).toBe('function');
    });
  });
});
