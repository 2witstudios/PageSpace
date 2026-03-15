import { describe, it, expect, vi } from 'vitest';
import { SUDOLANG_LANGUAGE_ID, registerSudolangLanguage } from '../sudolang-language';

describe('sudolang-language', () => {
  describe('SUDOLANG_LANGUAGE_ID', () => {
    it('should be "sudolang"', () => {
      expect(SUDOLANG_LANGUAGE_ID).toBe('sudolang');
    });
  });

  describe('registerSudolangLanguage', () => {
    function createMockMonaco() {
      return {
        languages: {
          getLanguages: vi.fn(() => []),
          register: vi.fn(),
          setLanguageConfiguration: vi.fn(),
          setMonarchTokensProvider: vi.fn(),
        },
      };
    }

    it('should register the sudolang language', () => {
      const monaco = createMockMonaco();
      registerSudolangLanguage(monaco as any);

      expect(monaco.languages.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sudolang' })
      );
      expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalled();
      expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalled();
    });

    it('should not re-register on second call with same monaco instance', () => {
      const monaco = createMockMonaco();
      registerSudolangLanguage(monaco as any);
      registerSudolangLanguage(monaco as any);

      expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    });

    it('should register with different monaco instances', () => {
      const monaco1 = createMockMonaco();
      const monaco2 = createMockMonaco();
      registerSudolangLanguage(monaco1 as any);
      registerSudolangLanguage(monaco2 as any);

      expect(monaco1.languages.register).toHaveBeenCalledTimes(1);
      expect(monaco2.languages.register).toHaveBeenCalledTimes(1);
    });

    it('should skip language.register if language already exists', () => {
      const monaco = createMockMonaco();
      monaco.languages.getLanguages.mockReturnValue([{ id: 'sudolang' }]);
      registerSudolangLanguage(monaco as any);

      expect(monaco.languages.register).not.toHaveBeenCalled();
      expect(monaco.languages.setLanguageConfiguration).toHaveBeenCalled();
    });
  });
});
