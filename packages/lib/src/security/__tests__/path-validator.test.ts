import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolvePathWithin,
  resolvePathWithinSync,
  validateFilename,
  isPathWithinBase,
} from '../path-validator';

describe('Path Validator - Traversal Prevention', () => {
  let testBaseDir: string;

  beforeEach(async () => {
    // Create a secure temporary test directory using mkdtemp
    testBaseDir = await fs.mkdtemp(join(tmpdir(), 'path-validator-test-'));
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('resolvePathWithin (async)', () => {
    describe('basic path resolution', () => {
      it('allows valid relative paths', async () => {
        const result = await resolvePathWithin(testBaseDir, 'subdir/file.txt');
        expect(result).toBe(join(testBaseDir, 'subdir/file.txt'));
      });

      it('allows simple filenames', async () => {
        const result = await resolvePathWithin(testBaseDir, 'file.txt');
        expect(result).toBe(join(testBaseDir, 'file.txt'));
      });

      it('allows nested paths', async () => {
        const result = await resolvePathWithin(testBaseDir, 'a/b/c/d.txt');
        expect(result).toBe(join(testBaseDir, 'a/b/c/d.txt'));
      });
    });

    describe('blocks directory traversal', () => {
      it('blocks ../etc/passwd', async () => {
        const result = await resolvePathWithin(testBaseDir, '../etc/passwd');
        expect(result).toBeNull();
      });

      it('blocks ../../etc/passwd', async () => {
        const result = await resolvePathWithin(testBaseDir, '../../etc/passwd');
        expect(result).toBeNull();
      });

      it('blocks multiple traversal levels', async () => {
        const result = await resolvePathWithin(testBaseDir, '../../../../../../../etc/passwd');
        expect(result).toBeNull();
      });

      it('blocks traversal in middle of path', async () => {
        const result = await resolvePathWithin(testBaseDir, 'subdir/../../../etc/passwd');
        expect(result).toBeNull();
      });

      it('blocks Windows-style traversal', async () => {
        const result = await resolvePathWithin(testBaseDir, '..\\..\\etc\\passwd');
        expect(result).toBeNull();
      });

      it('blocks dot segment (.)', async () => {
        const result = await resolvePathWithin(testBaseDir, './../../etc/passwd');
        expect(result).toBeNull();
      });
    });

    describe('blocks URL-encoded traversal', () => {
      it('blocks single-encoded ../', async () => {
        // %2e = . and %2f = /
        const result = await resolvePathWithin(testBaseDir, '%2e%2e%2fetc%2fpasswd');
        expect(result).toBeNull();
      });

      it('blocks single-encoded with mixed case', async () => {
        const result = await resolvePathWithin(testBaseDir, '%2E%2E%2Fetc/passwd');
        expect(result).toBeNull();
      });

      it('blocks single-encoded with partial encoding', async () => {
        const result = await resolvePathWithin(testBaseDir, '..%2fetc%2fpasswd');
        expect(result).toBeNull();
      });
    });

    describe('blocks double-encoded traversal', () => {
      it('blocks double-encoded ../', async () => {
        // %252e = %2e (after first decode) = . (after second decode)
        const result = await resolvePathWithin(testBaseDir, '%252e%252e%252fetc%252fpasswd');
        expect(result).toBeNull();
      });

      it('blocks mixed double and single encoding', async () => {
        const result = await resolvePathWithin(testBaseDir, '%252e%2e/etc/passwd');
        expect(result).toBeNull();
      });
    });

    describe('blocks triple-encoded traversal', () => {
      it('blocks triple-encoded ../', async () => {
        // %25252e = %252e -> %2e -> .
        const result = await resolvePathWithin(testBaseDir, '%25252e%25252e%25252f');
        expect(result).toBeNull();
      });
    });

    describe('blocks null byte injection', () => {
      it('blocks null byte in path', async () => {
        const result = await resolvePathWithin(testBaseDir, 'file.txt\x00.jpg');
        expect(result).toBe(join(testBaseDir, 'file.txt.jpg'));
      });

      it('blocks encoded null byte', async () => {
        const result = await resolvePathWithin(testBaseDir, 'file.txt%00.jpg');
        expect(result).toBe(join(testBaseDir, 'file.txt.jpg'));
      });

      it('blocks null byte with traversal', async () => {
        const result = await resolvePathWithin(testBaseDir, '../etc/passwd\x00.txt');
        expect(result).toBeNull();
      });
    });

    describe('blocks absolute paths', () => {
      it('blocks Unix absolute paths', async () => {
        const result = await resolvePathWithin(testBaseDir, '/etc/passwd');
        expect(result).toBeNull();
      });

      it('blocks Windows absolute paths', async () => {
        const result = await resolvePathWithin(testBaseDir, 'C:\\Windows\\System32');
        expect(result).toBeNull();
      });

      it('blocks UNC paths', async () => {
        const result = await resolvePathWithin(testBaseDir, '\\\\server\\share');
        expect(result).toBeNull();
      });
    });

    describe('blocks symlink escape', async () => {
      it('blocks symlink pointing outside base', async () => {
        // Create test directory structure
        await fs.mkdir(join(testBaseDir, 'subdir'), { recursive: true });

        // Create a symlink that points outside the base directory
        const symlinkPath = join(testBaseDir, 'subdir', 'escape');
        try {
          await fs.symlink('/tmp', symlinkPath);

          // Attempt to access through symlink
          const result = await resolvePathWithin(testBaseDir, 'subdir/escape/somefile');
          expect(result).toBeNull();
        } finally {
          // Clean up symlink
          try {
            await fs.unlink(symlinkPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it('allows symlink within base directory', async () => {
        // Create test directory structure
        await fs.mkdir(join(testBaseDir, 'target'), { recursive: true });
        await fs.writeFile(join(testBaseDir, 'target', 'file.txt'), 'test');

        // Create symlink within base
        const symlinkPath = join(testBaseDir, 'link');
        try {
          await fs.symlink(join(testBaseDir, 'target'), symlinkPath);

          const result = await resolvePathWithin(testBaseDir, 'link/file.txt');
          expect(result).not.toBeNull();
        } finally {
          try {
            await fs.unlink(symlinkPath);
          } catch {
            // Ignore
          }
        }
      });

      it('blocks symlink ancestor escape when nested dirs do not exist', async () => {
        // Attack scenario: symlink exists as ancestor, nested path doesn't exist
        // Base: testBaseDir
        // Symlink: testBaseDir/link -> /tmp (escapes base)
        // User path: link/newdir/file.txt (newdir doesn't exist)
        // Without proper ancestor checking, this could escape to /tmp/newdir/file.txt

        const symlinkPath = join(testBaseDir, 'link');
        try {
          await fs.symlink('/tmp', symlinkPath);

          // Request nested path where parent doesn't exist
          const result = await resolvePathWithin(testBaseDir, 'link/newdir/file.txt');
          expect(result).toBeNull();
        } finally {
          try {
            await fs.unlink(symlinkPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it('blocks deeply nested symlink ancestor escape', async () => {
        // Create nested structure with symlink escape in the middle
        await fs.mkdir(join(testBaseDir, 'level1'), { recursive: true });
        const symlinkPath = join(testBaseDir, 'level1', 'escape');

        try {
          await fs.symlink('/tmp', symlinkPath);

          // Request path through symlink with non-existent nested dirs
          const result = await resolvePathWithin(
            testBaseDir,
            'level1/escape/level2/level3/file.txt'
          );
          expect(result).toBeNull();
        } finally {
          try {
            await fs.unlink(symlinkPath);
          } catch {
            // Ignore
          }
        }
      });
    });

    describe('handles invalid inputs', () => {
      it('returns null for empty base', async () => {
        const result = await resolvePathWithin('', 'file.txt');
        expect(result).toBeNull();
      });

      it('returns null for empty path', async () => {
        const result = await resolvePathWithin(testBaseDir, '');
        expect(result).toBeNull();
      });

      it('returns null for null-like inputs', async () => {
        const result = await resolvePathWithin(testBaseDir, null as unknown as string);
        expect(result).toBeNull();
      });

      it('returns null for undefined inputs', async () => {
        const result = await resolvePathWithin(testBaseDir, undefined as unknown as string);
        expect(result).toBeNull();
      });

      it('returns null for malformed encoding', async () => {
        // Invalid percent-encoding
        const result = await resolvePathWithin(testBaseDir, '%ZZ');
        expect(result).toBeNull();
      });
    });

    describe('allows valid paths for non-existent files', () => {
      it('allows path to new file in existing directory', async () => {
        const result = await resolvePathWithin(testBaseDir, 'newfile.txt');
        expect(result).toBe(join(testBaseDir, 'newfile.txt'));
      });

      it('allows path to new file in new subdirectory', async () => {
        const result = await resolvePathWithin(testBaseDir, 'newdir/newfile.txt');
        expect(result).not.toBeNull();
      });
    });
  });

  describe('resolvePathWithinSync', () => {
    it('allows valid paths', () => {
      const result = resolvePathWithinSync(testBaseDir, 'subdir', 'file.txt');
      expect(result).toBe(join(testBaseDir, 'subdir', 'file.txt'));
    });

    it('blocks traversal in segments', () => {
      const result = resolvePathWithinSync(testBaseDir, '..', 'etc', 'passwd');
      expect(result).toBeNull();
    });

    it('blocks encoded traversal', () => {
      const result = resolvePathWithinSync(testBaseDir, '%2e%2e', 'etc');
      expect(result).toBeNull();
    });

    it('blocks double-encoded traversal', () => {
      const result = resolvePathWithinSync(testBaseDir, '%252e%252e');
      expect(result).toBeNull();
    });

    it('blocks null bytes', () => {
      const result = resolvePathWithinSync(testBaseDir, 'file\x00.txt');
      // Null bytes are removed, so this should succeed
      expect(result).toBe(join(testBaseDir, 'file.txt'));
    });

    it('blocks absolute paths in segments', () => {
      const result = resolvePathWithinSync(testBaseDir, '/etc/passwd');
      expect(result).toBeNull();
    });

    it('skips empty segments', () => {
      const result = resolvePathWithinSync(testBaseDir, '', 'file.txt', '');
      expect(result).toBe(join(testBaseDir, 'file.txt'));
    });

    it('returns null for empty base', () => {
      const result = resolvePathWithinSync('', 'file.txt');
      expect(result).toBeNull();
    });
  });

  describe('validateFilename', () => {
    it('allows valid filenames', () => {
      expect(validateFilename('document.pdf')).toBe('document.pdf');
      expect(validateFilename('image.png')).toBe('image.png');
      expect(validateFilename('file-name_123.txt')).toBe('file-name_123.txt');
    });

    it('rejects filenames with path separators', () => {
      expect(validateFilename('path/file.txt')).toBeNull();
      expect(validateFilename('path\\file.txt')).toBeNull();
    });

    it('rejects dot segments', () => {
      expect(validateFilename('.')).toBeNull();
      expect(validateFilename('..')).toBeNull();
    });

    it('rejects empty filenames', () => {
      expect(validateFilename('')).toBeNull();
      expect(validateFilename('   ')).toBeNull();
    });

    it('decodes URL-encoded filenames', () => {
      expect(validateFilename('file%20name.txt')).toBe('file name.txt');
    });

    it('removes null bytes', () => {
      expect(validateFilename('file\x00name.txt')).toBe('filename.txt');
    });

    it('handles encoded traversal attempts', () => {
      // These contain path separators after decoding
      expect(validateFilename('%2e%2e%2fpasswd')).toBeNull();
    });

    it('rejects malformed encoding', () => {
      expect(validateFilename('%ZZ')).toBeNull();
    });

    it('rejects null/undefined inputs', () => {
      expect(validateFilename(null as unknown as string)).toBeNull();
      expect(validateFilename(undefined as unknown as string)).toBeNull();
    });
  });

  describe('isPathWithinBase', () => {
    it('returns true for valid paths', () => {
      expect(isPathWithinBase(testBaseDir, 'file.txt')).toBe(true);
      expect(isPathWithinBase(testBaseDir, 'subdir/file.txt')).toBe(true);
    });

    it('returns false for traversal paths', () => {
      expect(isPathWithinBase(testBaseDir, '../etc/passwd')).toBe(false);
      expect(isPathWithinBase(testBaseDir, '../../etc/passwd')).toBe(false);
    });

    it('returns false for encoded traversal', () => {
      expect(isPathWithinBase(testBaseDir, '%2e%2e/etc')).toBe(false);
      expect(isPathWithinBase(testBaseDir, '%252e%252e/etc')).toBe(false);
    });

    it('returns false for absolute paths', () => {
      expect(isPathWithinBase(testBaseDir, '/etc/passwd')).toBe(false);
    });

    it('returns false for empty inputs', () => {
      expect(isPathWithinBase('', 'file.txt')).toBe(false);
      expect(isPathWithinBase(testBaseDir, '')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles unicode in paths', async () => {
      const result = await resolvePathWithin(testBaseDir, '文档/файл.txt');
      expect(result).toBe(join(testBaseDir, '文档/файл.txt'));
    });

    it('handles spaces in paths', async () => {
      const result = await resolvePathWithin(testBaseDir, 'my documents/file.txt');
      expect(result).toBe(join(testBaseDir, 'my documents/file.txt'));
    });

    it('handles encoded spaces', async () => {
      const result = await resolvePathWithin(testBaseDir, 'my%20documents/file.txt');
      expect(result).toBe(join(testBaseDir, 'my documents/file.txt'));
    });

    it('handles plus signs (not space encoded)', async () => {
      const result = await resolvePathWithin(testBaseDir, 'file+name.txt');
      expect(result).toBe(join(testBaseDir, 'file+name.txt'));
    });

    it('prevents path that resolves equal to base but with traversal', async () => {
      // subdir/../ resolves to base, which should be allowed
      await fs.mkdir(join(testBaseDir, 'subdir'), { recursive: true });
      const result = await resolvePathWithin(testBaseDir, 'subdir/../file.txt');
      // This contains .. so should be blocked
      expect(result).toBeNull();
    });

    it('handles consecutive slashes', async () => {
      const result = await resolvePathWithin(testBaseDir, 'subdir//file.txt');
      expect(result).not.toBeNull();
    });
  });

  describe('handles filesystem root as base', () => {
    it('allows valid paths under root base', async () => {
      // Use /tmp as a safe existing directory
      const result = await resolvePathWithin('/', 'tmp');
      expect(result).toBe('/tmp');
    });

    it('allows nested paths under root base', async () => {
      // The key is it shouldn't be rejected due to double-separator bug
      // /tmp exists on macOS/Linux systems
      const result = await resolvePathWithin('/', 'tmp/subdir');
      expect(result).toBe('/tmp/subdir');
    });

    it('still blocks traversal with root base', async () => {
      const result = await resolvePathWithin('/', '../etc/passwd');
      expect(result).toBeNull();
    });
  });

  describe('attack vectors from OWASP', () => {
    const attacks = [
      '../etc/passwd',
      '..\\etc\\passwd',
      '....//....//etc/passwd',
      '..%252f..%252f..%252fetc/passwd',
      '%2e%2e%2f%2e%2e%2f',
      '..%00/etc/passwd',
      '..%c0%af',
      '..%c1%9c',
      '.../....//etc/passwd',
      '....\\....\\etc\\passwd',
    ];

    for (const attack of attacks) {
      it(`blocks attack: ${JSON.stringify(attack)}`, async () => {
        const result = await resolvePathWithin(testBaseDir, attack);
        // Should either be null (blocked) or not escape base
        if (result !== null) {
          expect(result.startsWith(testBaseDir)).toBe(true);
          expect(result).not.toContain('/etc/passwd');
        }
      });
    }
  });
});
