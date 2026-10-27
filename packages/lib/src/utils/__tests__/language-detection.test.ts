import { describe, it, expect } from 'vitest';
import {
  detectLanguageFromFilename,
  isBinaryFile,
  EXTENSION_TO_LANGUAGE,
  BINARY_EXTENSIONS,
} from '../language-detection';

describe('language-detection', () => {
  describe('detectLanguageFromFilename', () => {
    it('should detect TypeScript from .ts extension', () => {
      expect(detectLanguageFromFilename('index.ts')).toBe('typescript');
    });

    it('should detect TypeScript from .tsx extension', () => {
      expect(detectLanguageFromFilename('App.tsx')).toBe('typescript');
    });

    it('should detect JavaScript from .js extension', () => {
      expect(detectLanguageFromFilename('server.js')).toBe('javascript');
    });

    it('should detect Python from .py extension', () => {
      expect(detectLanguageFromFilename('main.py')).toBe('python');
    });

    it('should detect Rust from .rs extension', () => {
      expect(detectLanguageFromFilename('lib.rs')).toBe('rust');
    });

    it('should detect shell from .sh extension', () => {
      expect(detectLanguageFromFilename('deploy.sh')).toBe('shell');
    });

    it('should detect YAML from .yml extension', () => {
      expect(detectLanguageFromFilename('config.yml')).toBe('yaml');
    });

    it('should detect YAML from .yaml extension', () => {
      expect(detectLanguageFromFilename('docker-compose.yaml')).toBe('yaml');
    });

    it('should detect markdown from .md extension', () => {
      expect(detectLanguageFromFilename('README.md')).toBe('markdown');
    });

    it('should return plaintext for unknown extensions', () => {
      expect(detectLanguageFromFilename('Makefile.xyz')).toBe('plaintext');
    });

    it('should return plaintext for files with no extension', () => {
      expect(detectLanguageFromFilename('Makefile')).toBe('plaintext');
    });

    it('should be case-insensitive', () => {
      expect(detectLanguageFromFilename('App.TS')).toBe('typescript');
      expect(detectLanguageFromFilename('style.CSS')).toBe('css');
    });

    it('should handle dotfiles', () => {
      expect(detectLanguageFromFilename('.gitignore')).toBe('plaintext');
    });

    it('should handle multiple dots in filename', () => {
      expect(detectLanguageFromFilename('package.config.ts')).toBe('typescript');
    });

    it('should detect all mapped extensions', () => {
      for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
        expect(detectLanguageFromFilename(`test.${ext}`)).toBe(lang);
      }
    });
  });

  describe('isBinaryFile', () => {
    it('should identify PNG as binary', () => {
      expect(isBinaryFile('image.png')).toBe(true);
    });

    it('should identify JPEG as binary', () => {
      expect(isBinaryFile('photo.jpg')).toBe(true);
      expect(isBinaryFile('photo.jpeg')).toBe(true);
    });

    it('should identify ZIP as binary', () => {
      expect(isBinaryFile('archive.zip')).toBe(true);
    });

    it('should identify PDF as binary', () => {
      expect(isBinaryFile('document.pdf')).toBe(true);
    });

    it('should identify font files as binary', () => {
      expect(isBinaryFile('font.woff2')).toBe(true);
      expect(isBinaryFile('font.ttf')).toBe(true);
    });

    it('should identify executables as binary', () => {
      expect(isBinaryFile('app.exe')).toBe(true);
      expect(isBinaryFile('lib.wasm')).toBe(true);
    });

    it('should not identify TypeScript as binary', () => {
      expect(isBinaryFile('index.ts')).toBe(false);
    });

    it('should not identify JavaScript as binary', () => {
      expect(isBinaryFile('app.js')).toBe(false);
    });

    it('should not identify JSON as binary', () => {
      expect(isBinaryFile('package.json')).toBe(false);
    });

    it('should not identify markdown as binary', () => {
      expect(isBinaryFile('README.md')).toBe(false);
    });

    it('should return false for files with no extension', () => {
      expect(isBinaryFile('Makefile')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isBinaryFile('image.PNG')).toBe(true);
      expect(isBinaryFile('photo.JPG')).toBe(true);
    });

    it('should identify all registered binary extensions', () => {
      for (const ext of BINARY_EXTENSIONS) {
        expect(isBinaryFile(`test.${ext}`)).toBe(true);
      }
    });
  });
});
