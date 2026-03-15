import { describe, it, expect, beforeEach } from 'vitest';
import {
  MENTION_FORMATS,
  INPUT_TYPE_CONFIGS,
  MentionFormatter,
  MentionConfigManager,
  DEFAULT_GLOBAL_CONFIG,
} from '../mentionConfig';

describe('mentionConfig', () => {
  describe('MENTION_FORMATS', () => {
    it('should have label format that creates @label', () => {
      expect(MENTION_FORMATS.label.template('John', 'user-1')).toBe('@John');
    });

    it('should have markdown format with link', () => {
      expect(MENTION_FORMATS.markdown.template('John', 'user-1')).toBe('@[John](user-1)');
    });

    it('should have markdown-typed format with type', () => {
      expect(MENTION_FORMATS['markdown-typed'].template('Home', 'page-1', 'page')).toBe('@[Home](page-1:page)');
    });

    it('should default to page type in markdown-typed', () => {
      expect(MENTION_FORMATS['markdown-typed'].template('Home', 'page-1')).toBe('@[Home](page-1:page)');
    });
  });

  describe('INPUT_TYPE_CONFIGS', () => {
    it('should have textarea config', () => {
      expect(INPUT_TYPE_CONFIGS.textarea).toBeDefined();
      expect(INPUT_TYPE_CONFIGS.textarea.defaultFormat).toBe('markdown-typed');
    });

    it('should have richline config', () => {
      expect(INPUT_TYPE_CONFIGS.richline).toBeDefined();
      expect(INPUT_TYPE_CONFIGS.richline.defaultFormat).toBe('markdown-typed');
    });
  });

  describe('MentionFormatter', () => {
    describe('format', () => {
      it('should format with label format', () => {
        expect(MentionFormatter.format('John', 'u1', 'user', 'label')).toBe('@John');
      });

      it('should format with markdown format', () => {
        expect(MentionFormatter.format('Page', 'p1', 'page', 'markdown')).toBe('@[Page](p1)');
      });

      it('should fall back to label for unknown format', () => {
        expect(MentionFormatter.format('Test', 'id', 'user', 'unknown' as 'label')).toBe('@Test');
      });
    });

    describe('getConfigForInputType', () => {
      it('should return config for textarea', () => {
        const config = MentionFormatter.getConfigForInputType('textarea');
        expect(config.inputType).toBe('textarea');
      });

      it('should return textarea config for unknown input type', () => {
        const config = MentionFormatter.getConfigForInputType('unknown' as 'textarea');
        expect(config.inputType).toBe('textarea');
      });
    });

    describe('validateFormat', () => {
      it('should return true for supported format', () => {
        expect(MentionFormatter.validateFormat('label', 'textarea')).toBe(true);
      });

      it('should return true for markdown-typed in textarea', () => {
        expect(MentionFormatter.validateFormat('markdown-typed', 'textarea')).toBe(true);
      });
    });

    describe('getRecommendedFormat', () => {
      it('should return default format for input type', () => {
        expect(MentionFormatter.getRecommendedFormat('textarea')).toBe('markdown-typed');
      });
    });
  });

  describe('MentionConfigManager', () => {
    beforeEach(() => {
      MentionConfigManager.setGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG });
    });

    describe('setGlobalConfig / getGlobalConfig', () => {
      it('should update global config', () => {
        MentionConfigManager.setGlobalConfig({ defaultFormat: 'markdown' });
        expect(MentionConfigManager.getGlobalConfig().defaultFormat).toBe('markdown');
      });
    });

    describe('getEffectiveFormat', () => {
      it('should return input type default when enforceInputTypeDefaults is true', () => {
        MentionConfigManager.setGlobalConfig({ enforceInputTypeDefaults: true });
        const format = MentionConfigManager.getEffectiveFormat('textarea', 'label');
        expect(format).toBe('markdown-typed');
      });

      it('should honor requested format when not enforcing defaults', () => {
        MentionConfigManager.setGlobalConfig({
          enforceInputTypeDefaults: false,
          allowFormatOverride: true,
        });
        const format = MentionConfigManager.getEffectiveFormat('textarea', 'label');
        expect(format).toBe('label');
      });

      it('should fall back to input default when requested format is unsupported', () => {
        MentionConfigManager.setGlobalConfig({
          enforceInputTypeDefaults: false,
          allowFormatOverride: true,
        });
        const format = MentionConfigManager.getEffectiveFormat('textarea', 'invalid' as 'label');
        expect(format).toBe('markdown-typed');
      });

      it('should use global default when no format requested and not enforcing', () => {
        MentionConfigManager.setGlobalConfig({
          enforceInputTypeDefaults: false,
          allowFormatOverride: false,
          defaultFormat: 'markdown',
        });
        const format = MentionConfigManager.getEffectiveFormat('textarea');
        expect(format).toBe('markdown');
      });

      it('should fall back to input type default when global default is not supported', () => {
        MentionConfigManager.setGlobalConfig({
          enforceInputTypeDefaults: false,
          allowFormatOverride: false,
          defaultFormat: 'invalid' as 'label',
        });
        const format = MentionConfigManager.getEffectiveFormat('textarea');
        expect(format).toBe('markdown-typed');
      });
    });
  });
});
