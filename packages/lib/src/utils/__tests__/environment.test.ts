import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  isNodeEnvironment,
  isBrowserEnvironment,
  isSSREnvironment,
  getNodeProcessInfo,
  getSafeHostname,
  getEnvironmentType,
} from '../environment';

describe('environment', () => {
  // These tests run in a Node.js environment via Vitest.

  describe('isNodeEnvironment', () => {
    it('should return true when process.versions.node is defined', () => {
      // In the Vitest Node environment this is always true.
      expect(isNodeEnvironment()).toBe(true);
    });

    it('should return false when process is undefined', () => {
      const originalProcess = global.process;
      // @ts-expect-error intentional override for test
      global.process = undefined;
      expect(isNodeEnvironment()).toBe(false);
      global.process = originalProcess;
    });

    it('should return false when process.versions is defined but node property is missing', () => {
      const originalVersions = process.versions;
      Object.defineProperty(process, 'versions', {
        value: {},
        configurable: true,
        writable: true,
      });
      expect(isNodeEnvironment()).toBe(false);
      Object.defineProperty(process, 'versions', {
        value: originalVersions,
        configurable: true,
        writable: true,
      });
    });
  });

  describe('isBrowserEnvironment', () => {
    it('should return false in Node.js environment where window is not defined', () => {
      // Vitest runs in Node; window is not defined.
      expect(isBrowserEnvironment()).toBe(false);
    });

    it('should return true when both window and document are defined', () => {
      const win = {} as Window;
      const doc = {} as Document;
      // @ts-expect-error intentional override for test
      global.window = win;
      // @ts-expect-error intentional override for test
      global.document = doc;
      expect(isBrowserEnvironment()).toBe(true);
      // @ts-expect-error cleanup
      delete global.window;
      // @ts-expect-error cleanup
      delete global.document;
    });

    it('should return false when window is defined but document is not', () => {
      // @ts-expect-error intentional override for test
      global.window = {} as Window;
      expect(isBrowserEnvironment()).toBe(false);
      // @ts-expect-error cleanup
      delete global.window;
    });
  });

  describe('isSSREnvironment', () => {
    it('should return true in a Node.js context where window is not defined', () => {
      // Default Vitest env: Node, no window.
      expect(isSSREnvironment()).toBe(true);
    });

    it('should return false when both window and document are present (browser-like)', () => {
      // @ts-expect-error intentional override for test
      global.window = {} as Window;
      // @ts-expect-error intentional override for test
      global.document = {} as Document;
      expect(isSSREnvironment()).toBe(false);
      // @ts-expect-error cleanup
      delete global.window;
      // @ts-expect-error cleanup
      delete global.document;
    });

    it('should return false when process is not Node', () => {
      const originalProcess = global.process;
      // @ts-expect-error intentional override for test
      global.process = undefined;
      expect(isSSREnvironment()).toBe(false);
      global.process = originalProcess;
    });
  });

  describe('getNodeProcessInfo', () => {
    it('should return process info when in Node environment', () => {
      const info = getNodeProcessInfo();
      expect(info.pid).toBe(process.pid);
      expect(info.platform).toBe(process.platform);
      expect(info.version).toBe(process.version);
      expect(info.memoryUsage).toBeDefined();
      expect(typeof info.memoryUsage!.heapUsed).toBe('number');
    });

    it('should return undefined fields when not in Node environment', () => {
      const originalProcess = global.process;
      // @ts-expect-error intentional override for test
      global.process = undefined;
      const info = getNodeProcessInfo();
      expect(info.pid).toBeUndefined();
      expect(info.platform).toBeUndefined();
      expect(info.version).toBeUndefined();
      expect(info.memoryUsage).toBeUndefined();
      global.process = originalProcess;
    });

    it('should return undefined fields when process.memoryUsage throws', () => {
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = () => { throw new Error('not available'); };
      const info = getNodeProcessInfo();
      expect(info.pid).toBeUndefined();
      expect(info.memoryUsage).toBeUndefined();
      process.memoryUsage = originalMemoryUsage;
    });
  });

  describe('getSafeHostname', () => {
    it('should return a string hostname in Node environment', () => {
      // isBrowserEnvironment() is false here, isNodeEnvironment() is true.
      const hostname = getSafeHostname();
      expect(typeof hostname).toBe('string');
      expect(hostname.length).toBeGreaterThan(0);
    });

    it('should return "node" when os.hostname() throws in Node environment', () => {
      const os = require('os');
      const originalHostname = os.hostname;
      os.hostname = () => { throw new Error('fail'); };
      const hostname = getSafeHostname();
      expect(hostname).toBe('node');
      os.hostname = originalHostname;
    });

    it('should return window.location.hostname when in browser environment', () => {
      const mockWindow = { location: { hostname: 'example.com' } };
      // @ts-expect-error intentional override for test
      global.window = mockWindow;
      // @ts-expect-error intentional override for test
      global.document = {};
      const hostname = getSafeHostname();
      expect(hostname).toBe('example.com');
      // @ts-expect-error cleanup
      delete global.window;
      // @ts-expect-error cleanup
      delete global.document;
    });

    it('should return "browser" when window.location.hostname throws', () => {
      const mockWindow = {
        get location(): never {
          throw new Error('SecurityError');
        },
      };
      // @ts-expect-error intentional override for test
      global.window = mockWindow;
      // @ts-expect-error intentional override for test
      global.document = {};
      const hostname = getSafeHostname();
      expect(hostname).toBe('browser');
      // @ts-expect-error cleanup
      delete global.window;
      // @ts-expect-error cleanup
      delete global.document;
    });

    it('should return "unknown" when neither browser nor Node environment', () => {
      const originalProcess = global.process;
      // @ts-expect-error intentional override for test
      global.process = undefined;
      const hostname = getSafeHostname();
      expect(hostname).toBe('unknown');
      global.process = originalProcess;
    });
  });

  describe('getEnvironmentType', () => {
    it('should return "ssr" in Node.js test environment without window', () => {
      // isSSREnvironment() = true in Vitest Node env.
      expect(getEnvironmentType()).toBe('ssr');
    });

    it('should return "browser" when both window and document exist', () => {
      // @ts-expect-error intentional override for test
      global.window = {} as Window;
      // @ts-expect-error intentional override for test
      global.document = {} as Document;
      expect(getEnvironmentType()).toBe('browser');
      // @ts-expect-error cleanup
      delete global.window;
      // @ts-expect-error cleanup
      delete global.document;
    });

    it('should return "node" when in Node but window is defined without document', () => {
      // isSSREnvironment() = false (window exists), isBrowserEnvironment() = false (no document),
      // isNodeEnvironment() = true.
      // @ts-expect-error intentional override for test
      global.window = {} as Window;
      expect(getEnvironmentType()).toBe('node');
      // @ts-expect-error cleanup
      delete global.window;
    });

    it('should return "unknown" when process is not defined and no window', () => {
      const originalProcess = global.process;
      // @ts-expect-error intentional override for test
      global.process = undefined;
      expect(getEnvironmentType()).toBe('unknown');
      global.process = originalProcess;
    });
  });
});
