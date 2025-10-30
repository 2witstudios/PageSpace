/**
 * Tool Name Validation Tests
 * Tests for MCP tool/server name validation and sanitization
 * Security focus: Prevent injection attacks via malicious names
 */

import { describe, it, expect } from 'vitest';
import {
  validateToolName,
  validateServerName,
  createSafeToolName,
} from '../mcp-tool-converter';

describe('MCP Tool Name Validation - Security', () => {
  describe('validateToolName', () => {
    it('should accept valid tool names', () => {
      expect(() => validateToolName('read-file')).not.toThrow();
      expect(() => validateToolName('get_user')).not.toThrow();
      expect(() => validateToolName('tool123')).not.toThrow();
      expect(() => validateToolName('TOOL-NAME')).not.toThrow();
      expect(() => validateToolName('a')).not.toThrow(); // Single char
    });

    it('should reject empty tool names', () => {
      expect(() => validateToolName('')).toThrow('Tool name cannot be empty');
    });

    it('should reject tool names with invalid characters', () => {
      // Special characters that could enable injection
      expect(() => validateToolName('tool/../etc')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool;rm -rf')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool$(whoami)')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool`ls`')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool|cat')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool&echo')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool>file')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool<input')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool\x00')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool\n')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool\r')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool\t')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool name')).toThrow('Tool name contains invalid characters'); // Space
      expect(() => validateToolName('tool.name')).toThrow('Tool name contains invalid characters'); // Period
      expect(() => validateToolName('tool/name')).toThrow('Tool name contains invalid characters'); // Slash
      expect(() => validateToolName('tool\\name')).toThrow('Tool name contains invalid characters'); // Backslash
    });

    it('should reject tool names exceeding max length', () => {
      const longName = 'a'.repeat(65); // 65 chars (max is 64)
      expect(() => validateToolName(longName)).toThrow('Tool name exceeds maximum length of 64 characters');
    });

    it('should accept tool names at max length boundary', () => {
      const maxName = 'a'.repeat(64); // Exactly 64 chars
      expect(() => validateToolName(maxName)).not.toThrow();
    });

    it('should reject tool names with leading/trailing whitespace', () => {
      expect(() => validateToolName(' tool')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool ')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName(' tool ')).toThrow('Tool name contains invalid characters');
    });

    it('should reject tool names with directory traversal patterns', () => {
      expect(() => validateToolName('../tool')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool/..')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('../../etc/passwd')).toThrow('Tool name contains invalid characters');
    });

    it('should reject tool names with null bytes', () => {
      expect(() => validateToolName('tool\0name')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('\0')).toThrow('Tool name contains invalid characters');
    });
  });

  describe('validateServerName', () => {
    it('should accept valid server names', () => {
      expect(() => validateServerName('my-server')).not.toThrow();
      expect(() => validateServerName('server_123')).not.toThrow();
      expect(() => validateServerName('SERVER')).not.toThrow();
      expect(() => validateServerName('s')).not.toThrow(); // Single char
    });

    it('should reject empty server names', () => {
      expect(() => validateServerName('')).toThrow('Server name cannot be empty');
    });

    it('should reject server names with invalid characters', () => {
      expect(() => validateServerName('server/../etc')).toThrow('Server name contains invalid characters');
      expect(() => validateServerName('server;rm')).toThrow('Server name contains invalid characters');
      expect(() => validateServerName('server$(cmd)')).toThrow('Server name contains invalid characters');
    });

    it('should reject server names exceeding max length', () => {
      const longName = 'a'.repeat(65);
      expect(() => validateServerName(longName)).toThrow('Server name exceeds maximum length of 64 characters');
    });

    it('should accept server names at max length boundary', () => {
      const maxName = 'a'.repeat(64);
      expect(() => validateServerName(maxName)).not.toThrow();
    });
  });

  describe('createSafeToolName', () => {
    it('should create valid namespaced tool names with new format', () => {
      const result = createSafeToolName('my-server', 'read-file');
      expect(result).toBe('mcp:my-server:read-file');
    });

    it('should throw on invalid server name', () => {
      expect(() => createSafeToolName('server/../etc', 'tool')).toThrow('Server name contains invalid characters');
    });

    it('should throw on invalid tool name', () => {
      expect(() => createSafeToolName('server', 'tool;rm')).toThrow('Tool name contains invalid characters');
    });

    it('should handle edge cases', () => {
      // Single character names
      expect(createSafeToolName('s', 't')).toBe('mcp:s:t');

      // Max length names
      const maxServer = 'a'.repeat(64);
      const maxTool = 'b'.repeat(64);
      expect(createSafeToolName(maxServer, maxTool)).toBe(`mcp:${maxServer}:${maxTool}`);
    });

    it('should prevent injection via combined names', () => {
      // Ensure validation happens before concatenation
      expect(() => createSafeToolName('server', '../etc')).toThrow();
      expect(() => createSafeToolName('../etc', 'tool')).toThrow();
    });
  });

  describe('Real-world injection attack scenarios', () => {
    it('should prevent command injection via tool names', () => {
      const maliciousNames = [
        'tool`whoami`',
        'tool$(ls)',
        'tool;cat /etc/passwd',
        'tool|grep secret',
        'tool&& rm -rf /',
        'tool|| exit',
      ];

      maliciousNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent path traversal attacks', () => {
      const pathTraversalNames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        './tool/../../../secret',
        'tool/../../config',
      ];

      pathTraversalNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent SQL injection patterns', () => {
      const sqlInjectionNames = [
        "tool'; DROP TABLE users--",
        "tool' OR '1'='1",
        'tool"; DELETE FROM tools;--',
      ];

      sqlInjectionNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent XSS via tool names (stored in logs)', () => {
      const xssNames = [
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert(1)>',
        'javascript:alert(1)',
      ];

      xssNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });

    it('should prevent null byte injection', () => {
      // Null bytes can truncate strings in C-based systems
      expect(() => validateToolName('tool\x00.txt')).toThrow('Tool name contains invalid characters');
      expect(() => validateServerName('server\x00.conf')).toThrow('Server name contains invalid characters');
    });

    it('should prevent newline injection (log injection)', () => {
      const newlineNames = [
        'tool\nINFO: Admin login successful',
        'tool\r\nERROR: System compromised',
        'tool\n\nSECURITY: Fake alert',
      ];

      newlineNames.forEach(name => {
        expect(() => validateToolName(name)).toThrow('Tool name contains invalid characters');
      });
    });
  });

  describe('Edge cases and boundary conditions', () => {
    it('should handle Unicode characters correctly', () => {
      // Unicode should be rejected (not in allowlist)
      expect(() => validateToolName('tool_名前')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tool_🔧')).toThrow('Tool name contains invalid characters');
      expect(() => validateToolName('tööl')).toThrow('Tool name contains invalid characters');
    });

    it('should handle case sensitivity correctly', () => {
      // Both upper and lower case should be allowed
      expect(() => validateToolName('ToolName')).not.toThrow();
      expect(() => validateToolName('TOOLNAME')).not.toThrow();
      expect(() => validateToolName('toolname')).not.toThrow();
      expect(() => validateToolName('Tool-Name-123')).not.toThrow();
    });

    it('should reject names with only special characters', () => {
      expect(() => validateToolName('___')).not.toThrow(); // Underscores are valid
      expect(() => validateToolName('---')).not.toThrow(); // Hyphens are valid
      expect(() => validateToolName('...')).toThrow('Tool name contains invalid characters'); // Periods invalid
      expect(() => validateToolName('///')).toThrow('Tool name contains invalid characters'); // Slashes invalid
    });
  });
});
